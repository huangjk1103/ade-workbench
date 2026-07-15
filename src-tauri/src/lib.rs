use tauri::Manager;

#[cfg(not(debug_assertions))]
use std::{sync::Mutex, time::Duration};
#[cfg(not(debug_assertions))]
use tauri::{RunEvent, Url};

#[cfg(not(debug_assertions))]
use tauri::path::BaseDirectory;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::{process::CommandChild, ShellExt};

#[cfg(not(debug_assertions))]
struct SidecarProcess(Mutex<Option<CommandChild>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .ok_or_else(|| "ADE main window was not created".to_string())?;

            #[cfg(not(debug_assertions))]
            {
                // Release loads the frontend from the Axum sidecar, so keep
                // the initially created window hidden until that server is
                // ready. Development uses Tauri's devUrl and remains visible.
                window.hide()?;
                let dist_dir = app.path().resolve("web-dist", BaseDirectory::Resource)?;
                let scripts_dir = app.path().resolve("server-scripts", BaseDirectory::Resource)?;
                let port = std::net::TcpListener::bind("127.0.0.1:0")?
                    .local_addr()?
                    .port();
                let command = app
                    .shell()
                    .sidecar("ade-server")?
                    .env("ADE_DIST_DIR", dist_dir)
                    .env("ADE_SCRIPTS_DIR", scripts_dir)
                    .env("ADE_PORT", port.to_string());
                let (mut events, child) = command.spawn()?;
                app.manage(SidecarProcess(Mutex::new(Some(child))));

                // Drain stdout/stderr so the sidecar cannot block on a full
                // pipe. The server's normal lifecycle is tied to the Tauri
                // process through SidecarProcess below.
                tauri::async_runtime::spawn(async move {
                    while events.recv().await.is_some() {}
                });

                // Keep the window hidden until Axum is accepting connections,
                // then navigate to its same-origin frontend. Serving the UI
                // and API from one localhost origin preserves the server's
                // no-CORS security boundary.
                std::thread::spawn(move || {
                    let ready = (0..120).any(|_| {
                        let connected = std::net::TcpStream::connect_timeout(
                            &format!("127.0.0.1:{port}")
                                .parse()
                                .expect("valid ADE address"),
                            Duration::from_millis(100),
                        )
                        .is_ok();
                        if !connected {
                            std::thread::sleep(Duration::from_millis(100));
                        }
                        connected
                    });

                    if ready {
                        let url: Url = format!("http://127.0.0.1:{port}")
                            .parse()
                            .expect("valid ADE frontend URL");
                        let _ = window.navigate(url);
                    }
                    let _ = window.show();
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build ADE Workbench");

    app.run(|app_handle, event| {
        #[cfg(not(debug_assertions))]
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            if let Some(state) = app_handle.try_state::<SidecarProcess>() {
                if let Ok(mut slot) = state.0.lock() {
                    if let Some(child) = slot.take() {
                        let _ = child.kill();
                    }
                }
            }
        }

        #[cfg(debug_assertions)]
        let _ = (app_handle, event);
    });
}
