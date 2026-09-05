# Changelog

Todos los cambios notables de este proyecto se documentan en este archivo.

El formato sigue [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/), y este proyecto usa [Versionado Semántico](https://semver.org/lang/es/) mientras se acerca a su primera versión 1.0.

## [Unreleased]

### Added

- Rediseño completo de la interfaz (sidebar de navegación, pantalla de Inicio, Historial de sesiones y flujo de Preparar sesión en 3 pasos) usando Tailwind CSS.
- Selector de dispositivos de audio: permite elegir qué micrófono usar y de qué salida del sistema escuchar a la otra persona, en vez de depender siempre del dispositivo predeterminado.
- Miniatura en vivo de la diapositiva actual (renderizada con `pdf.js`) en la vista de Presentación.
- Contador real de duración de sesión, mostrado en la pantalla En vivo y en el Resumen.
- Buscador de sesiones guardadas en la pantalla Historial.

### Changed

- El hilo de reconexión automática de dispositivos de audio (para auriculares Bluetooth, etc.) ahora solo sigue al dispositivo predeterminado del sistema cuando el usuario no eligió uno explícito, en vez de sobrescribir siempre la selección manual.

## [0.1.0] — Base inicial

### Added

- Aplicación de escritorio Tauri 2 + React con tres modos de sesión: Clase, Presentación y Reunión.
- Modo Presentación de doble pantalla: ventana pública con el PDF a pantalla completa (para compartir por Zoom/Teams) y ventana de control privada con teleprompter, sincronizadas.
- Selector de monitor con overlay de identificación al estilo Windows antes de iniciar una presentación.
- Generación de guion de presentación por diapositiva (inglés, pronunciación y traducción, más saludo inicial y cierre) a partir del PDF, usando Gemini.
- Extracción de contexto desde PDF y PPTX, con OCR de respaldo para documentos escaneados.
- Transcripción y traducción en vivo de micrófono y audio del sistema.
- Copiloto de respuestas: detección de preguntas de la audiencia y sugerencias de respuesta en inglés, con variantes más corta/más detallada/alternativa.
- Historial de sesiones con contexto, preguntas, transcripción y (en modo presentación) el PDF y el guion, para reabrirlas más tarde.
- Perfil de usuario persistente (nombre, contexto profesional, vocabulario técnico, foto).
- Seguimiento de uso y costo estimado de Gemini, con diagnóstico de conectividad desde la app (clave, generación de texto, WebSocket de Live).
- Almacenamiento seguro de la clave de Gemini en el Administrador de credenciales de Windows.
- Puente de transcripción en vivo implementado en Python (`google-genai`) para evitar un cuelgue reproducible del cliente WebSocket de Rust contra el endpoint de Gemini Live.
- Reintento con modelo de respaldo cuando Gemini responde con error 503 de alta demanda.

[Unreleased]: https://github.com/CharlieCardenasToledo/voxa/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/CharlieCardenasToledo/voxa/releases/tag/v0.1.0
