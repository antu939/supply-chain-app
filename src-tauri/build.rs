use std::fs;
use std::path::Path;

fn copy_filtered(src: &Path, dst: &Path) {
    if src.is_dir() {
        let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if matches!(name, "tests" | "types" | ".git") {
            return;
        }
        fs::create_dir_all(dst).expect("failed to create frontend dist directory");
        for entry in fs::read_dir(src).expect("failed to read frontend source directory") {
            let entry = entry.expect("failed to read directory entry");
            let entry_name = entry.file_name();
            let entry_str = entry_name.to_string_lossy();
            if entry_str == ".DS_Store" || entry_str.starts_with("._") {
                continue;
            }
            copy_filtered(&entry.path(), &dst.join(&entry_name));
        }
    } else if src.is_file() {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).expect("failed to create parent directory");
        }
        fs::copy(src, dst).expect("failed to copy frontend asset");
    }
}

fn main() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let root_dir = manifest_dir
        .parent()
        .expect("src-tauri must live inside the project root");
    let dist_dir = manifest_dir.join("dist");

    if dist_dir.exists() {
        fs::remove_dir_all(&dist_dir).expect("failed to clean src-tauri/dist");
    }
    fs::create_dir_all(&dist_dir).expect("failed to create src-tauri/dist");

    for rel in ["index.html", "app", "modules", "shared", "storage"] {
        let src = root_dir.join(rel);
        println!("cargo:rerun-if-changed={}", src.display());
        copy_filtered(&src, &dist_dir.join(rel));
    }

    tauri_build::build();
}
