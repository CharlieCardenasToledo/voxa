use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;
use std::{
    io::ErrorKind,
    net::{SocketAddr, TcpStream, ToSocketAddrs},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tungstenite::{client::IntoClientRequest, client_tls, stream::MaybeTlsStream, Message, WebSocket};

const MODEL: &str = "gemini-3.5-transcribe-live";
const HOST: &str = "generativelanguage.googleapis.com";
const ENDPOINT: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/// `tungstenite::connect` resolves the host and tries every address with an
/// unbounded `TcpStream::connect`, in whatever order the OS returns them. On
/// networks with a broken/unreachable IPv6 route (common on home Wi-Fi and
/// some VPNs) that means it can hang for 10-20s on a dead IPv6 address before
/// ever trying IPv4 - even though plain HTTPS (via reqwest, which races
/// IPv4/IPv6) connects instantly. Resolving ourselves and trying IPv4
/// addresses first, each bounded by a short timeout, sidesteps that.
fn connect_preferring_ipv4(
    url: &str,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>, String> {
    let mut addrs: Vec<SocketAddr> = (HOST, 443_u16)
        .to_socket_addrs()
        .map_err(|error| format!("Could not resolve {HOST}: {error}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("DNS returned no addresses for {HOST}"));
    }
    addrs.sort_by_key(|addr| !addr.is_ipv4());

    let mut last_error = String::new();
    for addr in &addrs {
        match TcpStream::connect_timeout(addr, Duration::from_secs(5)) {
            Ok(stream) => {
                let request = url
                    .into_client_request()
                    .map_err(|error| format!("Invalid Live URL: {error}"))?;
                let (socket, _) = client_tls(request, stream)
                    .map_err(|error| format!("Gemini Live handshake failed: {error}"))?;
                return Ok(socket);
            }
            Err(error) => last_error = format!("{addr}: {error}"),
        }
    }
    Err(format!("Could not reach {HOST} on any resolved address ({last_error})"))
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
            let url = format!("{ENDPOINT}?key={api_key}");
            match connect_preferring_ipv4(&url) {
                Ok(mut socket) => {
                    let connected_at = Instant::now();
                    let setup = json!({"setup":{"model":format!("models/{MODEL}"),"generationConfig":{"responseModalities":["TEXT"]},"inputAudioTranscription":{"languageCodes":[],"mode":"SMART","customVocabulary":vocabulary}}});
                    if socket
                        .send(Message::Text(setup.to_string().into()))
                        .is_err()
                    {
                        sleep_before_retry(&stop, retry_delay);
                        retry_delay = next_retry_delay(retry_delay);
                        continue;
                    }
                    // Google may take longer to allocate a Live session under
                    // load. Eight seconds caused false failures and reconnect
                    // storms, which then surfaced as 429/500 errors. Poll on a
                    // short read timeout so a slow-but-alive session doesn't
                    // trip a single fixed deadline early.
                    set_read_timeout(&mut socket, Duration::from_millis(200));
                    if let Err(error) =
                        wait_for_setup(&mut socket, Instant::now() + Duration::from_secs(30))
                    {
                        let _ = app.emit(
                            "transcription-error",
                            json!({"speaker":speaker,"error":error}),
                        );
                        sleep_before_retry(&stop, retry_delay);
                        retry_delay = next_retry_delay(retry_delay);
                        continue;
                    }
                    retry_delay = Duration::from_secs(1);
                    // Drop chunks collected while Gemini was allocating the
                    // session; transcription should start from "connected".
                    while rx.try_recv().is_ok() {}
                    let _ = app.emit(
                        "transcription-status",
                        json!({"speaker":speaker,"state":"connected"}),
                    );
                    set_read_timeout(&mut socket, Duration::from_millis(3));
                    loop {
                        if stop.load(Ordering::Relaxed)
                            || connected_at.elapsed() > Duration::from_secs(8 * 60)
                        {
                            let _ = socket.close(None);
                            break;
                        }
                        match rx.recv_timeout(Duration::from_millis(40)) {
                            Ok(packet) => {
                                let message = match packet {
                                    LivePacket::Audio(pcm) => {
                                        json!({"realtimeInput":{"audio":{"data":STANDARD.encode(pcm),"mimeType":"audio/pcm;rate=16000"}}})
                                    }
                                    LivePacket::AudioStreamEnd => {
                                        json!({"realtimeInput":{"audioStreamEnd":true}})
                                    }
                                };
                                if socket
                                    .send(Message::Text(message.to_string().into()))
                                    .is_err()
                                {
                                    break;
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Timeout) => {}
                            Err(_) => return,
                        }
                        if !drain_messages(&mut socket, &app, speaker) {
                            break;
                        }
                    }
                }
                Err(error) => {
                    let _ = app.emit(
                        "transcription-error",
                        json!({"speaker":speaker,"error":error}),
                    );
                    sleep_before_retry(&stop, retry_delay);
                    retry_delay = next_retry_delay(retry_delay);
                }
            }
        }
    });
}

/// Opens a real Live session, sends the same setup message the transcriber
/// uses, and waits for `setupComplete` (or a Gemini error) before closing.
/// Used by the health check to verify the WebSocket path end-to-end without
/// spawning a background transcriber thread.
pub fn health_check(api_key: &str) -> Result<(), String> {
    let url = format!("{ENDPOINT}?key={api_key}");
    let mut socket = connect_preferring_ipv4(&url)?;
    let setup = json!({"setup":{"model":format!("models/{MODEL}"),"generationConfig":{"responseModalities":["TEXT"]},"inputAudioTranscription":{"languageCodes":[],"mode":"SMART","customVocabulary":[]}}});
    socket
        .send(Message::Text(setup.to_string().into()))
        .map_err(|error| format!("Could not send the setup message: {error}"))?;
    set_read_timeout(&mut socket, Duration::from_millis(200));
    let result = wait_for_setup(&mut socket, Instant::now() + Duration::from_secs(25));
    let _ = socket.close(None);
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

/// A single blocking `read()` only waits for the socket's read timeout, and a
/// slow-but-healthy Gemini session (e.g. while it is allocating capacity
/// under load) will trip that timeout before sending `setupComplete`. Treat
/// that as "keep waiting" rather than a hard failure, up to `deadline` -
/// otherwise a socket timeout shorter than Gemini's setup latency reads as a
/// connection error when the connection is actually fine.
fn wait_for_setup(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    deadline: Instant,
) -> Result<(), String> {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                let value: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|error| format!("Invalid Gemini setup response: {error}"))?;
                if let Some(error) = gemini_error(&value) {
                    return Err(error);
                }
                if value.get("setupComplete").is_some() || value.get("setup_complete").is_some() {
                    return Ok(());
                }
            }
            Ok(Message::Close(frame)) => {
                return Err(format!(
                    "Gemini closed the connection during setup{}",
                    frame
                        .map(|item| format!(": {}", item.reason))
                        .unwrap_or_default()
                ));
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                if Instant::now() >= deadline {
                    return Err(
                        "Gemini did not confirm the Live session before the timeout".into(),
                    );
                }
            }
            Err(error) => return Err(format!("Gemini setup failed: {error}")),
        }
    }
}

