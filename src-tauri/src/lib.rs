#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::{fs, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};
mod audio;
mod capture;
mod document;
mod health;
mod live;

struct RuntimeState {
    capture_stop: std::sync::Mutex<Option<capture::CaptureControl>>,
    live_hub: std::sync::Mutex<Option<live::LiveHub>>,
    interaction_id: std::sync::Mutex<Option<String>>,
    knowledge_context: std::sync::Mutex<Option<String>>,
    session_context: std::sync::Mutex<Option<String>>,
    vocabulary_context: std::sync::Mutex<Vec<String>>,
}

const KEYRING_SERVICE: &str = "voxa-presentation-copilot";
const GEMINI_MODEL: &str = "gemini-3.7-flash";
// A 503 "high demand" means Google's shared capacity for that specific model
// is temporarily saturated - unrelated to billing tier or quota, and not
// something retries alone reliably fix. Falling back to another model keeps
// the presenter's copilot answering instead of failing outright.
const GEMINI_FALLBACK_MODELS: &[&str] = &["gemini-2.5-flash"];

#[derive(Debug, Deserialize, Serialize, Clone)]
struct SessionRecord {
    id: String,
    title: String,
    role: String,
    audience: String,
    level: String,
    important_facts: String,
    forbidden_claims: String,
    context: String,
    #[serde(default)]
    response_length: String,
    #[serde(default)]
    vocabulary: Vec<String>,
    #[serde(default)]
    questions: Vec<PracticeQuestion>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrepareRequest {
    title: String,
    role: String,
    audience: String,
    level: String,
    response_length: String,
    important_facts: String,
    forbidden_claims: String,
    context: String,
    vocabulary: String,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PracticeQuestion {
    question: String,
    answer: String,
}

#[derive(Debug, Deserialize)]
struct PracticeResponse {
    questions: Vec<PracticeQuestion>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedSession {
    id: String,
    questions: Vec<PracticeQuestion>,
}

#[derive(Debug, Deserialize)]
struct DocumentOcrResponse {
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscriptAnalysisRequest {
    text: String,
    speaker: String,
    conversation: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct TranscriptAnalysis {
    source_language: String,
    target_language: String,
    translation: String,
    intent: String,
    normalized_question: Option<String>,
    complete: bool,
    #[serde(default)]
    model_used: String,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    thought_tokens: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerVariantRequest {
    kind: String,
    question: String,
    current_answer: String,
    conversation: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct AnswerVariant {
    answer: String,
    #[serde(default)]
    model_used: String,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    thought_tokens: u64,
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
    #[serde(default)]
    model_used: String,
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    thought_tokens: u64,
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
fn prepare_session(
    app: AppHandle,
    request: PrepareRequest,
    state: State<'_, RuntimeState>,
) -> Result<PreparedSession, String> {
    if request.title.trim().is_empty() {
        return Err("Debes escribir un nombre para la sesión".into());
    }
    let document = state
        .knowledge_context
        .lock()
        .map_err(|_| "Document state is unavailable".to_string())?
        .clone()
        .unwrap_or_default();
    let context = format!(
        "TITLE: {}\nPRESENTER ROLE: {}\nAUDIENCE: {}\nENGLISH LEVEL: {}\nRESPONSE LENGTH: {}\nIMPORTANT FACTS:\n{}\nFORBIDDEN CLAIMS:\n{}\nPROJECT CONTEXT:\n{}\nVOCABULARY:\n{}\nPRESENTATION:\n{}",
        request.title.trim(),
        request.role.trim(),
        request.audience.trim(),
        request.level.trim(),
        request.response_length.trim(),
        request.important_facts.trim(),
        request.forbidden_claims.trim(),
        request.context.trim(),
        request.vocabulary.trim(),
        document
    );
    *state
        .session_context
        .lock()
        .map_err(|_| "Session state is unavailable".to_string())? = Some(context.clone());
    *state
        .interaction_id
        .lock()
        .map_err(|_| "Conversation state is unavailable".to_string())? = None;

    if !request.vocabulary.trim().is_empty() {
        let mut vocabulary = state
            .vocabulary_context
            .lock()
            .map_err(|_| "Vocabulary state is unavailable".to_string())?;
        for term in request.vocabulary.split([',', '\n', ';']) {
            let term = term.trim();
            if !term.is_empty()
                && !vocabulary
                    .iter()
                    .any(|item| item.eq_ignore_ascii_case(term))
                && vocabulary.len() < 100
            {
                vocabulary.push(term.to_string());
            }
        }
    }

    let id = format!(
        "session-{}-{}",
        request
            .title
            .trim()
            .to_lowercase()
            .replace(|character: char| !character.is_alphanumeric(), "-"),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    );
    let questions = generate_practice_questions(&context)?;
    let stored_vocabulary = state
        .vocabulary_context
        .lock()
        .map_err(|_| "Vocabulary state is unavailable".to_string())?
        .clone();
    save_session_record(
        &app,
        SessionRecord {
            id: id.clone(),
            title: request.title,
            role: request.role,
            audience: request.audience,
            level: request.level,
            important_facts: request.important_facts,
            forbidden_claims: request.forbidden_claims,
            context,
            response_length: request.response_length,
            vocabulary: stored_vocabulary,
            questions: questions.clone(),
        },
    )?;
    Ok(PreparedSession { id, questions })
}

#[tauri::command]
fn extract_document(
    file_name: String,
    bytes: Vec<u8>,
    state: State<'_, RuntimeState>,
) -> Result<document::DocumentContext, String> {
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("La presentación supera el límite de 25 MB".into());
    }
    let local_result = document::extract_text(&file_name, &bytes);
    let context = match local_result {
        Ok((local_text, kind)) if document::needs_pdf_ocr(&file_name, &local_text) => {
            match extract_pdf_with_gemini(&bytes) {
                Ok(context) => context,
                Err(ocr_error) if !local_text.trim().is_empty() => document::context_from_text(
                    local_text,
                    kind,
                    "local",
                    false,
                    Some(format!("El OCR visual de Gemini no estuvo disponible: {ocr_error}")),
                    None,
                    0,
                    0,
                )?,
                Err(ocr_error) => {
                    return Err(format!(
                        "Este PDF no tiene texto legible localmente y falló el OCR de Gemini: {ocr_error}"
                    ))
                }
            }
        }
        Ok((local_text, kind)) if local_text.trim().is_empty() => {
            return Err(if kind == "PPTX" {
                "Este PowerPoint no contiene texto legible. Expórtalo como PDF para que Gemini pueda leer visualmente las diapositivas."
                    .into()
            } else {
                "El documento seleccionado no contiene texto legible".into()
            });
        }
        Ok((local_text, kind)) => {
            document::context_from_text(local_text, kind, "local", false, None, None, 0, 0)?
        }
        Err(local_error) if file_name.to_ascii_lowercase().ends_with(".pdf") => {
            extract_pdf_with_gemini(&bytes).map_err(|ocr_error| {
                format!(
                    "No se pudo leer el PDF localmente ({local_error}) ni con el OCR de Gemini ({ocr_error})"
                )
            })?
        }
        Err(error) => return Err(error),
    };
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
fn start_live_session(session_id: String, state: State<'_, RuntimeState>) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("Primero debes preparar una sesión".into());
    }
    *state
        .interaction_id
        .lock()
        .map_err(|_| "Conversation state is unavailable".to_string())? = None;
    Ok(())
}

#[tauri::command]
fn stop_live_session(state: State<'_, RuntimeState>) -> Result<(), String> {
    *state
        .interaction_id
        .lock()
        .map_err(|_| "Conversation state is unavailable".to_string())? = None;
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
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<capture::CaptureCommand>();
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
                while let Ok(command) = stop_rx.recv() {
                    match command {
                        capture::CaptureCommand::Stop => break,
                        capture::CaptureCommand::SetSource {
                            speaker,
                            enabled,
                            reply,
                        } => {
                            let _ = reply.send(engine.set_source_enabled(&speaker, enabled));
                        }
                    }
                }
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
        let _ = stop.send(capture::CaptureCommand::Stop);
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

#[tauri::command]
fn set_audio_source_enabled(
    state: State<'_, RuntimeState>,
    speaker: String,
    enabled: bool,
) -> Result<(), String> {
    if !matches!(speaker.as_str(), "ME" | "THEM") {
        return Err("Fuente de audio desconocida".into());
    }
    let slot = state
        .capture_stop
        .lock()
        .map_err(|_| "Audio state is unavailable".to_string())?;
    let control = slot
        .as_ref()
        .ok_or_else(|| "Audio capture is not running".to_string())?;
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    control
        .send(capture::CaptureCommand::SetSource {
            speaker,
            enabled,
            reply: reply_tx,
        })
        .map_err(|_| "Audio capture stopped unexpectedly".to_string())?;
    reply_rx
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "Audio source did not respond".to_string())?
}

fn sessions_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("sessions.json"))
}

#[tauri::command]
fn save_session(app: AppHandle, session: SessionRecord) -> Result<(), String> {
    save_session_record(&app, session)
}

fn save_session_record(app: &AppHandle, session: SessionRecord) -> Result<(), String> {
    let path = sessions_file(app)?;
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
fn restore_session(
    app: AppHandle,
    id: String,
    state: State<'_, RuntimeState>,
) -> Result<PreparedSession, String> {
    let session = load_sessions(app)?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| "The saved session could not be found".to_string())?;
    *state
        .session_context
        .lock()
        .map_err(|_| "Session state is unavailable".to_string())? = Some(session.context);
    *state
        .vocabulary_context
        .lock()
        .map_err(|_| "Vocabulary state is unavailable".to_string())? = session.vocabulary.clone();
    *state
        .interaction_id
        .lock()
        .map_err(|_| "Conversation state is unavailable".to_string())? = None;
    Ok(PreparedSession {
        id: session.id,
        questions: session.questions,
    })
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
        return Err("La clave API no puede estar vacía".into());
    }
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, "gemini_api_key").map_err(|e| e.to_string())?;
    entry.set_password(key).map_err(|e| {
        format!("El Administrador de credenciales de Windows no pudo guardar la clave: {e}")
    })?;
    let stored = entry
        .get_password()
        .map_err(|e| format!("La clave se guardó, pero no se pudo volver a leer: {e}"))?;
    if stored.trim() != key {
        return Err("Falló la verificación del Administrador de credenciales de Windows".into());
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
        .map_err(|_| "La clave API de Gemini no está configurada".into())
        .and_then(|key| {
            if key.is_empty() {
                Err("La clave API de Gemini está vacía".into())
            } else {
                Ok(key)
            }
        })
}

fn validate_gemini_key_value(key: &str) -> Result<(), String> {
    let response = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|error| format!("No se pudo crear el cliente de Gemini: {error}"))?
        .get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1")
        .header("x-goog-api-key", key)
        .send()
        .map_err(|error| format!("No se pudo contactar con Gemini: {error}"))?;
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
        .unwrap_or_else(|| format!("Gemini rechazó la credencial con el estado {status}"));
    Err(message)
}

#[tauri::command]
fn validate_gemini_api_key() -> Result<(), String> {
    validate_gemini_key_value(&gemini_key()?)
}

#[tauri::command]
fn gemini_health(app: AppHandle) -> health::GeminiHealthReport {
    health::run(&app)
}

fn structured_interaction(
    prompt: &str,
    schema: serde_json::Value,
    previous_interaction_id: Option<String>,
) -> Result<(serde_json::Value, serde_json::Value), String> {
    structured_interaction_input(
        serde_json::Value::String(prompt.to_string()),
        schema,
        previous_interaction_id,
        Duration::from_secs(25),
    )
}

fn structured_interaction_input(
    input: serde_json::Value,
    schema: serde_json::Value,
    previous_interaction_id: Option<String>,
    timeout: Duration,
) -> Result<(serde_json::Value, serde_json::Value), String> {
    let mut body = serde_json::json!({
        "model": GEMINI_MODEL,
        "input": input,
        "response_format": { "type": "text", "mime_type": "application/json", "schema": schema }
    });
    if let Some(previous) = previous_interaction_id {
        body["previous_interaction_id"] = serde_json::Value::String(previous);
    }
    let key = gemini_key()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|error| format!("No se pudo crear el cliente de Gemini: {error}"))?;
    let candidates = std::iter::once(GEMINI_MODEL).chain(GEMINI_FALLBACK_MODELS.iter().copied());
    let mut response_value = None;
    let mut last_message = "Gemini no devolvió ninguna respuesta".to_string();

    for model in candidates {
        body["model"] = serde_json::Value::String(model.to_string());
        let mut retry_delay = Duration::from_millis(800);
        loop {
            let response = client
                .post("https://generativelanguage.googleapis.com/v1beta/interactions")
                .header("x-goog-api-key", &key)
                .json(&body)
                .send()
                .map_err(|error| format!("Falló la solicitud a Gemini: {error}"))?;
            let status = response.status();
            if status.is_success() {
                response_value = Some(
                    response
                        .json::<serde_json::Value>()
                        .map_err(|error| format!("Respuesta no válida de Gemini: {error}"))?,
                );
                break;
            }
            let retryable = status.as_u16() == 429 || status.is_server_error();
            let response_text = response.text().unwrap_or_default();
            last_message = serde_json::from_str::<serde_json::Value>(&response_text)
                .ok()
                .and_then(|value| value["error"]["message"].as_str().map(str::to_string))
                .unwrap_or_else(|| format!("Gemini devolvió el estado {status}"));
            if !retryable || retry_delay > Duration::from_secs(4) {
                break;
            }
            std::thread::sleep(retry_delay);
            retry_delay *= 2;
        }
        if response_value.is_some() {
            break;
        }
    }

    let response = response_value.ok_or(last_message)?;
    let text = response["steps"]
        .as_array()
        .and_then(|steps| {
            steps.iter().rev().find_map(|step| {
                step["content"]
                    .as_array()
                    .and_then(|content| content.iter().find_map(|item| item["text"].as_str()))
            })
        })
        .ok_or("La respuesta de Gemini no contenía texto")?;
    let output = serde_json::from_str(text).map_err(|error| {
        format!("La respuesta de Gemini no coincide con el formato esperado: {error}")
    })?;
    Ok((response, output))
}

fn extract_pdf_with_gemini(bytes: &[u8]) -> Result<document::DocumentContext, String> {
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "text": {
                "type": "string",
                "description": "All meaningful document text in reading order, including visible labels, tables, charts and image text."
            }
        },
        "required": ["text"]
    });
    let input = serde_json::json!([
        {
            "type": "document",
            "data": BASE64_STANDARD.encode(bytes),
            "mime_type": "application/pdf"
        },
        {
            "type": "text",
            "text": "Read this presentation PDF visually. Transcribe all meaningful text in reading order, including scanned text, slide titles, labels, tables, diagrams and charts. Preserve facts, numbers and technical terms. Ignore decorative page numbers and repeated headers when they add no meaning. Return only the requested structured result."
        }
    ]);
    let (response, output) =
        structured_interaction_input(input, schema, None, Duration::from_secs(90))?;
    let parsed: DocumentOcrResponse = serde_json::from_value(output)
        .map_err(|error| format!("Could not read Gemini OCR output: {error}"))?;
    let mut model_used = String::new();
    let mut input_tokens = 0;
    let mut output_tokens = 0;
    let mut thought_tokens = 0;
    apply_usage(
        &response,
        &mut model_used,
        &mut input_tokens,
        &mut output_tokens,
        &mut thought_tokens,
    );
    document::context_from_text(
        parsed.text,
        "PDF".into(),
        "gemini_document_ocr",
        true,
        None,
        Some(model_used),
        input_tokens,
        output_tokens + thought_tokens,
    )
}

