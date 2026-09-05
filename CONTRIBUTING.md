# Contribuir a Voxa

Gracias por tu interés en mejorar Voxa. Esta guía resume cómo preparar el entorno, qué convenciones sigue el proyecto y cómo proponer cambios.

## Antes de empezar

1. Revisa los [issues abiertos](https://github.com/CharlieCardenasToledo/voxa/issues) para evitar duplicar trabajo.
2. Para cambios grandes (nueva funcionalidad, cambios de arquitectura), abre primero un issue describiendo la propuesta antes de invertir tiempo en una implementación completa.
3. Para bugs o mejoras pequeñas, puedes ir directo a un pull request.

## Preparar el entorno de desarrollo

Sigue la sección [Requisitos](README.md#requisitos) y [Desarrollo](README.md#desarrollo) del README. En resumen:

```powershell
npm install
npm run tauri:dev
```

Antes de abrir un pull request, verifica que todo lo siguiente pase localmente:

```powershell
npm run check          # tipos + build del frontend
npm run test:frontend  # pruebas de Vitest
cd src-tauri && cargo check   # tipos del backend en Rust
```

## Convenciones del proyecto

- **Frontend**: React + TypeScript, estado global en `src/store.ts` (Zustand), estilos con clases de utilidad de Tailwind directamente en el JSX — evita añadir CSS de componentes nuevo salvo que sea imposible con utilidades.
- **Backend**: cada capacidad nueva expuesta al frontend es un `#[tauri::command]` en `src-tauri/src/lib.rs` (o un módulo dedicado), registrado en `tauri::generate_handler!`. Los comandos que tocan disco validan cualquier identificador que llegue del frontend antes de construir una ruta de archivo.
- **Mocks**: toda función en `src/services/native.ts` debe devolver un valor de "modo navegador" razonable cuando `isNativeRuntime()` es `false`, para que la UI se pueda validar fuera de Tauri.
- Prefiere código explícito y directo sobre abstracciones prematuras; evita añadir dependencias nuevas si la funcionalidad ya se puede resolver con lo existente.

## Estilo de commits

Usa mensajes de commit en modo imperativo y enfocados en el "por qué" cuando no sea obvio (`Fix`, `Add`, `Improve`, `Harden`, etc.), siguiendo el estilo ya usado en el historial del repositorio. No es necesario un formato tipo Conventional Commits.

## Pull requests

1. Haz fork del repositorio (o crea una rama si tienes acceso de escritura) y trabaja en una rama descriptiva (`feature/...`, `fix/...`).
2. Asegúrate de que el build, los tipos y las pruebas pasen (ver arriba).
3. Describe en el PR **qué** cambia y **por qué**, y cómo lo probaste (incluye pasos manuales si el cambio toca audio, ventanas nativas o Gemini, ya que esas rutas no tienen cobertura automatizada completa).
4. Un PR que toque el manejo de la clave de Gemini, almacenamiento en disco, o cualquier ruta de archivo construida con datos de la sesión, debe explicar explícitamente por qué es seguro (ver [SECURITY.md](SECURITY.md)).

## Reportar vulnerabilidades

No abras un issue público para vulnerabilidades de seguridad. Sigue el proceso descrito en [SECURITY.md](SECURITY.md).

## Código de conducta

Este proyecto sigue el [Código de conducta](CODE_OF_CONDUCT.md). Al participar, aceptas cumplirlo.
