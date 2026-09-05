# Voxa — Copiloto de presentaciones

Aplicación de escritorio para Windows (Tauri 2 + React + Rust) que escucha, transcribe, traduce y ayuda a responder en tiempo real durante clases, presentaciones y reuniones — todo procesado localmente, con la sola excepción de las llamadas a la API de Gemini necesarias para transcripción y generación de texto.

[![Licencia: MIT](https://img.shields.io/badge/Licencia-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/CharlieCardenasToledo/voxa/actions/workflows/ci.yml/badge.svg)](https://github.com/CharlieCardenasToledo/voxa/actions/workflows/ci.yml)

## ¿Qué es Voxa?

Voxa es un copiloto privado con tres modos de sesión, cada uno pensado para una situación distinta:

- **Clase** — resúmenes y preguntas de práctica a partir del material de la sesión, sin necesidad de compartir pantalla.
- **Presentación** — modo de doble pantalla: una ventana pública muestra el PDF a pantalla completa (la que compartes por Zoom/Teams) mientras tu ventana de control muestra un teleprompter con el guion generado por diapositiva (inglés, pronunciación y traducción), preguntas de la audiencia y sugerencias de respuesta.
- **Reunión** — solo transcripción y traducción en vivo de ambos lados de la conversación, sin generar guion ni requerir ningún documento.

## Funcionalidades

- Transcripción y traducción en vivo (micrófono + audio del sistema) con selector de dispositivo de entrada/salida.
- Copiloto de respuestas: detecta preguntas de la audiencia y sugiere una respuesta en inglés (B1/B2/C1 según el nivel configurado), con variantes más corta/más detallada/alternativa.
- Modo presentación con ventana pública independiente (seleccionable por monitor, con overlay de identificación al estilo Windows) y teleprompter privado sincronizado.
- Guion de presentación generado a partir del PDF (por diapositiva, con saludo inicial y cierre) usando Gemini.
- Extracción de contexto desde PDF/PPTX, incluyendo OCR de respaldo para documentos escaneados.
- Historial de sesiones (contexto, preguntas, transcripción y — en modo presentación — el PDF y guion) para reabrirlas más tarde.
- Perfil de usuario persistente (nombre, contexto profesional, vocabulario técnico, foto) que se aplica a todas las sesiones.
- Seguimiento de uso y costo estimado de Gemini, con diagnóstico de conectividad (clave, modelo de texto, WebSocket de Live) desde la app.
- Todo el audio y la transcripción se procesan y guardan localmente; la clave de Gemini se guarda en el Administrador de credenciales de Windows y nunca se expone en el frontend ni en los archivos del proyecto.

## Stack técnico

| Capa | Tecnología |
| --- | --- |
| Shell de escritorio | [Tauri 2](https://tauri.app/) (Rust) |
| Frontend | React 18 + TypeScript + [Zustand](https://github.com/pmndrs/zustand) + [Tailwind CSS](https://tailwindcss.com/) |
| Renderizado de PDF | [pdf.js](https://mozilla.github.io/pdf.js/) |
| Extracción de documentos | `lopdf` (PDF), `zip` + `quick-xml` (PPTX) |
| Captura de audio | `cpal` (micrófono + loopback WASAPI) |
| Transcripción en vivo | Puente en Python (`google-genai`) hablado por stdin/stdout — ver [por qué](#por-qué-un-puente-en-python-para-la-transcripción-en-vivo) |
| Credenciales | `keyring` (Administrador de credenciales de Windows) |

## Requisitos

- Windows con WebView2.
- Rust stable `x86_64-pc-windows-msvc`.
- Visual Studio Build Tools con carga de trabajo de C++.
- Node.js 20+.
- Python 3.10+ en el `PATH` (como `python`), con `pip install google-genai` — solo para desarrollo. El instalador de producción incluye el puente ya compilado, así que el usuario final no necesita Python.

## Desarrollo

```powershell
npm install
npm run tauri:dev
```

Esto compila el frontend y Tauri lo carga directamente desde `dist`, sin depender de un servidor Vite. La ventana se abre automáticamente.

Para validar el entorno sin abrir la aplicación (tipos + build del frontend):

```powershell
npm run check
```

Para correr las pruebas del frontend:

```powershell
npm run test:frontend
```

## Compilar el instalador

```powershell
npm run tauri:build
```

Este comando compila primero `voxa-live-bridge.exe` con PyInstaller y luego genera el instalador NSIS en `src-tauri/target/release/bundle/nsis/`.

## Configurar Gemini

La API key se configura desde **Perfil y configuración → Gemini y aplicación** dentro de la aplicación. Se guarda en el Administrador de credenciales de Windows y no se incluye en el frontend ni en ningún archivo del repositorio.

Para desarrollo local también se acepta la variable de entorno `GEMINI_API_KEY`:

```powershell
$env:GEMINI_API_KEY = "tu-clave"
npm run tauri:dev
```

**No subas claves al repositorio ni las pegues en archivos de configuración.**

Dentro de **Configuración → Diagnóstico** hay un botón que prueba por separado las tres formas en que Voxa habla con Gemini:

1. **Clave y modelos** — valida la clave contra el endpoint de modelos.
2. **Generación de texto** — hace una llamada mínima con el modelo configurado, el mismo que usa el copiloto en vivo.
3. **Transcripción en vivo (WebSocket)** — abre una sesión real de Gemini Live y espera la confirmación de conexión.

Cada verificación reporta OK/error, el mensaje devuelto por Google y la latencia, para distinguir entre "la clave no es válida", "el modelo está saturado" y "algo en la red bloquea las conexiones salientes".

### Por qué un puente en Python para la transcripción en vivo

`src-tauri/src/live.rs` no habla el WebSocket de Gemini Live directamente: lanza `python src-tauri/python/live_bridge.py` como subproceso y le habla por stdin/stdout con un protocolo JSON de una línea (`{"audio": "<base64>"}`, `{"end": true}` → `{"status": "connected"}`, `{"transcript": "...", "interim": bool}`, `{"error": "..."}`).

Esto no es una preferencia de estilo: el cliente WebSocket de Rust (`tungstenite` + `rustls`) se quedaba colgado esperando `setupComplete` de forma reproducible contra este endpoint/modelo específico, mientras que la petición idéntica (misma key, mismo JSON, mismo instante) funcionaba en menos de un segundo con el SDK oficial de Google en Python. Sin poder capturar el tráfico TLS en este entorno para encontrar la diferencia exacta, se optó por usar el SDK que Google sí mantiene para este propósito en vez de seguir depurando a ciegas.

Si Voxa reporta que la transcripción en vivo no conecta, primero verifica que `python` esté en el `PATH` y que `google-genai` esté instalado (`python -m pip show google-genai`).

## Modo mock (navegador)

Si se abre el frontend fuera de Tauri (por ejemplo con `npm run dev`), la app funciona en modo mock para validar la navegación entre pantallas sin micrófono ni credenciales reales. La captura de audio, la extracción de PDF/PPTX, la generación de guion y las llamadas a Gemini solo se activan al ejecutar dentro de Tauri.

## Privacidad y seguridad

- El audio nunca se guarda en disco; solo se procesa en memoria para transcribirlo.
- La transcripción y el contexto de cada sesión se guardan localmente (`sessions.json` en el directorio de datos de la app), nunca en un servidor propio.
- La clave de Gemini vive en el Administrador de credenciales de Windows, nunca en texto plano dentro del proyecto.
- Para reportar una vulnerabilidad, revisa [SECURITY.md](SECURITY.md).

## Contribuir

Las contribuciones son bienvenidas — revisa [CONTRIBUTING.md](CONTRIBUTING.md) para la guía de desarrollo, convenciones y el proceso de pull request.

## Licencia

Distribuido bajo la licencia MIT. Consulta [LICENSE](LICENSE) para el texto completo.
