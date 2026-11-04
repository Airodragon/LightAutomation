fn main() {
    // The embedded web UI (include_dir) must be rebuilt whenever the frontend changes.
    println!("cargo:rerun-if-changed=../src");
    tauri_build::build()
}