fn apply_usage(
    response: &serde_json::Value,
    model_used: &mut String,
    input_tokens: &mut u64,
    output_tokens: &mut u64,
    thought_tokens: &mut u64,
) {
    *model_used = response["model"]
        .as_str()
        .unwrap_or(GEMINI_MODEL)
        .to_string();
    *input_tokens = response["usage"]["total_input_tokens"]
        .as_u64()
        .unwrap_or(0);
    *output_tokens = response["usage"]["total_output_tokens"]
        .as_u64()
        .unwrap_or(0);
    *thought_tokens = response["usage"]["total_thought_tokens"]
        .as_u64()
        .unwrap_or(0);
}

fn generate_practice_questions(context: &str) -> Result<Vec<PracticeQuestion>, String> {
    let prompt = format!(
        r#"Create 10 realistic questions an audience may ask after this presentation and a short spoken answer for each.
Answers must be natural CEFR B2 English, 1-3 sentences, under 45 words, grounded only in the supplied context, and safe when information is missing.

SESSION CONTEXT:
{context}"#
    );
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "questions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": { "question": {"type":"string"}, "answer": {"type":"string"} },
                    "required": ["question", "answer"]
                }
            }
        },
        "required": ["questions"]
    });
    let (_, output) = structured_interaction(&prompt, schema, None)?;
    let practice: PracticeResponse = serde_json::from_value(output)
        .map_err(|error| format!("Could not read practice material: {error}"))?;
    Ok(practice.questions.into_iter().take(10).collect())
}

