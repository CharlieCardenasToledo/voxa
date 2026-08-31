use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::{
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
use tauri::{AppHandle, Emitter};

const MODEL: &str = "gemini-3.5-transcribe-live";

/// Rust's `tungstenite` (rustls) reproducibly hung waiting for
/// `setupComplete` on this exact endpoint/model, even though the identical
/// request over Google's own `google-genai` Python SDK (and the raw
/// `websockets` library) succeeded in well under a second - same key, same
/// JSON, same moment. Without a way to packet-capture in this environment,
/// chasing that TLS/framing difference further wasn't worth it: we shell out
/// to a small Python bridge (`python/live_bridge.py`) that uses the SDK
/// Google actually maintains for the Live API, and only speak a tiny
/// newline-JSON protocol with it over stdin/stdout.
const BRIDGE_SCRIPT: &str = include_str!("../python/live_bridge.py");

fn python_command() -> String {
    std::env::var("VOXA_PYTHON").unwrap_or_else(|_| "python".to_string())
}

fn bridge_script_path() -> Result<std::path::PathBuf, String> {
    let path = std::env::temp_dir().join("voxa_live_bridge.py");
    std::fs::write(&path, BRIDGE_SCRIPT)
        .map_err(|error| format!("Could not write the Live bridge script: {error}"))?;
    Ok(path)
}

fn spawn_bridge() -> Result<Child, String> {
    let script = bridge_script_path()?;
    let mut command = Command::new(python_command());
    command
        .arg(&script)
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
             Install Python 3.10+ and `pip install google-genai`, or set VOXA_PYTHON.",
            python_command()
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
    Transcript { text: String, interim: bool },
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
                let _ = tx.send(BridgeEvent::Error(format!("Live bridge: {buffer}")));
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
        while !stop.load(Ordering::Relaxed) {
            // Audio captured before a connection is ready is stale. Sending the
            // backlog in a burst can immediately trigger Gemini rate limits.
            while rx.try_recv().is_ok() {}

            let child = match spawn_bridge() {
                Ok(child) => child,
                Err(error) => {
                    let _ = app.emit("transcription-error", json!({"speaker":speaker,"error":error}));
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
                    let _ = app.emit("transcription-error", json!({"speaker":speaker,"error":error}));
                    let _ = child.kill();
                    sleep_before_retry(&stop, retry_delay);
                    retry_delay = next_retry_delay(retry_delay);
                    continue;
                }
            }

            retry_delay = Duration::from_secs(1);
            // Drop chunks collected while Gemini was allocating the session;
            // transcription should start from "connected".
            while rx.try_recv().is_ok() {}
            let _ = app.emit(
                "transcription-status",
                json!({"speaker":speaker,"state":"connected"}),
            );

            let connected_at = Instant::now();
            'session: loop {
                if stop.load(Ordering::Relaxed) || connected_at.elapsed() > Duration::from_secs(8 * 60)
                {
                    let _ = child.kill();
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(40)) {
                    Ok(packet) => {
                        let message = match packet {
                            LivePacket::Audio(pcm) => json!({"audio": STANDARD.encode(pcm)}),
                            LivePacket::AudioStreamEnd => json!({"end": true}),
                        };
                        if write_line(&mut stdin, &message).is_err() {
                            let _ = child.kill();
                            break;
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
                        }
                        BridgeEvent::Error(error) => {
                            let _ = app
                                .emit("transcription-error", json!({"speaker":speaker,"error":error}));
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
            return Err("Gemini did not confirm the Live session before the timeout".into());
        }
        match events.recv_timeout(remaining.min(Duration::from_millis(200))) {
            Ok(BridgeEvent::Connected) => return Ok(()),
            Ok(BridgeEvent::Error(error)) => return Err(error),
            Ok(BridgeEvent::ProcessEnded) => {
                return Err("The Live bridge exited before confirming the session".into())
            }
            Ok(BridgeEvent::Transcript { .. }) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("The Live bridge exited before confirming the session".into())
            }
        }
    }
}

/// Opens a real Live session through the same bridge the transcriber uses,
/// and waits for the "connected" confirmation (or a Gemini error) before
/// killing it. Used by the health check to verify the Live path end-to-end
/// without spawning a background transcriber thread.
pub fn health_check(api_key: &str) -> Result<(), String> {
    let child = spawn_bridge()?;
    let (mut child, events) = spawn_bridge_readers(child);
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        return Err("Could not open the Live bridge's stdin".into());
    };
    let init = json!({"api_key": api_key, "model": MODEL, "vocabulary": Vec::<String>::new()});
    if let Err(error) = write_line(&mut stdin, &init) {
        let _ = child.kill();
        return Err(format!("Could not send the init message: {error}"));
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
