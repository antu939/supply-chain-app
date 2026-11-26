use tauri::WebviewWindowBuilder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let win_cfg = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .expect("main window config missing");
            WebviewWindowBuilder::from_config(app.handle(), &win_cfg)?
                .on_download(|_webview, _event| true)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Supply Chain application");
}