#[tauri::command]
fn analyze_transcript(request: TranscriptAnalysisRequest) -> Result<TranscriptAnalysis, String> {
    let prompt = format!(
        r#"Analyze one finalized utterance from a live presentation.
Translate English to natural Latin American Spanish, and Spanish to natural English. Preserve technical names and numbers.
Classify the utterance as QUESTION, REQUEST, STATEMENT, or NOISE using the recent conversation. A short follow-up such as 'Why?', 'What about security?', or 'And if it grows?' is a complete question when context makes it understandable.
Only provide normalized_question for a complete QUESTION or REQUEST. Do not turn ordinary statements into questions.

SPEAKER: {speaker}
RECENT CONVERSATION:
{conversation}

UTTERANCE:
{text}"#,
        speaker = request.speaker,
        conversation = request.conversation,
        text = request.text
    );
    let schema = serde_json::json!({
        "type": "object",
        "properties": {
            "source_language": {"type":"string"},
            "target_language": {"type":"string"},
            "translation": {"type":"string"},
            "intent": {"type":"string", "enum":["QUESTION","REQUEST","STATEMENT","NOISE"]},
            "normalized_question": {"type":["string","null"]},
            "complete": {"type":"boolean"}
        },
        "required": ["source_language","target_language","translation","intent","normalized_question","complete"]
    });
    let (response, output) = structured_interaction(&prompt, schema, None)?;
    let mut analysis: TranscriptAnalysis = serde_json::from_value(output)
        .map_err(|error| format!("Could not read transcript analysis: {error}"))?;
    apply_usage(
        &response,
        &mut analysis.model_used,
        &mut analysis.input_tokens,
        &mut analysis.output_tokens,
        &mut analysis.thought_tokens,
    );
    Ok(analysis)
}

