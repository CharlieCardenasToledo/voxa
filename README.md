# Voxa — Presentation Copilot

Aplicación local de escritorio para Windows basada en Tauri 2, React y Rust.

## Requisitos

- Windows con WebView2.
- Rust stable `x86_64-pc-windows-msvc`.
- Visual Studio Build Tools con C++.
- Node.js 20+.

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

## Modo mock

Si se abre el frontend fuera de Tauri, funciona en modo mock para validar PREPARE → PRACTICE → LIVE sin micrófono ni credenciales. La captura de audio, extracción PDF/PPTX y llamadas Gemini se activan al ejecutar Tauri.
