## Qué cambia

<!-- Describe el cambio y por qué es necesario. -->

## Cómo se probó

<!-- npm run check / npm run test:frontend / cargo check, y cualquier prueba manual
     (especialmente si el cambio toca audio, ventanas nativas o Gemini). -->

- [ ] `npm run check` pasa
- [ ] `npm run test:frontend` pasa
- [ ] `cargo check` (dentro de `src-tauri/`) pasa
- [ ] Probado manualmente en `npm run tauri:dev`

## Checklist

- [ ] No se incluyen claves, tokens ni datos personales en el diff.
- [ ] Si se tocó el manejo de la clave de Gemini, almacenamiento en disco, o una ruta de archivo construida con datos de la sesión, se explica por qué sigue siendo seguro.
- [ ] Se actualizó `CHANGELOG.md` si el cambio es visible para el usuario final.