#[tauri::command]
fn generate_answer_variant(
    request: AnswerVariantRequest,
    state: State<'_, RuntimeState>,
) -> Result<AnswerVariant, String> {
    let context = state
        .session_context
        .lock()
        .map_err(|_| "Session state is unavailable".to_string())?
        .clone()
        .unwrap_or_default();
    let instruction = match request.kind.as_str() {
        "shorter" => "Rewrite it as one immediately speakable sentence of at most 20 words.",
        "more" => "Expand it to 2-3 natural spoken sentences of at most 65 words, adding only supported detail.",
        "alternative" => "Provide a genuinely different but equally safe CEFR B2 answer.",
        _ => return Err("Unknown answer variant".into()),
    };
    let prompt = format!(
        r#"You are helping a presenter answer aloud in natural CEFR B2 English.
{instruction}
Never invent facts. Respect all forbidden claims in the session context.

SESSION CONTEXT:
{context}

RECENT CONVERSATION:
{conversation}

QUESTION:
{question}

CURRENT ANSWER:
{answer}"#,
        instruction = instruction,
        context = context,
        conversation = request.conversation,
        question = request.question,
        answer = request.current_answer
    );
    let schema = serde_json::json!({
        "type":"object",
        "properties":{"answer":{"type":"string"}},
        "required":["answer"]
    });
    let (response, output) = structured_interaction(&prompt, schema, None)?;
    let mut variant: AnswerVariant = serde_json::from_value(output)
        .map_err(|error| format!("Could not read answer variant: {error}"))?;
    apply_usage(
        &response,
        &mut variant.model_used,
        &mut variant.input_tokens,
        &mut variant.output_tokens,
        &mut variant.thought_tokens,
    );
    Ok(variant)
}

