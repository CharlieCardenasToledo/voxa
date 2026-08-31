use crate::{gemini_key, live, validate_gemini_key_value, GEMINI_MODEL};
use serde::Serialize;
use std::time::{Duration, Instant};

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

pub fn run() -> GeminiHealthReport {
    let key = match gemini_key() {
        Ok(key) => key,
        Err(error) => {
            return GeminiHealthReport {
                overall_ok: false,
                checks: vec![HealthCheck {
                    id: "key",
                    label: "API key configured",
                    ok: false,
                    message: error,
                    latency_ms: 0,
                }],
            };
        }
    };

    let checks = vec![check_key(&key), check_interactions(&key), check_live(&key)];
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
            label: "API key & models endpoint",
            ok: true,
            message: "Google accepted the key and returned the models list.".into(),
            latency_ms,
        },
        Err(error) => HealthCheck {
            id: "key",
            label: "API key & models endpoint",
            ok: false,
            message: error,
            latency_ms,
        },
    }
}

fn check_interactions(key: &str) -> HealthCheck {
    let label = "Text generation (Interactions API)";
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
                message: format!("Could not create the Gemini client: {error}"),
                latency_ms: started.elapsed().as_millis() as u64,
            }
        }
    };
    let body = serde_json::json!({ "model": GEMINI_MODEL, "input": "Reply with exactly one word: OK" });
    let response = client
        .post("https://generativelanguage.googleapis.com/v1beta/interactions")
        .header("x-goog-api-key", key)
        .json(&body)
        .send();
    let latency_ms = started.elapsed().as_millis() as u64;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return HealthCheck {
                id: "interactions",
                label,
                ok: false,
                message: format!("Gemini request failed: {}", describe_error(&error)),
                latency_ms,
            }
        }
    };
    if !response.status().is_success() {
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
            .unwrap_or_else(|| format!("Gemini returned {status}"));
        return HealthCheck {
            id: "interactions",
            label,
            ok: false,
            message,
            latency_ms,
        };
    }
    let value: serde_json::Value = match response.json() {
        Ok(value) => value,
        Err(error) => {
            return HealthCheck {
                id: "interactions",
                label,
                ok: false,
                message: format!("Invalid Gemini response: {error}"),
                latency_ms,
            }
        }
    };
    let has_output = value["steps"].as_array().is_some_and(|steps| !steps.is_empty());
    if has_output {
        HealthCheck {
            id: "interactions",
            label,
            ok: true,
            message: format!("Model {GEMINI_MODEL} responded with output."),
            latency_ms,
        }
    } else {
        HealthCheck {
            id: "interactions",
            label,
            ok: false,
            message: "Gemini responded without any output steps.".into(),
            latency_ms,
        }
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

fn check_live(key: &str) -> HealthCheck {
    let started = Instant::now();
    let result = live::health_check(key);
    let latency_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(()) => HealthCheck {
            id: "live",
            label: "Live transcription (WebSocket)",
            ok: true,
            message: "The Live session accepted the setup message.".into(),
            latency_ms,
        },
        Err(error) => HealthCheck {
            id: "live",
            label: "Live transcription (WebSocket)",
            ok: false,
            message: error,
            latency_ms,
        },
    }
}