fn set_read_timeout(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>, timeout: Duration) {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(Some(timeout));
        }
        MaybeTlsStream::Rustls(stream) => {
            let _ = stream.sock.set_read_timeout(Some(timeout));
        }
        _ => {}
    }
}

fn drain_messages(
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    app: &AppHandle,
    speaker: &str,
) -> bool {
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(error) = gemini_error(&value) {
                        let _ = app.emit(
                            "transcription-error",
                            json!({"speaker":speaker,"error":error}),
                        );
                        return false;
                    }
                }
                emit_transcript(app, speaker, &text)
            }
            Ok(Message::Close(frame)) => {
                let reason = frame
                    .map(|item| item.reason.to_string())
                    .filter(|item| !item.is_empty())
                    .unwrap_or_else(|| "Gemini closed the transcription connection".into());
                let _ = app.emit(
                    "transcription-error",
                    json!({"speaker":speaker,"error":reason}),
                );
                return false;
            }
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                return true
            }
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return false
            }
            Err(error) => {
                let _ = app.emit(
                    "transcription-error",
                    json!({"speaker":speaker,"error":error.to_string()}),
                );
                return false;
            }
        }
    }
}

fn gemini_error(value: &serde_json::Value) -> Option<String> {
    let error = value.get("error")?;
    Some(
        error
            .get("message")
            .and_then(|message| message.as_str())
            .unwrap_or("Gemini returned an unknown transcription error")
            .to_string(),
    )
}

fn emit_transcript(app: &AppHandle, speaker: &str, raw: &str) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return;
    };
    let Some(content) = value
        .get("serverContent")
        .or_else(|| value.get("server_content"))
    else {
        return;
    };
    for (field, interim) in [
        ("interimInputTranscription", true),
        ("interim_input_transcription", true),
        ("inputTranscription", false),
        ("input_transcription", false),
    ] {
        if let Some(text) = content
            .get(field)
            .and_then(|item| item.get("text"))
            .and_then(|text| text.as_str())
        {
            let _ = app.emit(
                "transcript",
                json!({"speaker":speaker,"text":text,"interim":interim}),
            );
            break;
        }
    }
}
