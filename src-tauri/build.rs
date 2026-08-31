fn main() {
    // Keep local development/builds reproducible before the final branded icon exists.
    // This is replaced by the product icon during release packaging.
    let icon_dir = std::path::Path::new("icons");
    let icon_path = icon_dir.join("icon.ico");
    if !icon_path.exists() || std::env::var("VOXA_GENERATE_DEV_ICON").is_ok() {
        std::fs::create_dir_all(icon_dir).expect("create icon directory");
        let png: &[u8] = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDATx\xdac\x64\xf8\x0f\x00\x01\x05\x01\x01'\x18\xe3f\x00\x00\x00\x00IEND\xaeB\x60\x82";
        let mut icon = Vec::with_capacity(6 + 16 + png.len());
        icon.extend_from_slice(&[0, 0, 1, 0, 1, 0]);
        icon.extend_from_slice(&[1, 1, 0, 0, 1, 0, 32, 0]);
        icon.extend_from_slice(&(png.len() as u32).to_le_bytes());
        icon.extend_from_slice(&(22u32).to_le_bytes());
        icon.extend_from_slice(png);
        std::fs::write(icon_path, icon).expect("write development icon");
    }
    tauri_build::build()
}
