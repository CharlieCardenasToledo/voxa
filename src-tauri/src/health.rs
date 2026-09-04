use crate::{gemini_key, live, validate_gemini_key_value, GEMINI_FALLBACK_MODELS, GEMINI_MODEL};
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HealthCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub ok: bool,
    pub message: String,
    pub latency_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeminiHealthReport {
    pub overall_ok: bool,
    pub checks: Vec<HealthCheck>,
}

pub fn run(app: &AppHandle) -> GeminiHealthReport {
    let key = match gemini_key() {
        Ok(key) => key,
        Err(error) => {
            return GeminiHealthReport {
                overall_ok: false,
                checks: vec![HealthCheck {
                    id: "key",
                    label: "Clave API configurada",
                    ok: false,
                    message: error,
                    latency_ms: 0,
                }],
            };
        }
    };

    let checks = vec![
        check_key(&key),
        check_interactions(&key),
        check_live(app, &key),
    ];
    let overall_ok = checks.iter().all(|check| check.ok);
    GeminiHealthReport { overall_ok, checks }
}

fn check_key(key: &str) -> HealthCheck {
    let started = Instant::now();
    let result = validate_gemini_key_value(key);
    let latency_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(()) => HealthCheck {
            id: "key",
            label: "Clave API y modelos",
            ok: true,
            message: "Google aceptó la clave y devolvió la lista de modelos.".into(),
            latency_ms,
        },
        Err(error) => HealthCheck {
            id: "key",
            label: "Clave API y modelos",
            ok: false,
            message: error,
            latency_ms,
        },
    }
}

/// Mirrors the retry-then-fall-back-to-another-model behavior of
/// `generate_copilot_answer`, so the health check reports what the app would
/// actually do in production rather than failing it on a single overloaded
/// model that the app itself already routes around.
fn check_interactions(key: &str) -> HealthCheck {
    let label = "Generación de texto (Interactions API)";
    let started = Instant::now();
    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return HealthCheck {
                id: "interactions",
                label,
                ok: false,
                message: format!("No se pudo crear el cliente de Gemini: {error}"),
                latency_ms: started.elapsed().as_millis() as u64,
            }
        }
    };

    let candidates = std::iter::once(GEMINI_MODEL).chain(GEMINI_FALLBACK_MODELS.iter().copied());
    let mut last_message = String::new();
    for model in candidates {
        let body =
            serde_json::json!({ "model": model, "input": "Reply with exactly one word: OK" });
        let mut retry_delay = Duration::from_millis(800);
        loop {
            let response = client
                .post("https://generativelanguage.googleapis.com/v1beta/interactions")
                .header("x-goog-api-key", key)
                .json(&body)
                .send();
            let response = match response {
                Ok(response) => response,
                Err(error) => {
                    last_message =
                        format!("Falló la solicitud a Gemini: {}", describe_error(&error));
                    break;
                }
            };
            let status = response.status();
            if status.is_success() {
                let latency_ms = started.elapsed().as_millis() as u64;
                let value: serde_json::Value = match response.json() {
                    Ok(value) => value,
                    Err(error) => {
                        return HealthCheck {
                            id: "interactions",
                            label,
                            ok: false,
                            message: format!("Respuesta no válida de Gemini: {error}"),
                            latency_ms,
                        }
                    }
                };
                let has_output = value["steps"]
                    .as_array()
                    .is_some_and(|steps| !steps.is_empty());
                if !has_output {
                    last_message = "Gemini respondió sin contenido.".into();
                    break;
                }
                let note = if model == GEMINI_MODEL {
                    String::new()
                } else {
                    format!(" (se usó {model} porque {GEMINI_MODEL} no estaba disponible)")
                };
                return HealthCheck {
                    id: "interactions",
                    label,
                    ok: true,
                    message: format!("El modelo {model} respondió correctamente.{note}"),
                    latency_ms,
                };
            }
            let is_retryable = status.as_u16() == 429 || status.is_server_error();
            let body_text = response.text().unwrap_or_default();
            last_message = serde_json::from_str::<serde_json::Value>(&body_text)
                .ok()
                .and_then(|value| {
                    value
                        .get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(|message| message.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| format!("Gemini devolvió el estado {status}"));
            if !is_retryable || retry_delay > Duration::from_secs(4) {
                break;
            }
            std::thread::sleep(retry_delay);
            retry_delay *= 2;
        }
    }
    HealthCheck {
        id: "interactions",
        label,
        ok: false,
        message: last_message,
        latency_ms: started.elapsed().as_millis() as u64,
    }
}

/// reqwest's `Display` often hides the underlying transport failure (timeout
/// vs. TLS vs. connection reset), so walk the `source()` chain to surface it.
fn describe_error(error: &dyn std::error::Error) -> String {
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

fn check_live(app: &AppHandle, key: &str) -> HealthCheck {
    let started = Instant::now();
    let result = live::health_check(app, key);
    let latency_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(()) => HealthCheck {
            id: "live",
            label: "Transcripción en vivo (WebSocket)",
            ok: true,
            message: "La sesión en vivo aceptó la configuración.".into(),
            latency_ms,
        },
        Err(error) => HealthCheck {
            id: "live",
            label: "Transcripción en vivo (WebSocket)",
            ok: false,
            message: error,
            latency_ms,
        },
    }
}
