use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
#[cfg(not(debug_assertions))]
use tauri::{path::BaseDirectory, Manager};
use tauri::{AppHandle, Emitter};

const MODEL: &str = "gemini-3.5-transcribe-live";
const CONNECTION_PREROLL_PACKETS: usize = 100;

/// Rust's `tungstenite` (rustls) reproducibly hung waiting for
/// `setupComplete` on this exact endpoint/model, even though the identical
/// request over Google's own `google-genai` Python SDK (and the raw
/// `websockets` library) succeeded in well under a second - same key, same
/// JSON, same moment. Without a way to packet-capture in this environment,
/// chasing that TLS/framing difference further wasn't worth it: we shell out
/// to a small Python bridge (`python/live_bridge.py`) that uses the SDK
/// Google actually maintains for the Live API, and only speak a tiny
/// newline-JSON protocol with it over stdin/stdout.
#[cfg(debug_assertions)]
const BRIDGE_SCRIPT: &str = include_str!("../python/live_bridge.py");

fn python_command() -> String {
    std::env::var("VOXA_PYTHON").unwrap_or_else(|_| "python".to_string())
}

#[cfg(debug_assertions)]
fn bridge_script_path() -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join("voxa_live_bridge.py");
    std::fs::write(&path, BRIDGE_SCRIPT)
        .map_err(|error| format!("No se pudo preparar el componente de transcripción: {error}"))?;
    Ok(path)
}

fn spawn_bridge(_app: &AppHandle) -> Result<Child, String> {
    #[cfg(debug_assertions)]
    let mut command = {
        let script = bridge_script_path()?;
        let mut command = Command::new(python_command());
        command.arg(script);
        command
    };
    #[cfg(not(debug_assertions))]
    let mut command = {
        let binary = _app
            .path()
            .resolve("binaries/voxa-live-bridge.exe", BaseDirectory::Resource)
            .map_err(|error| {
                format!("No se encontró el componente de transcripción incluido: {error}")
            })?;
        Command::new(binary)
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map_err(|error| {
        format!(
            "Could not start the Python Live bridge ({}): {error}. \
             In development, install Python 3.10+ and `pip install google-genai`, or set VOXA_PYTHON.",
            python_command(),
        )
    })
}

fn write_line(stdin: &mut ChildStdin, value: &serde_json::Value) -> std::io::Result<()> {
    writeln!(stdin, "{value}")?;
    stdin.flush()
}

/// One line of output from the bridge, already classified.
enum BridgeEvent {
    Connected,
    Transcript {
        text: String,
        interim: bool,
    },
    Usage {
        input_tokens: u64,
        output_tokens: u64,
        total_tokens: u64,
    },
    Error(String),
    ProcessEnded,
}

fn parse_bridge_line(line: &str) -> Option<BridgeEvent> {
    let value: serde_json::Value = serde_json::from_str(line).ok()?;
    if value.get("status").and_then(|s| s.as_str()) == Some("connected") {
        return Some(BridgeEvent::Connected);
    }
    if let Some(error) = value.get("error").and_then(|e| e.as_str()) {
        return Some(BridgeEvent::Error(error.to_string()));
    }
    if let Some(text) = value.get("transcript").and_then(|t| t.as_str()) {
        let interim = value
            .get("interim")
            .and_then(|i| i.as_bool())
            .unwrap_or(false);
        return Some(BridgeEvent::Transcript {
            text: text.to_string(),
            interim,
        });
    }
    if let Some(usage) = value.get("usage") {
        return Some(BridgeEvent::Usage {
            input_tokens: usage
                .get("input_tokens")
                .and_then(|item| item.as_u64())
                .unwrap_or(0),
            output_tokens: usage
                .get("output_tokens")
                .and_then(|item| item.as_u64())
                .unwrap_or(0),
            total_tokens: usage
                .get("total_tokens")
                .and_then(|item| item.as_u64())
                .unwrap_or(0),
        });
    }
    None
}

/// Reads the bridge's stdout (and stderr, for uncaught Python tracebacks)
/// on dedicated threads and forwards parsed events, so the caller never
/// blocks waiting on the child process directly.
fn spawn_bridge_readers(mut child: Child) -> (Child, Receiver<BridgeEvent>) {
    let (tx, rx) = mpsc::channel();

    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if let Some(event) = parse_bridge_line(&line) {
                    if tx.send(event).is_err() {
                        return;
                    }
                }
            }
            let _ = tx.send(BridgeEvent::ProcessEnded);
        });
    }
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            // Buffer the whole stream (typically a Python traceback) instead
            // of sending one event per line - otherwise the caller only ever
            // sees the first line ("Traceback (most recent call last):")
            // instead of the actual exception message at the end.
            let reader = BufReader::new(stderr);
            let mut buffer = String::new();
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                if !buffer.is_empty() {
                    buffer.push_str(" | ");
                }
                buffer.push_str(&line);
            }
            if !buffer.is_empty() {
                let _ = tx.send(BridgeEvent::Error(format!(
                    "Transcripción en vivo: {buffer}"
                )));
            }
        });
    }
    (child, rx)
}

