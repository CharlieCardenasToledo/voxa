#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{fs, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};
mod audio;
mod capture;
mod document;
mod health;
mod live;

struct RuntimeState {
    capture_stop: std::sync::Mutex<Option<capture::CaptureStop>>,
    live_hub: std::sync::Mutex<Option<live::LiveHub>>,
    interaction_id: std::sync::Mutex<Option<String>>,
    knowledge_context: std::sync::Mutex<Option<String>>,
    vocabulary_context: std::sync::Mutex<Vec<String>>,
}

const KEYRING_SERVICE: &str = "voxa-presentation-copilot";
const GEMINI_MODEL: &str = "gemini-3.7-flash";

#[derive(Debug, Deserialize, Serialize)]
struct SessionRecord {
    id: String,
    title: String,
    role: String,
    audience: String,
    level: String,
    important_facts: String,
    forbidden_claims: String,
    context: String,
}

#[derive(Debug, Deserialize)]
struct CopilotRequest {
    question: String,
    knowledge: String,
    conversation: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct CopilotAnswer {
    question_en: String,
    question_es: String,
    answer_b2: String,
    extension_b2: String,
    key_idea_es: String,
    confidence: String,
    warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioDevices {
    microphone: bool,
    loopback: bool,
    internet: bool,
    api_configured: bool,
}

#[tauri::command]
fn check_system() -> AudioDevices {
    let devices = capture::default_status();
    AudioDevices {
        microphone: devices.microphone,
        loopback: devices.loopback,
        internet: true,
        api_configured: has_gemini_api_key(),
    }
}

#[tauri::command]
fn prepare_session(title: String) -> Result<String, String> {
    if title.trim().is_empty() {
        return Err("Session title is required".into());
    }
    Ok(format!(
        "session-{}",
        title.trim().to_lowercase().replace(' ', "-")
    ))
}

#[tauri::command]
fn extract_document(
    file_name: String,
    bytes: Vec<u8>,
    state: State<'_, RuntimeState>,
) -> Result<document::DocumentContext, String> {
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Presentation exceeds the 25 MB limit".into());
    }
    let context = document::extract(&file_name, &bytes)?;
    *state
        .knowledge_context
        .lock()
        .map_err(|_| "Document state is unavailable".to_string())? = Some(context.text.clone());
    *state
        .vocabulary_context
        .lock()
        .map_err(|_| "Document state is unavailable".to_string())? = context.vocabulary.clone();
    Ok(context)
}

#[tauri::command]
fn start_live_session(session_id: String) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("A prepared session is required".into());
    }
    Ok(())
}

#[tauri::command]
fn stop_live_session() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn start_audio_capture(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<capture::CaptureStatus, String> {
    let mut slot = state
        .capture_stop
        .lock()
        .map_err(|_| "Audio state is unavailable".to_string())?;
    if slot.is_some() {
        let devices = capture::default_status();
        return Ok(capture::CaptureStatus {
            running: true,
            ..devices
        });
    }
    let handle = app.clone();
    let vocabulary = state
        .vocabulary_context
        .lock()
        .map_err(|_| "Document state is unavailable".to_string())?
        .clone();
    let hub = match gemini_key() {
        Ok(key) => match validate_gemini_key_value(&key) {
            Ok(()) => Some(live::LiveHub::start(app.clone(), key, vocabulary)),
            Err(error) => {
                for speaker in ["ME", "THEM"] {
                    let _ = app.emit(
                        "transcription-error",
                        serde_json::json!({"speaker":speaker,"error":error}),
                    );
                }
                None
            }
        },
        Err(_) => None,
    };
    let hub_for_callback = hub.clone();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(String, String), String>>();
    std::thread::spawn(move || {
        let engine = capture::AudioCapture::start(move |speaker, pcm, ended| {
            if let Some(hub) = &hub_for_callback {
                hub.push(speaker, pcm.clone(), ended);
            }
            let (rms, peak) = audio_level(&pcm);
            let _ = handle.emit("audio-level", serde_json::json!({"speaker": speaker, "rms": rms, "peak": peak, "active": rms >= 0.012}));
        });
        match engine {
            Ok(engine) => {
                let names = engine.device_names();
                let _ = ready_tx.send(Ok(names));
                let _ = stop_rx.recv();
                drop(engine);
            }
            Err(error) => {
                let _ = ready_tx.send(Err(error));
            }
        }
    });
    match ready_rx
        .recv_timeout(std::time::Duration::from_secs(3))
        .map_err(|_| "Audio capture did not start in time".to_string())?
    {
        Ok((microphone_name, loopback_name)) => {
            *slot = Some(stop_tx);
            *state
                .live_hub
                .lock()
                .map_err(|_| "Audio state is unavailable".to_string())? = hub;
            Ok(capture::CaptureStatus {
                microphone: true,
                loopback: true,
                running: true,
                error: None,
                microphone_name: Some(microphone_name),
                loopback_name: Some(loopback_name),
            })
        }
        Err(error) => Ok(capture::CaptureStatus {
            microphone: false,
            loopback: false,
            running: false,
            error: Some(error),
            microphone_name: None,
            loopback_name: None,
        }),
    }
}

fn audio_level(pcm16: &[u8]) -> (f32, f32) {
    if pcm16.len() < 2 {
        return (0.0, 0.0);
    }
    let mut sum = 0.0_f32;
    let mut peak = 0.0_f32;
    let mut count = 0_u32;
    for bytes in pcm16.chunks_exact(2) {
        let sample = (i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / i16::MAX as f32).abs();
        sum += sample * sample;
        peak = peak.max(sample);
        count += 1;
    }
    ((sum / count as f32).sqrt(), peak)
}

#[tauri::command]
fn stop_audio_capture(state: State<'_, RuntimeState>) -> Result<(), String> {
    if let Some(stop) = state
        .capture_stop
        .lock()
        .map_err(|_| "Audio state is unavailable".to_string())?
        .take()
    {
        let _ = stop.send(());
    }
    if let Some(hub) = state
        .live_hub
        .lock()
        .map_err(|_| "Audio state is unavailable".to_string())?
        .take()
    {
        hub.stop();
    }
    Ok(())
}

fn sessions_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("sessions.json"))
}

