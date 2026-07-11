mod agents;
mod model;
mod persistence;
mod project_files;
mod snapshots;

use agents::AgentManager;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapPayload {
    app_version: &'static str,
    platform: &'static str,
    execution_mode: &'static str,
}

#[tauri::command]
fn bootstrap() -> BootstrapPayload {
    BootstrapPayload {
        app_version: env!("CARGO_PKG_VERSION"),
        platform: "windows",
        execution_mode: "direct-transaction",
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AgentManager::default())
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            project_files::scan_project,
            project_files::read_project_file,
            project_files::write_project_text_file,
            project_files::open_in_system,
            persistence::load_persisted_state,
            persistence::save_persisted_state,
            agents::detect_agents,
            agents::start_agent,
            agents::write_agent,
            agents::resize_agent,
            agents::stop_agent,
            snapshots::create_task_snapshot,
            snapshots::restore_task_snapshot,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ADE Workbench");
}