#[derive(Clone)]
pub struct LiveHub {
    me: Sender<LivePacket>,
    them: Sender<LivePacket>,
    stop: Arc<AtomicBool>,
}

#[derive(Debug)]
pub enum LivePacket {
    Audio(Vec<u8>),
    AudioStreamEnd,
}

impl LiveHub {
    pub fn start(app: AppHandle, api_key: String, vocabulary: Vec<String>) -> Self {
        let (me, me_rx) = mpsc::channel();
        let (them, them_rx) = mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        spawn_transcriber(
            "ME",
            app.clone(),
            api_key.clone(),
            vocabulary.clone(),
            me_rx,
            Arc::clone(&stop),
        );
        spawn_transcriber("THEM", app, api_key, vocabulary, them_rx, Arc::clone(&stop));
        Self { me, them, stop }
    }
    pub fn push(&self, speaker: &str, pcm: Vec<u8>, ended: bool) {
        let sender = if speaker == "ME" {
            &self.me
        } else {
            &self.them
        };
        let _ = sender.send(LivePacket::Audio(pcm));
        if ended {
            let _ = sender.send(LivePacket::AudioStreamEnd);
        }
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

fn spawn_transcriber(
    speaker: &'static str,
    app: AppHandle,
    api_key: String,
    vocabulary: Vec<String>,
    rx: Receiver<LivePacket>,
    stop: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let mut retry_delay = Duration::from_secs(1);
        let mut accumulated_input = 0_u64;
        let mut accumulated_output = 0_u64;
        while !stop.load(Ordering::Relaxed) {
            let _ = app.emit(
                "transcription-status",
                json!({"speaker":speaker,"state":"connecting"}),
            );

            let child = match spawn_bridge(&app) {
                Ok(child) => child,
                Err(error) => {
                    let _ = app.emit(
                        "transcription-error",
                        json!({"speaker":speaker,"error":error}),
                    );
                    sleep_before_retry(&stop, retry_delay);
                    retry_delay = next_retry_delay(retry_delay);
                    continue;
                }
            };
            let (mut child, events) = spawn_bridge_readers(child);
            let Some(mut stdin) = child.stdin.take() else {
                let _ = child.kill();
                sleep_before_retry(&stop, retry_delay);
                retry_delay = next_retry_delay(retry_delay);
                continue;
            };

            let init = json!({"api_key": api_key, "model": MODEL, "vocabulary": vocabulary});
            if write_line(&mut stdin, &init).is_err() {
                let _ = child.kill();
                sleep_before_retry(&stop, retry_delay);
                retry_delay = next_retry_delay(retry_delay);
                continue;
            }

            // Google may take longer to allocate a Live session under load;
            // 30s avoids false failures / reconnect storms from a short deadline.
            match wait_for_connected(&events, Instant::now() + Duration::from_secs(30)) {
                Ok(()) => {}
                Err(error) => {
                    let _ = app.emit(
                        "transcription-error",
                        json!({"speaker":speaker,"error":error}),
                    );
                    let _ = child.kill();
                    sleep_before_retry(&stop, retry_delay);
                    retry_delay = next_retry_delay(retry_delay);
                    continue;
                }
            }

            retry_delay = Duration::from_secs(1);
            // Preserve a bounded tail captured while Gemini was connecting.
            // Dropping the entire backlog lost questions spoken immediately
            // after the user entered Live mode. Ten seconds is only ~320 KB.
            let mut preroll = VecDeque::with_capacity(CONNECTION_PREROLL_PACKETS);
            while let Ok(packet) = rx.try_recv() {
                if preroll.len() == CONNECTION_PREROLL_PACKETS {
                    preroll.pop_front();
                }
                preroll.push_back(packet);
            }
            let _ = app.emit(
                "transcription-status",
                json!({"speaker":speaker,"state":"connected"}),
            );

            let mut preroll_failed = false;
            for packet in preroll {
                let message = match packet {
                    LivePacket::Audio(pcm) => json!({"audio": STANDARD.encode(pcm)}),
                    LivePacket::AudioStreamEnd => json!({"end": true}),
                };
                if write_line(&mut stdin, &message).is_err() {
                    preroll_failed = true;
                    break;
                }
            }
            if preroll_failed {
                let _ = child.kill();
                continue;
            }

            let connected_at = Instant::now();
            let mut session_input = 0_u64;
            let mut session_output = 0_u64;
            let mut graceful_rotation_deadline: Option<Instant> = None;
            'session: loop {
                if stop.load(Ordering::Relaxed)
                    || connected_at.elapsed() > Duration::from_secs(9 * 60 + 30)
                    || graceful_rotation_deadline.is_some_and(|deadline| Instant::now() >= deadline)
                {
                    let _ = child.kill();
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(40)) {
                    Ok(packet) => {
                        let is_turn_end = matches!(&packet, LivePacket::AudioStreamEnd);
                        let message = match packet {
                            LivePacket::Audio(pcm) => json!({"audio": STANDARD.encode(pcm)}),
                            LivePacket::AudioStreamEnd => json!({"end": true}),
                        };
                        if write_line(&mut stdin, &message).is_err() {
                            let _ = child.kill();
                            break;
                        }
                        if is_turn_end
                            && connected_at.elapsed() > Duration::from_secs(8 * 60)
                            && graceful_rotation_deadline.is_none()
                        {
                            // Rotate at a natural silence boundary, then allow
                            // the final transcript enough time to arrive.
                            graceful_rotation_deadline =
                                Some(Instant::now() + Duration::from_secs(5));
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(_) => {
                        let _ = child.kill();
                        return;
                    }
                }
                while let Ok(event) = events.try_recv() {
                    match event {
                        BridgeEvent::Transcript { text, interim } => {
                            let _ = app.emit(
                                "transcript",
                                json!({"speaker":speaker,"text":text,"interim":interim}),
                            );
                            if !interim && graceful_rotation_deadline.is_some() {
                                let _ = child.kill();
                                break 'session;
                            }
                        }
                        BridgeEvent::Usage {
                            input_tokens,
                            output_tokens,
                            total_tokens,
                        } => {
                            accumulated_input += input_tokens.saturating_sub(session_input);
                            accumulated_output += output_tokens.saturating_sub(session_output);
                            session_input = input_tokens;
                            session_output = output_tokens;
                            let _ = app.emit(
                                "usage-update",
                                json!({
                                    "speaker": speaker,
                                    "inputTokens": accumulated_input,
                                    "outputTokens": accumulated_output,
                                    "totalTokens": total_tokens
                                }),
                            );
                        }
                        BridgeEvent::Error(error) => {
                            let _ = app.emit(
                                "transcription-error",
                                json!({"speaker":speaker,"error":error}),
                            );
                        }
                        BridgeEvent::ProcessEnded => {
                            let _ = child.kill();
                            break 'session;
                        }
                        BridgeEvent::Connected => {}
                    }
                }
            }
        }
    });
}

fn wait_for_connected(events: &Receiver<BridgeEvent>, deadline: Instant) -> Result<(), String> {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("Gemini no confirmó la sesión en vivo dentro del tiempo esperado".into());
        }
        match events.recv_timeout(remaining.min(Duration::from_millis(200))) {
            Ok(BridgeEvent::Connected) => return Ok(()),
            Ok(BridgeEvent::Error(error)) => return Err(error),
            Ok(BridgeEvent::ProcessEnded) => {
                return Err(
                    "El componente de transcripción terminó antes de confirmar la sesión".into(),
                )
            }
            Ok(BridgeEvent::Transcript { .. }) => {}
            Ok(BridgeEvent::Usage { .. }) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(
                    "El componente de transcripción terminó antes de confirmar la sesión".into(),
                )
            }
        }
    }
}

/// Opens a real Live session through the same bridge the transcriber uses,
/// and waits for the "connected" confirmation (or a Gemini error) before
/// killing it. Used by the health check to verify the Live path end-to-end
/// without spawning a background transcriber thread.
pub fn health_check(app: &AppHandle, api_key: &str) -> Result<(), String> {
    let child = spawn_bridge(app)?;
    let (mut child, events) = spawn_bridge_readers(child);
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        return Err("No se pudo abrir la entrada del componente de transcripción".into());
    };
    let init = json!({"api_key": api_key, "model": MODEL, "vocabulary": Vec::<String>::new()});
    if let Err(error) = write_line(&mut stdin, &init) {
        let _ = child.kill();
        return Err(format!("No se pudo iniciar la transcripción: {error}"));
    }
    let result = wait_for_connected(&events, Instant::now() + Duration::from_secs(25));
    let _ = child.kill();
    result
}

fn next_retry_delay(current: Duration) -> Duration {
    (current * 2).min(Duration::from_secs(30))
}

fn sleep_before_retry(stop: &AtomicBool, delay: Duration) {
    let started = Instant::now();
    while !stop.load(Ordering::Relaxed) && started.elapsed() < delay {
        thread::sleep(Duration::from_millis(100));
    }
}