#[tauri::command]
fn save_session(app: AppHandle, session: SessionRecord) -> Result<(), String> {
    let path = sessions_file(&app)?;
    let mut sessions: Vec<SessionRecord> = if path.exists() {
        serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    sessions.retain(|item| item.id != session.id);
    sessions.push(session);
    fs::write(
        path,
        serde_json::to_vec_pretty(&sessions).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn load_sessions(app: AppHandle) -> Result<Vec<SessionRecord>, String> {
    let path = sessions_file(&app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&fs::read_to_string(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_session(app: AppHandle, id: String) -> Result<(), String> {
    let path = sessions_file(&app)?;
    if !path.exists() {
        return Ok(());
    }
    let mut sessions: Vec<SessionRecord> =
        serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
            .unwrap_or_default();
    sessions.retain(|item| item.id != id);
    fs::write(
        path,
        serde_json::to_vec_pretty(&sessions).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_gemini_api_key(key: String) -> Result<(), String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("API key cannot be empty".into());
    }
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, "gemini_api_key").map_err(|e| e.to_string())?;
    entry
        .set_password(key)
        .map_err(|e| format!("Windows Credential Manager could not save the key: {e}"))?;
    let stored = entry
        .get_password()
        .map_err(|e| format!("The key was saved but could not be read back: {e}"))?;
    if stored.trim() != key {
        return Err("Windows Credential Manager verification failed".into());
    }
    Ok(())
}

#[tauri::command]
fn has_gemini_api_key() -> bool {
    keyring::Entry::new(KEYRING_SERVICE, "gemini_api_key")
        .ok()
        .and_then(|entry| entry.get_password().ok())
        .is_some_and(|key| !key.trim().is_empty())
        || std::env::var("GEMINI_API_KEY").is_ok_and(|key| !key.trim().is_empty())
}

fn gemini_key() -> Result<String, String> {
    if let Ok(key) = keyring::Entry::new(KEYRING_SERVICE, "gemini_api_key")
        .map_err(|e| e.to_string())
        .and_then(|entry| entry.get_password().map_err(|e| e.to_string()))
    {
        if !key.trim().is_empty() {
            return Ok(key.trim().to_string());
        }
    }
    std::env::var("GEMINI_API_KEY")
        .map(|key| key.trim().to_string())
        .map_err(|_| "Gemini API key is not configured".into())
        .and_then(|key| {
            if key.is_empty() {
                Err("Gemini API key is empty".into())
            } else {
                Ok(key)
            }
        })
}

fn validate_gemini_key_value(key: &str) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|error| format!("Could not create the Gemini client: {error}"))?
        .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1")
        .header("x-goog-api-key", key)
        .send()
        .map_err(|error| format!("Could not reach Gemini: {error}"))?;
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status();
    let body = response.text().unwrap_or_default();
    let message = serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|value| {
            value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(|message| message.as_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("Gemini rejected the credential with {status}"));
    Err(message)
}

#[tauri::command]
fn validate_gemini_api_key() -> Result<(), String> {
    validate_gemini_key_value(&gemini_key()?)
}

#[tauri::command]
fn gemini_health() -> health::GeminiHealthReport {
    health::run()
}

#[tauri::command]
fn generate_copilot_answer(
    request: CopilotRequest,
    state: State<'_, RuntimeState>,
) -> Result<CopilotAnswer, String> {
    let extracted_context = state
        .knowledge_context
        .lock()
        .map_err(|_| "Document state is unavailable".to_string())?
        .clone()
        .unwrap_or_default();
    let knowledge = if extracted_context.is_empty() {
        request.knowledge.clone()
    } else {
        format!(
            "{}\n\nEXTRACTED PRESENTATION TEXT:\n{}",
            request.knowledge, extracted_context
        )
    };
    let prompt = format!(
        r#"You are a live presentation copilot for an English-speaking technical audience.
The presenter speaks at CEFR B2 level. Return only valid JSON matching the requested fields.
Never invent facts. If the exact answer is not in the knowledge or conversation, say so safely and set confidence to LOW.
Use short, natural spoken English. answer_b2 must be 1-3 sentences and no more than 45 words.

KNOWLEDGE:
{knowledge}

RECENT CONVERSATION:
{conversation}

QUESTION:
    {question}"#,
        knowledge = knowledge,
        conversation = request.conversation,
        question = request.question
    );
    let previous_interaction_id = state
        .interaction_id
        .lock()
        .map_err(|_| "Conversation state is unavailable".to_string())?
        .clone();
    let mut body = serde_json::json!({
        "model": GEMINI_MODEL,
        "input": prompt,
        "response_format": { "type": "text", "mime_type": "application/json", "schema": {
            "type": "object", "properties": {
                "question_en": {"type":"string"}, "question_es": {"type":"string"}, "answer_b2": {"type":"string"},
                "extension_b2": {"type":"string"}, "key_idea_es": {"type":"string"},
                "confidence": {"type":"string", "enum":["HIGH","MEDIUM","LOW"]}, "warning": {"type":["string","null"]}
            }, "required":["question_en","question_es","answer_b2","extension_b2","key_idea_es","confidence","warning"]
        }}
    });
    if let Some(previous) = previous_interaction_id {
        body["previous_interaction_id"] = serde_json::Value::String(previous);
    }
    let key = gemini_key()?;
    let client = reqwest::blocking::Client::new();
    // Google's own SDKs retry 429/5xx with backoff by default because model
    // overload ("high demand") is common and self-resolves in a few seconds;
    // a live copilot answer is worth a couple of retries before giving up.
    let mut retry_delay = Duration::from_millis(800);
    let value: serde_json::Value = loop {
        let response = client
            .post("https://generativelanguage.googleapis.com/v1beta/interactions")
            .header("x-goog-api-key", &key)
            .json(&body)
            .send()
            .map_err(|e| format!("Gemini request failed: {e}"))?;
        let status = response.status();
        if status.is_success() {
            break response
                .json()
                .map_err(|e| format!("Invalid Gemini response: {e}"))?;
        }
        let is_retryable = status.as_u16() == 429 || status.is_server_error();
        let body_text = response.text().unwrap_or_default();
        let message = serde_json::from_str::<serde_json::Value>(&body_text)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(|error| error.get("message"))
                    .and_then(|message| message.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("Gemini returned {status}"));
        if !is_retryable || retry_delay > Duration::from_secs(5) {
            return Err(message);
        }
        std::thread::sleep(retry_delay);
        retry_delay *= 2;
    };
    let text = value["steps"]
        .as_array()
        .and_then(|steps| {
            steps.iter().rev().find_map(|step| {
                step["content"]
                    .as_array()
                    .and_then(|content| content.iter().find_map(|item| item["text"].as_str()))
            })
        })
        .ok_or("Gemini response did not contain output text")?;
    let answer = serde_json::from_str(text)
        .map_err(|e| format!("Gemini output did not match schema: {e}"))?;
    if let Some(id) = value
        .get("id")
        .or_else(|| value.get("interaction_id"))
        .and_then(|item| item.as_str())
    {
        *state
            .interaction_id
            .lock()
            .map_err(|_| "Conversation state is unavailable".to_string())? = Some(id.to_string());
    }
    Ok(answer)
}

pub fn run() {
    let runtime = RuntimeState {
        capture_stop: std::sync::Mutex::new(None),
        live_hub: std::sync::Mutex::new(None),
        interaction_id: std::sync::Mutex::new(None),
        knowledge_context: std::sync::Mutex::new(None),
        vocabulary_context: std::sync::Mutex::new(Vec::new()),
    };
    tauri::Builder::default()
        .manage(runtime)
        .invoke_handler(tauri::generate_handler![
            check_system,
            prepare_session,
            extract_document,
            start_live_session,
            stop_live_session,
            start_audio_capture,
            stop_audio_capture,
            save_session,
            load_sessions,
            delete_session,
            set_gemini_api_key,
            has_gemini_api_key,
            validate_gemini_api_key,
            gemini_health,
            generate_copilot_answer
        ])
        .run(tauri::generate_context!())
        .expect("error while running Voxa");
}