#[tauri::command]
fn generate_copilot_answer(
    request: CopilotRequest,
    state: State<'_, RuntimeState>,
) -> Result<CopilotAnswer, String> {
    let prepared_context = state
        .session_context
        .lock()
        .map_err(|_| "Session state is unavailable".to_string())?
        .clone()
        .unwrap_or_default();
    let knowledge = if prepared_context.is_empty() {
        request.knowledge.clone()
    } else {
        prepared_context
    };
    let prompt = format!(
        r#"You are a live presentation copilot for an English-speaking technical audience.
The presenter speaks at CEFR B2 level. Return only valid JSON matching the requested fields.
Never invent facts. If the exact answer is not in the knowledge or conversation, say so safely and set confidence to LOW.
Use short, natural spoken English. answer_b2 must be 1-3 sentences and no more than 45 words.
Write question_en, answer_b2 and extension_b2 in English. Write question_es, key_idea_es and warning in Spanish so the presenter can understand the guidance.

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
    let schema = serde_json::json!({
            "type": "object", "properties": {
                "question_en": {"type":"string"}, "question_es": {"type":"string"}, "answer_b2": {"type":"string"},
                "extension_b2": {"type":"string"}, "key_idea_es": {"type":"string"},
                "confidence": {"type":"string", "enum":["HIGH","MEDIUM","LOW"]}, "warning": {"type":["string","null"]}
            }, "required":["question_en","question_es","answer_b2","extension_b2","key_idea_es","confidence","warning"]
    });
    let (response, output) = structured_interaction(&prompt, schema, previous_interaction_id)?;
    let mut answer: CopilotAnswer = serde_json::from_value(output)
        .map_err(|error| format!("Gemini output did not match schema: {error}"))?;
    apply_usage(
        &response,
        &mut answer.model_used,
        &mut answer.input_tokens,
        &mut answer.output_tokens,
        &mut answer.thought_tokens,
    );
    if let Some(id) = response
        .get("id")
        .or_else(|| response.get("interaction_id"))
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
        session_context: std::sync::Mutex::new(None),
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
            set_audio_source_enabled,
            save_session,
            load_sessions,
            restore_session,
            delete_session,
            set_gemini_api_key,
            has_gemini_api_key,
            validate_gemini_api_key,
            gemini_health,
            analyze_transcript,
            generate_answer_variant,
            generate_copilot_answer
        ])
        .run(tauri::generate_context!())
        .expect("error while running Voxa");
}
