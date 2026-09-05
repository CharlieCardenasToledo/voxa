# Política de seguridad

## Versiones soportadas

Voxa está en desarrollo activo previo a la versión 1.0. Solo la última versión publicada recibe correcciones de seguridad.

| Versión | Soportada |
| --- | --- |
| 0.1.x | ✅ |

## Reportar una vulnerabilidad

Si encuentras una vulnerabilidad de seguridad en Voxa, **no abras un issue público**. En su lugar:

1. Repórtala de forma privada a través de la pestaña [Security](https://github.com/CharlieCardenasToledo/voxa/security/advisories/new) del repositorio ("Report a vulnerability"), o
2. Escribe directamente al mantenedor ([@CharlieCardenasToledo](https://github.com/CharlieCardenasToledo)) describiendo el problema, los pasos para reproducirlo y el impacto potencial.

Intentaremos confirmar la recepción en un plazo razonable y coordinar contigo la divulgación una vez exista una corrección disponible.

## Alcance

Voxa es una aplicación de escritorio local: el audio se procesa en memoria y nunca se sube a un servidor propio, la transcripción y el contexto de sesión se guardan localmente en el directorio de datos de la aplicación, y la clave de la API de Gemini se guarda en el Administrador de credenciales de Windows (nunca en texto plano dentro del repositorio o del frontend). Nos interesa especialmente cualquier reporte relacionado con:

- Manejo de la clave de Gemini o de credenciales almacenadas.
- Lectura o escritura de archivos fuera del directorio de datos de la aplicación (por ejemplo, mediante un identificador de sesión manipulado).
- Ejecución de código o procesos no previstos a partir de un documento (PDF/PPTX) cargado por el usuario.
- Cualquier forma de que una ventana nativa (presentador, identificador de monitor) cargue contenido remoto o no confiable.

Los reportes sobre dependencias de terceros desactualizadas son bienvenidos, pero se gestionan por separado (ver [`npm audit`](https://docs.npmjs.com/cli/v10/commands/npm-audit) y el `Cargo.lock` del proyecto).
