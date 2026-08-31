# Voxa — Presentation Copilot

Aplicación local de escritorio para Windows basada en Tauri 2, React y Rust.

## Requisitos

- Windows con WebView2.
- Rust stable `x86_64-pc-windows-msvc`.
- Visual Studio Build Tools con C++.
- Node.js 20+.
- Python 3.10+ en el `PATH` (como `python`), con `pip install google-genai`. La transcripción en vivo la maneja un sidecar de Python (`src-tauri/python/live_bridge.py`) que usa el SDK oficial de Google — ver "Por qué Python" más abajo. Si tu intérprete no se llama `python`, define `VOXA_PYTHON` con la ruta completa.

## Levantar Tauri localmente

Desde esta carpeta:

```powershell
npm install
npm run tauri:dev
```

El comando compila el frontend y Tauri lo carga directamente desde `dist`, sin depender de un servidor Vite ni de un modo mock. Luego abre la ventana automáticamente. Para validar el entorno sin abrir la aplicación:

```powershell
npm run check
```

Para generar el bundle local:

```powershell
npm run tauri:build
```

## Gemini

La API key se configura desde `Settings` dentro de la aplicación. Se guarda en Windows Credential Manager y no se incluye en el frontend. También se acepta `GEMINI_API_KEY` como variable de entorno para desarrollo local:

```powershell
$env:GEMINI_API_KEY = "tu-clave"
npm run tauri:dev
```

No subas claves al repositorio ni las pegues en archivos de configuración.

### Diagnóstico (health check)

Dentro de `Settings` hay un botón **Run health check** que prueba por separado las tres formas en que Voxa habla con Gemini:

1. **API key & models endpoint** — valida la clave contra `GET /v1beta/models`.
2. **Text generation (Interactions API)** — hace una llamada mínima a `POST /v1beta/interactions` con el modelo configurado (`gemini-3.7-flash`), el mismo endpoint que usa el copiloto en vivo.
3. **Live transcription (WebSocket)** — abre una sesión real contra `wss://.../BidiGenerateContent` con el modelo `gemini-3.5-transcribe-live` y espera `setupComplete`.

Cada verificación reporta OK/error, el mensaje devuelto por Google y la latencia, para poder distinguir entre "la clave no es válida", "el modelo está saturado" y "algo en la red (firewall/proxy/antivirus) bloquea las conexiones salientes a Gemini" — que son fallas con soluciones muy distintas.

### Por qué Python para la transcripción en vivo

`src-tauri/src/live.rs` no habla el WebSocket de Gemini Live directamente: lanza `python src-tauri/python/live_bridge.py` como subproceso y le habla por stdin/stdout con un protocolo JSON de una línea (`{"audio": "<base64>"}`, `{"end": true}` → `{"status": "connected"}`, `{"transcript": "...", "interim": bool}`, `{"error": "..."}`).

Esto no es una preferencia de estilo: el cliente WebSocket de Rust (`tungstenite` + `rustls`) se quedaba colgado esperando `setupComplete` de forma reproducible contra este endpoint/modelo específico, mientras que la petición idéntica (misma key, mismo JSON, mismo instante) funcionaba en menos de 1 segundo con el SDK oficial de Google en Python — y hasta con la librería `websockets` cruda. Sin poder capturar el tráfico TLS en este entorno para encontrar la diferencia exacta, se optó por usar el SDK que Google sí mantiene para este propósito en vez de seguir depurando a ciegas.

Si Voxa reporta que la transcripción en vivo no conecta, primero verifica que `python` esté en el `PATH` y que `google-genai` esté instalado (`python -m pip show google-genai`).

## Modo mock

Si se abre el frontend fuera de Tauri, funciona en modo mock para validar PREPARE → PRACTICE → LIVE sin micrófono ni credenciales. La captura de audio, extracción PDF/PPTX y llamadas Gemini se activan al ejecutar Tauri.
