use std::{
    collections::{HashMap, HashSet},
    fs,
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};

use anyhow::{anyhow, Context};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{path::BaseDirectory, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::{
    fs::OpenOptions,
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
};
use uuid::Uuid;

mod backup_files;
mod command_template;
mod database;
mod output_decode;
mod process_control;
mod python_scanner;
mod run_recovery;
mod runtime_parameters;
mod runtime_policy;
mod structured_arguments;

use command_template::{
    apply_command_runtime_values, apply_runtime_values, extract_runtime_variables, join_command,
    normalize_command, quote_arg, tokenize_command_line,
};
use output_decode::OutputDecoder;
use process_control::ProcessTree;
use python_scanner::{ScriptScanPreview, ScriptScanStatus};
use runtime_parameters::{
    default_parameter, resolve_runtime_values, resolve_runtime_values_allowing_multiline,
    synchronize_definitions, ResolvedRuntimeValues, RuntimeParameterDefinition,
    RuntimeParameterType,
};
use runtime_policy::{concurrency_action, ConcurrencyAction};
use structured_arguments::{
    build_structured_arguments, validate_joint_rules, TaskArgumentRule, ValidationRule,
};

#[derive(Clone)]
struct RunningProcess {
    pid: u32,
    task_id: String,
    tree: Arc<ProcessTree>,
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone)]
struct AppState {
    db_path: PathBuf,
    log_dir: PathBuf,
    bundled_python_dir: PathBuf,
    running: Arc<Mutex<HashMap<String, RunningProcess>>>,
    stopping: Arc<Mutex<HashMap<String, String>>>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
enum TaskKind {
    PythonTask,
    CommandTask,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
enum InterpreterType {
    Bundled,
    External,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct EnvVarEntry {
    key: String,
    value: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct PythonTaskConfig {
    interpreter_profile_id: String,
    script_path: String,
    args_template: String,
    #[serde(default)]
    argument_mode: ArgumentMode,
    #[serde(default)]
    argument_rules: Vec<TaskArgumentRule>,
    #[serde(default)]
    validation_rules: Vec<ValidationRule>,
    #[serde(default)]
    script_hash: Option<String>,
    #[serde(default)]
    scan_snapshot: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
enum ArgumentMode {
    #[default]
    Template,
    Structured,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CommandTaskConfig {
    command: String,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
struct TaskReliabilityPolicy {
    timeout_seconds: u64,
    retry_count: u32,
    retry_delay_seconds: u64,
    concurrency_policy: String,
    output_encoding: String,
}

impl Default for TaskReliabilityPolicy {
    fn default() -> Self {
        Self {
            timeout_seconds: 0,
            retry_count: 0,
            retry_delay_seconds: 3,
            concurrency_policy: "allow".to_string(),
            output_encoding: "utf8".to_string(),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TaskRecord {
    id: Option<String>,
    kind: TaskKind,
    name: String,
    working_directory: String,
    env_vars: Vec<EnvVarEntry>,
    tags: Vec<String>,
    notes: String,
    favorite: bool,
    #[serde(default)]
    runtime_parameters: Vec<RuntimeParameterDefinition>,
    #[serde(default)]
    reliability: TaskReliabilityPolicy,
    created_at: String,
    updated_at: String,
    python: Option<PythonTaskConfig>,
    command: Option<CommandTaskConfig>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InterpreterProfile {
    id: String,
    name: String,
    r#type: InterpreterType,
    executable_path: String,
    is_default: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunRecord {
    id: String,
    task_id: Option<String>,
    task_name: String,
    status: String,
    command_preview: String,
    working_directory: String,
    started_at: String,
    finished_at: Option<String>,
    duration_ms: Option<i64>,
    exit_code: Option<i32>,
    stdout_log_path: String,
    stderr_log_path: String,
    runtime_values: HashMap<String, String>,
    attempt_count: i64,
    termination_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunOutput {
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    theme: String,
    default_interpreter_id: Option<String>,
    log_retention_days: i64,
    auto_save_editor: bool,
    confirm_before_stop: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "light".to_string(),
            default_interpreter_id: None,
            log_retention_days: 14,
            auto_save_editor: false,
            confirm_before_stop: true,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CommandImportResult {
    task: TaskRecord,
    warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InterpreterHealth {
    ok: bool,
    version: String,
    message: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BundledPythonStatus {
    available: bool,
    source: String,
    python_path: Option<String>,
    root_dir: Option<String>,
    version: String,
    message: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunStreamEvent {
    run_id: String,
    chunk: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RunStatusEvent {
    run_id: String,
    status: String,
    exit_code: Option<i32>,
    finished_at: Option<String>,
    duration_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClearRunHistoryResult {
    deleted_count: usize,
    deleted_log_count: usize,
    failed_log_count: usize,
}

#[derive(Clone)]
struct PreparedCommand {
    program: String,
    args: Vec<String>,
    working_directory: PathBuf,
    env_vars: Vec<(String, String)>,
    preview: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let state = initialize_state(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_tasks,
            save_task,
            delete_task,
            preview_task_command,
            scan_python_script,
            check_script_scan_status,
            import_command,
            list_runs,
            clear_run_history,
            read_run_output,
            get_task_runtime_values,
            start_run,
            stop_run,
            list_interpreter_profiles,
            save_interpreter_profile,
            delete_interpreter_profile,
            check_interpreter_health,
            get_bundled_python_status,
            install_bundled_python,
            get_settings,
            save_settings,
            read_text_file,
            write_text_file,
            pick_file,
            pick_directory
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn initialize_state(app: &AppHandle) -> Result<AppState, tauri::Error> {
    let app_data_dir = if let Some(path) = std::env::var_os("SCRIPT_WORKBENCH_DATA_DIR") {
        PathBuf::from(path)
    } else {
        app.path()
            .app_data_dir()
            .map_err(|err| tauri::Error::Anyhow(anyhow!(err.to_string())))?
    };
    fs::create_dir_all(&app_data_dir)
        .map_err(|err| tauri::Error::Anyhow(anyhow!(err.to_string())))?;
    let log_dir = app_data_dir.join("logs");
    fs::create_dir_all(&log_dir).map_err(|err| tauri::Error::Anyhow(anyhow!(err.to_string())))?;
    let bundled_python_dir = app_data_dir.join("bundled-python");
    fs::create_dir_all(&bundled_python_dir)
        .map_err(|err| tauri::Error::Anyhow(anyhow!(err.to_string())))?;
    let db_path = app_data_dir.join("workbench.sqlite");

    database::init_database(&db_path).map_err(|err| tauri::Error::Anyhow(err))?;
    seed_defaults(app, &db_path, &bundled_python_dir).map_err(|err| tauri::Error::Anyhow(err))?;
    cleanup_retained_runs(&db_path, &log_dir).map_err(|err| tauri::Error::Anyhow(err))?;
    recover_interrupted_runs(&db_path).map_err(|err| tauri::Error::Anyhow(err))?;

    Ok(AppState {
        db_path,
        log_dir,
        bundled_python_dir,
        running: Arc::new(Mutex::new(HashMap::new())),
        stopping: Arc::new(Mutex::new(HashMap::new())),
    })
}

fn recover_interrupted_runs(db_path: &Path) -> anyhow::Result<()> {
    let conn = Connection::open(db_path)?;
    run_recovery::recover_interrupted_runs(&conn, &now_iso())?;
    Ok(())
}

fn cleanup_retained_runs(db_path: &Path, log_dir: &Path) -> anyhow::Result<()> {
    let conn = Connection::open(db_path)?;
    let retention_days: i64 = conn
        .query_row(
            "SELECT log_retention_days FROM settings WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(14);
    let cutoff = (Utc::now() - chrono::Duration::days(retention_days.max(1))).to_rfc3339();

    let mut stmt = conn.prepare(
        "
        SELECT id, stdout_log_path, stderr_log_path
        FROM run_records
        WHERE started_at < ?1
        ",
    )?;
    let rows = stmt.query_map([cutoff], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;

    for row in rows {
        let (run_id, stdout_path, stderr_path) = row?;
        let stdout = PathBuf::from(stdout_path);
        let stderr = PathBuf::from(stderr_path);
        if stdout.starts_with(log_dir) && stdout.exists() {
            let _ = fs::remove_file(stdout);
        }
        if stderr.starts_with(log_dir) && stderr.exists() {
            let _ = fs::remove_file(stderr);
        }
        conn.execute("DELETE FROM run_records WHERE id = ?1", [run_id])?;
    }
    Ok(())
}

fn open_connection(state: &AppState) -> anyhow::Result<Connection> {
    Connection::open(&state.db_path)
        .with_context(|| format!("无法打开数据库: {}", state.db_path.display()))
}

fn seed_defaults(app: &AppHandle, db_path: &Path, bundled_python_dir: &Path) -> anyhow::Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "
        INSERT INTO settings (id, theme, default_interpreter_id, log_retention_days, auto_save_editor, confirm_before_stop)
        VALUES (1, 'light', NULL, 14, 0, 1)
        ON CONFLICT(id) DO NOTHING
        ",
        [],
    )?;

    let profile_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM interpreter_profiles", [], |row| {
            row.get(0)
        })?;

    if profile_count == 0 {
        let mut default_profile_id: Option<String> = None;
        if let Some(bundled_path) = resolve_bundled_python(app, bundled_python_dir) {
            let profile = InterpreterProfile {
                id: Uuid::new_v4().to_string(),
                name: "Bundled Python".to_string(),
                r#type: InterpreterType::Bundled,
                executable_path: bundled_path.to_string_lossy().into_owned(),
                is_default: false,
            };
            insert_interpreter_profile(&conn, &profile)?;
            default_profile_id = Some(profile.id);
        }

        if let Some(external_python) = detect_python_on_path() {
            let profile = InterpreterProfile {
                id: Uuid::new_v4().to_string(),
                name: "System Python".to_string(),
                r#type: InterpreterType::External,
                executable_path: external_python.to_string_lossy().into_owned(),
                is_default: true,
            };
            insert_interpreter_profile(&conn, &profile)?;
            default_profile_id = Some(profile.id);
        }

        if let Some(profile_id) = default_profile_id {
            conn.execute(
                "UPDATE settings SET default_interpreter_id = ?1 WHERE id = 1",
                [profile_id],
            )?;
        }
    }

    seed_default_tasks(&conn)?;

    Ok(())
}

fn resolve_bundled_python(app: &AppHandle, bundled_python_dir: &Path) -> Option<PathBuf> {
    let managed_candidate = bundled_python_dir.join("python.exe");
    if managed_candidate.exists() {
        return Some(managed_candidate);
    }

    let resolver_candidate = app
        .path()
        .resolve("python/python.exe", BaseDirectory::Resource)
        .ok();
    if let Some(path) = resolver_candidate {
        if path.exists() {
            return Some(path);
        }
    }

    let local_candidate = PathBuf::from("src-tauri")
        .join("resources")
        .join("python")
        .join("python.exe");
    if local_candidate.exists() {
        return Some(local_candidate);
    }

    None
}

fn bundled_python_status(app: &AppHandle, state: &AppState) -> BundledPythonStatus {
    let managed_candidate = state.bundled_python_dir.join("python.exe");
    if managed_candidate.exists() {
        return build_bundled_status("managed", managed_candidate);
    }

    if let Ok(path) = app
        .path()
        .resolve("python/python.exe", BaseDirectory::Resource)
    {
        if path.exists() {
            return build_bundled_status("packaged", path);
        }
    }

    let dev_candidate = PathBuf::from("src-tauri")
        .join("resources")
        .join("python")
        .join("python.exe");
    if dev_candidate.exists() {
        return build_bundled_status("development", dev_candidate);
    }

    BundledPythonStatus {
        available: false,
        source: "none".to_string(),
        python_path: None,
        root_dir: None,
        version: String::new(),
        message: "尚未安装 bundled Python".to_string(),
    }
}

fn build_bundled_status(source: &str, python_path: PathBuf) -> BundledPythonStatus {
    let version = std::process::Command::new(&python_path)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()
        .map(|output| {
            if !output.stdout.is_empty() {
                String::from_utf8_lossy(&output.stdout).trim().to_string()
            } else {
                String::from_utf8_lossy(&output.stderr).trim().to_string()
            }
        })
        .unwrap_or_default();

    BundledPythonStatus {
        available: true,
        source: source.to_string(),
        python_path: Some(python_path.to_string_lossy().into_owned()),
        root_dir: python_path
            .parent()
            .map(|path| path.to_string_lossy().into_owned()),
        version: version.clone(),
        message: if version.is_empty() {
            "已发现 bundled Python，但无法读取版本".to_string()
        } else {
            "bundled Python 可用".to_string()
        },
    }
}

fn seed_default_tasks(conn: &Connection) -> anyhow::Result<()> {
    migrate_builtin_task_templates(conn)?;
    let task_count: i64 = conn.query_row("SELECT COUNT(*) FROM tasks", [], |row| row.get(0))?;
    if task_count > 0 {
        return Ok(());
    }

    let default_interpreter_id = current_default_interpreter_id(conn)?;
    let Some(interpreter_profile_id) = default_interpreter_id else {
        return Ok(());
    };

    let now = now_iso();
    let candidates = vec![
        (
            "视频源摘要",
            PathBuf::from(r"F:\CIL\cases\hanime1-video-406871\scripts\summarize_video_sources.py"),
            r#"--watch-url https://hanime1.me/watch?v={{video_id}} --video-id {{video_id}}"#.to_string(),
            vec!["video".to_string(), "analysis".to_string()],
            "根据示例命令预置的视频摘要任务".to_string(),
            true,
        ),
        (
            "ComicBox 备份",
            PathBuf::from(r"F:\CIL\conmic\backup_comicbox_book.py"),
            r#"--book-url https://www.comicbox.xyz/book/{{book_id}} --output F:\CIL\conmic\comicbox_{{book_id}}_backup --delay 0 --workers 12 --quiet-pages"#.to_string(),
            vec!["backup".to_string(), "comic".to_string()],
            "根据示例命令预置的漫画备份任务".to_string(),
            true,
        ),
        (
            "共模脚本",
            PathBuf::from(r"F:\pycharm\python project\PythonProject4\unzipped\共模.py"),
            String::new(),
            vec!["solver".to_string()],
            "根据示例命令预置的解题脚本".to_string(),
            false,
        ),
    ];

    for (name, script_path, args_template, tags, notes, favorite) in candidates {
        if !script_path.exists() {
            continue;
        }
        let task_id = Uuid::new_v4().to_string();
        let working_directory = script_path
            .parent()
            .map(|path| path.to_string_lossy().into_owned())
            .unwrap_or_default();

        conn.execute(
            "
            INSERT INTO tasks (id, kind, name, working_directory, env_vars_json, tags_json, notes, favorite, created_at, updated_at)
            VALUES (?1, 'python_task', ?2, ?3, '[]', ?4, ?5, ?6, ?7, ?8)
            ",
            params![
                task_id.clone(),
                name,
                working_directory,
                serialize_json(&tags)?,
                notes,
                bool_to_int(favorite),
                now,
                now
            ],
        )?;
        conn.execute(
            "
            INSERT INTO python_task_configs (task_id, interpreter_profile_id, script_path, args_template)
            VALUES (?1, ?2, ?3, ?4)
            ",
            params![
                task_id,
                interpreter_profile_id,
                script_path.to_string_lossy().into_owned(),
                args_template
            ],
        )?;
    }

    Ok(())
}

fn migrate_builtin_task_templates(conn: &Connection) -> anyhow::Result<()> {
    conn.execute(
        "UPDATE python_task_configs SET args_template = '--watch-url https://hanime1.me/watch?v={{video_id}} --video-id {{video_id}}' WHERE args_template IN ('--video-id 406871', '--video-id {{video_id}}')",
        [],
    )?;
    conn.execute(
        r#"UPDATE python_task_configs
           SET args_template = '--book-url https://www.comicbox.xyz/book/{{book_id}} --output F:\CIL\conmic\comicbox_{{book_id}}_backup --delay 0 --workers 12 --quiet-pages'
           WHERE args_template = '--book-url https://www.comicbox.xyz/book/4741 --output F:\CIL\conmic\comicbox_4741_backup --delay 0 --workers 12 --quiet-pages'"#,
        [],
    )?;
    Ok(())
}

fn detect_python_on_path() -> Option<PathBuf> {
    let output = std::process::Command::new("where")
        .arg("python")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut candidates = stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    candidates.sort_by_key(|path| path.to_string_lossy().contains("WindowsApps"));
    candidates.into_iter().find(|path| path.exists())
}

fn insert_interpreter_profile(
    conn: &Connection,
    profile: &InterpreterProfile,
) -> anyhow::Result<()> {
    if profile.is_default {
        conn.execute("UPDATE interpreter_profiles SET is_default = 0", [])?;
    }
    conn.execute(
        "
        INSERT INTO interpreter_profiles (id, name, type, executable_path, is_default)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ",
        params![
            profile.id,
            profile.name,
            serialize_interpreter_type(&profile.r#type),
            profile.executable_path,
            bool_to_int(profile.is_default)
        ],
    )?;
    Ok(())
}

fn upsert_bundled_interpreter_profile(
    conn: &Connection,
    executable_path: &Path,
    prefer_default: bool,
) -> anyhow::Result<InterpreterProfile> {
    let existing_default = conn
        .query_row(
            "SELECT default_interpreter_id FROM settings WHERE id = 1",
            [],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()?
        .flatten();
    let bundled_id = conn
        .query_row(
            "SELECT id FROM interpreter_profiles WHERE type = 'bundled' LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let bundled_should_be_default = prefer_default
        || existing_default
            .as_deref()
            .map(|current| current == bundled_id)
            .unwrap_or(false)
        || existing_default.is_none();

    if bundled_should_be_default {
        conn.execute("UPDATE interpreter_profiles SET is_default = 0", [])?;
    }

    let executable_string = executable_path.to_string_lossy().into_owned();
    conn.execute(
        "
        INSERT INTO interpreter_profiles (id, name, type, executable_path, is_default)
        VALUES (?1, 'Bundled Python', 'bundled', ?2, ?3)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            type = excluded.type,
            executable_path = excluded.executable_path,
            is_default = excluded.is_default
        ",
        params![
            bundled_id,
            executable_string,
            bool_to_int(bundled_should_be_default)
        ],
    )?;

    if bundled_should_be_default {
        conn.execute(
            "UPDATE settings SET default_interpreter_id = ?1 WHERE id = 1",
            [bundled_id.clone()],
        )?;
    }

    Ok(InterpreterProfile {
        id: bundled_id,
        name: "Bundled Python".to_string(),
        r#type: InterpreterType::Bundled,
        executable_path: executable_string,
        is_default: bundled_should_be_default,
    })
}

fn remove_directory_contents(path: &Path) -> anyhow::Result<()> {
    if path.exists() {
        fs::remove_dir_all(path)?;
    }
    fs::create_dir_all(path)?;
    Ok(())
}

fn copy_directory_recursive(source: &Path, destination: &Path) -> anyhow::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let target_path = destination.join(entry.file_name());
        if path.is_dir() {
            if entry.file_name().to_string_lossy() == "__pycache__" {
                continue;
            }
            copy_directory_recursive(&path, &target_path)?;
        } else {
            fs::copy(&path, &target_path)?;
        }
    }
    Ok(())
}

fn resolve_python_installation_root(source_path: &Path) -> anyhow::Result<PathBuf> {
    let candidate = if source_path.is_file() {
        source_path
            .parent()
            .ok_or_else(|| anyhow!("无法确定 Python 安装目录"))?
            .to_path_buf()
    } else {
        source_path.to_path_buf()
    };
    let python_exe = candidate.join("python.exe");
    if !python_exe.exists() {
        return Err(anyhow!("指定路径下未找到 python.exe"));
    }
    Ok(candidate)
}

fn install_bundled_python_from_source(
    source_root: &Path,
    destination_root: &Path,
) -> anyhow::Result<PathBuf> {
    remove_directory_contents(destination_root)?;

    for file_name in [
        "python.exe",
        "pythonw.exe",
        "python3.dll",
        "python311.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
        "LICENSE.txt",
        "pyvenv.cfg",
    ] {
        let source_file = source_root.join(file_name);
        if source_file.exists() {
            fs::copy(&source_file, destination_root.join(file_name))?;
        }
    }

    for directory_name in ["DLLs", "Lib", "Scripts", "tcl"] {
        let source_dir = source_root.join(directory_name);
        if source_dir.exists() {
            copy_directory_recursive(&source_dir, &destination_root.join(directory_name))?;
        }
    }

    let python_exe = destination_root.join("python.exe");
    if !python_exe.exists() {
        return Err(anyhow!("bundled Python 安装失败，未生成 python.exe"));
    }
    Ok(python_exe)
}

fn interpreter_profile_from_row_values(
    id: String,
    name: String,
    type_value: String,
    executable_path: String,
    is_default: i64,
) -> anyhow::Result<InterpreterProfile> {
    Ok(InterpreterProfile {
        id,
        name,
        r#type: parse_interpreter_type(&type_value)?,
        executable_path,
        is_default: is_default != 0,
    })
}

fn bool_to_int(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn serialize_task_kind(kind: &TaskKind) -> &'static str {
    match kind {
        TaskKind::PythonTask => "python_task",
        TaskKind::CommandTask => "command_task",
    }
}

fn parse_task_kind(value: &str) -> anyhow::Result<TaskKind> {
    match value {
        "python_task" => Ok(TaskKind::PythonTask),
        "command_task" => Ok(TaskKind::CommandTask),
        other => Err(anyhow!("未知任务类型: {other}")),
    }
}

fn serialize_interpreter_type(value: &InterpreterType) -> &'static str {
    match value {
        InterpreterType::Bundled => "bundled",
        InterpreterType::External => "external",
    }
}

fn parse_interpreter_type(value: &str) -> anyhow::Result<InterpreterType> {
    match value {
        "bundled" => Ok(InterpreterType::Bundled),
        "external" => Ok(InterpreterType::External),
        other => Err(anyhow!("未知解释器类型: {other}")),
    }
}

fn serialize_argument_mode(value: &ArgumentMode) -> &'static str {
    match value {
        ArgumentMode::Template => "template",
        ArgumentMode::Structured => "structured",
    }
}

fn serialize_json<T: Serialize>(value: &T) -> anyhow::Result<String> {
    Ok(serde_json::to_string(value)?)
}

fn deserialize_json<T: for<'a> Deserialize<'a> + Default>(value: String) -> T {
    serde_json::from_str(&value).unwrap_or_default()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn task_template(task: &TaskRecord) -> &str {
    match task.kind {
        TaskKind::PythonTask => task
            .python
            .as_ref()
            .map(|config| config.args_template.as_str())
            .unwrap_or_default(),
        TaskKind::CommandTask => task
            .command
            .as_ref()
            .map(|config| config.command.as_str())
            .unwrap_or_default(),
    }
}

fn runtime_variables_for_task(task: &TaskRecord) -> anyhow::Result<Vec<String>> {
    if let Some(python) = task.python.as_ref() {
        if python.argument_mode == ArgumentMode::Structured {
            return Ok(task
                .runtime_parameters
                .iter()
                .map(|parameter| parameter.name.clone())
                .collect());
        }
    }
    extract_runtime_variables(task_template(task))
}

fn load_runtime_parameters(
    conn: &Connection,
    task_id: &str,
) -> anyhow::Result<Vec<RuntimeParameterDefinition>> {
    let mut stmt = conn.prepare(
        "SELECT variable_name, label, description, parameter_type, required,
                default_value, options_json, min_value, max_value, group_name,
                is_advanced, source, confidence, locked, condition_json,
                derived_template, allow_override, enabled
         FROM task_runtime_parameters WHERE task_id = ?1 ORDER BY position, variable_name",
    )?;
    let rows = stmt.query_map([task_id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, Option<f64>>(7)?,
            row.get::<_, Option<f64>>(8)?,
            row.get::<_, String>(9)?,
            row.get::<_, i64>(10)?,
            row.get::<_, String>(11)?,
            row.get::<_, String>(12)?,
            row.get::<_, i64>(13)?,
            row.get::<_, Option<String>>(14)?,
            row.get::<_, Option<String>>(15)?,
            row.get::<_, i64>(16)?,
            row.get::<_, i64>(17)?,
        ))
    })?;
    let mut parameters = Vec::new();
    for row in rows {
        let row = row?;
        let mut parameter = default_parameter(&row.0);
        parameter.label = row.1;
        parameter.description = row.2;
        parameter.parameter_type = RuntimeParameterType::parse(&row.3)?;
        parameter.required = row.4 != 0;
        parameter.default_value = row.5;
        parameter.options = deserialize_json(row.6);
        parameter.min = row.7;
        parameter.max = row.8;
        parameter.group = row.9;
        parameter.advanced = row.10 != 0;
        parameter.source = row.11;
        parameter.confidence = row.12;
        parameter.locked = row.13 != 0;
        parameter.condition = row.14.as_deref().map(serde_json::from_str).transpose()?;
        parameter.derived_template = row.15;
        parameter.allow_override = row.16 != 0;
        parameter.enabled = row.17 != 0;
        parameters.push(parameter);
    }
    Ok(parameters)
}

fn row_to_task(conn: &Connection, id: String) -> anyhow::Result<TaskRecord> {
    let mut stmt = conn.prepare(
        "
        SELECT id, kind, name, working_directory, env_vars_json, tags_json, notes, favorite, created_at, updated_at
        FROM tasks
        WHERE id = ?1
        ",
    )?;
    let task = stmt.query_row([id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, String>(9)?,
        ))
    })?;

    let python = conn
        .query_row(
            "
            SELECT interpreter_profile_id, script_path, args_template, argument_mode,
                   argument_rules_json, validation_rules_json, script_hash, scan_snapshot_json
            FROM python_task_configs
            WHERE task_id = ?1
            ",
            [task.0.clone()],
            |row| {
                let argument_mode_value = row.get::<_, String>(3)?;
                let argument_mode = match argument_mode_value.as_str() {
                    "template" => ArgumentMode::Template,
                    "structured" => ArgumentMode::Structured,
                    _ => {
                        return Err(rusqlite::Error::InvalidColumnType(
                            3,
                            argument_mode_value,
                            rusqlite::types::Type::Text,
                        ))
                    }
                };
                Ok(PythonTaskConfig {
                    interpreter_profile_id: row.get(0)?,
                    script_path: row.get(1)?,
                    args_template: row.get(2)?,
                    argument_mode,
                    argument_rules: deserialize_json(row.get(4)?),
                    validation_rules: deserialize_json(row.get(5)?),
                    script_hash: row.get(6)?,
                    scan_snapshot: row
                        .get::<_, Option<String>>(7)?
                        .and_then(|value| serde_json::from_str(&value).ok()),
                })
            },
        )
        .optional()?;

    let command = conn
        .query_row(
            "
            SELECT command_text
            FROM command_task_configs
            WHERE task_id = ?1
            ",
            [task.0.clone()],
            |row| {
                Ok(CommandTaskConfig {
                    command: row.get(0)?,
                })
            },
        )
        .optional()?;

    let reliability = conn
        .query_row(
            "SELECT timeout_seconds, retry_count, retry_delay_seconds, concurrency_policy, output_encoding
             FROM task_runtime_policies WHERE task_id = ?1",
            [task.0.clone()],
            |row| Ok(TaskReliabilityPolicy {
                timeout_seconds: row.get(0)?,
                retry_count: row.get(1)?,
                retry_delay_seconds: row.get(2)?,
                concurrency_policy: row.get(3)?,
                output_encoding: row.get(4)?,
            }),
        )
        .optional()?
        .unwrap_or_default();

    let kind = parse_task_kind(&task.1)?;
    let template = match kind {
        TaskKind::PythonTask => python
            .as_ref()
            .map(|config| config.args_template.as_str())
            .unwrap_or_default(),
        TaskKind::CommandTask => command
            .as_ref()
            .map(|config| config.command.as_str())
            .unwrap_or_default(),
    };
    let variables = if python
        .as_ref()
        .is_some_and(|config| config.argument_mode == ArgumentMode::Structured)
    {
        load_runtime_parameters(conn, &task.0)?
            .into_iter()
            .map(|parameter| parameter.name)
            .collect()
    } else {
        extract_runtime_variables(template)?
    };
    let runtime_parameters =
        synchronize_definitions(&variables, &load_runtime_parameters(conn, &task.0)?)?;

    Ok(TaskRecord {
        id: Some(task.0),
        kind,
        name: task.2,
        working_directory: task.3,
        env_vars: deserialize_json(task.4),
        tags: deserialize_json(task.5),
        notes: task.6,
        favorite: task.7 != 0,
        runtime_parameters,
        reliability,
        created_at: task.8,
        updated_at: task.9,
        python,
        command,
    })
}

fn get_task(conn: &Connection, task_id: &str) -> anyhow::Result<TaskRecord> {
    row_to_task(conn, task_id.to_string())
}

fn task_runtime_values(
    task: &TaskRecord,
    provided: &HashMap<String, String>,
) -> anyhow::Result<ResolvedRuntimeValues> {
    let variables = runtime_variables_for_task(task)?;
    let multiline_parameters: HashSet<String> = task
        .python
        .as_ref()
        .filter(|python| python.argument_mode == ArgumentMode::Structured)
        .map(|python| {
            python
                .argument_rules
                .iter()
                .filter(|rule| {
                    rule.enabled && rule.emission == structured_arguments::ArgumentEmission::Repeat
                })
                .map(|rule| rule.input_name.clone())
                .collect()
        })
        .unwrap_or_default();
    let resolved = if multiline_parameters.is_empty() {
        resolve_runtime_values(&variables, &task.runtime_parameters, provided)?
    } else {
        resolve_runtime_values_allowing_multiline(
            &variables,
            &task.runtime_parameters,
            provided,
            &multiline_parameters,
        )?
    };
    if let Some(python) = task.python.as_ref() {
        if python.argument_mode == ArgumentMode::Structured {
            validate_joint_rules(&python.validation_rules, &resolved.actual)?;
        }
    }
    Ok(resolved)
}

fn ensure_interpreter_for_path(conn: &Connection, executable_path: &str) -> anyhow::Result<String> {
    if let Some(existing_id) = conn
        .query_row(
            "SELECT id FROM interpreter_profiles WHERE executable_path = ?1 LIMIT 1",
            [executable_path],
            |row| row.get::<_, String>(0),
        )
        .optional()?
    {
        return Ok(existing_id);
    }

    let profile_id = Uuid::new_v4().to_string();
    let name = Path::new(executable_path)
        .file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or("Python")
        .to_string();
    let profile = InterpreterProfile {
        id: profile_id.clone(),
        name,
        r#type: InterpreterType::External,
        executable_path: executable_path.to_string(),
        is_default: false,
    };
    insert_interpreter_profile(conn, &profile)?;
    Ok(profile_id)
}

fn current_default_interpreter_id(conn: &Connection) -> anyhow::Result<Option<String>> {
    conn.query_row(
        "SELECT default_interpreter_id FROM settings WHERE id = 1",
        [],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(|opt| opt.flatten())
    .map_err(Into::into)
}

fn build_imported_python_task(
    conn: &Connection,
    tokens: &[String],
) -> anyhow::Result<Option<CommandImportResult>> {
    if tokens.len() < 2 {
        return Ok(None);
    }

    let executable_token = tokens[0].trim();
    let lower_executable = executable_token.to_ascii_lowercase();
    let is_python = lower_executable == "python"
        || lower_executable == "python.exe"
        || lower_executable == "py"
        || lower_executable.ends_with("\\python.exe")
        || lower_executable.ends_with("/python.exe")
        || lower_executable.ends_with("\\py.exe");

    if !is_python {
        return Ok(None);
    }

    let script_path = tokens[1].clone();
    if !script_path.to_ascii_lowercase().ends_with(".py") {
        return Ok(None);
    }

    let interpreter_profile_id = if lower_executable == "python"
        || lower_executable == "python.exe"
        || lower_executable == "py"
    {
        current_default_interpreter_id(conn)?
            .ok_or_else(|| anyhow!("未找到默认解释器，请先在设置页配置解释器"))?
    } else {
        ensure_interpreter_for_path(conn, executable_token)?
    };

    let args_template = tokens[2..]
        .iter()
        .map(|token| quote_arg(token))
        .collect::<Vec<_>>()
        .join(" ");
    let task_name = Path::new(&script_path)
        .file_stem()
        .and_then(|part| part.to_str())
        .unwrap_or("Python Task")
        .to_string();
    let working_directory = Path::new(&script_path)
        .parent()
        .map(|part| part.to_string_lossy().into_owned())
        .unwrap_or_default();
    let now = now_iso();

    Ok(Some(CommandImportResult {
        task: TaskRecord {
            id: Some(Uuid::new_v4().to_string()),
            kind: TaskKind::PythonTask,
            name: task_name,
            working_directory,
            env_vars: Vec::new(),
            tags: Vec::new(),
            notes: String::new(),
            favorite: false,
            runtime_parameters: Vec::new(),
            reliability: TaskReliabilityPolicy::default(),
            created_at: now.clone(),
            updated_at: now,
            python: Some(PythonTaskConfig {
                interpreter_profile_id,
                script_path,
                args_template,
                argument_mode: ArgumentMode::Template,
                argument_rules: Vec::new(),
                validation_rules: Vec::new(),
                script_hash: None,
                scan_snapshot: None,
            }),
            command: None,
        },
        warnings: Vec::new(),
    }))
}

fn build_imported_command_task(normalized: &str) -> CommandImportResult {
    let now = now_iso();
    let short_name = normalized
        .split_whitespace()
        .take(4)
        .collect::<Vec<_>>()
        .join(" ");
    CommandImportResult {
        task: TaskRecord {
            id: Some(Uuid::new_v4().to_string()),
            kind: TaskKind::CommandTask,
            name: short_name,
            working_directory: String::new(),
            env_vars: Vec::new(),
            tags: Vec::new(),
            notes: String::new(),
            favorite: false,
            runtime_parameters: Vec::new(),
            reliability: TaskReliabilityPolicy::default(),
            created_at: now.clone(),
            updated_at: now,
            python: None,
            command: Some(CommandTaskConfig {
                command: normalized.to_string(),
            }),
        },
        warnings: Vec::new(),
    }
}

fn resolve_interpreter_path(conn: &Connection, profile_id: &str) -> anyhow::Result<String> {
    conn.query_row(
        "
        SELECT executable_path
        FROM interpreter_profiles
        WHERE id = ?1
        ",
        [profile_id],
        |row| row.get::<_, String>(0),
    )
    .optional()?
    .ok_or_else(|| anyhow!("找不到指定解释器"))
}

fn prepare_command(
    task: &TaskRecord,
    conn: &Connection,
    runtime_values: &HashMap<String, String>,
    preview_values: &HashMap<String, String>,
) -> anyhow::Result<PreparedCommand> {
    let mut env_vars = task
        .env_vars
        .iter()
        .filter(|entry| !entry.key.trim().is_empty())
        .map(|entry| (entry.key.clone(), entry.value.clone()))
        .collect::<Vec<_>>();

    match task.kind {
        TaskKind::PythonTask => {
            let python = task
                .python
                .as_ref()
                .ok_or_else(|| anyhow!("Python 任务缺少脚本配置"))?;
            if python.interpreter_profile_id.trim().is_empty() {
                return Err(anyhow!("请选择解释器"));
            }
            if python.script_path.trim().is_empty() {
                return Err(anyhow!("请填写脚本路径"));
            }

            // Python otherwise inherits the Windows ANSI code page for redirected
            // stdout/stderr. A title containing characters outside GBK (for example
            // U+301C) would then fail inside print() before we can decode its output.
            if !env_vars
                .iter()
                .any(|(key, _)| key.eq_ignore_ascii_case("PYTHONIOENCODING"))
            {
                env_vars.push(("PYTHONIOENCODING".to_string(), "utf-8".to_string()));
            }

            let executable = resolve_interpreter_path(conn, &python.interpreter_profile_id)?;
            let mut args = vec!["-u".to_string(), python.script_path.clone()];
            let mut preview_args = args.clone();
            if python.argument_mode == ArgumentMode::Structured {
                args.extend(build_structured_arguments(
                    &python.argument_rules,
                    runtime_values,
                )?);
                preview_args.extend(build_structured_arguments(
                    &python.argument_rules,
                    preview_values,
                )?);
            } else {
                let template_args = tokenize_command_line(&python.args_template)?;
                for argument in template_args {
                    args.push(apply_runtime_values(&argument, runtime_values)?);
                    preview_args.push(apply_runtime_values(&argument, preview_values)?);
                }
            }
            let preview = join_command(&executable, &preview_args);
            let working_directory = if !task.working_directory.trim().is_empty() {
                PathBuf::from(&task.working_directory)
            } else {
                Path::new(&python.script_path)
                    .parent()
                    .map(|path| path.to_path_buf())
                    .unwrap_or(std::env::current_dir()?)
            };

            Ok(PreparedCommand {
                program: executable,
                args,
                working_directory,
                env_vars,
                preview,
            })
        }
        TaskKind::CommandTask => {
            let command = task
                .command
                .as_ref()
                .ok_or_else(|| anyhow!("命令任务缺少完整命令"))?;
            if command.command.trim().is_empty() {
                return Err(anyhow!("请输入完整命令"));
            }
            let working_directory = if !task.working_directory.trim().is_empty() {
                PathBuf::from(&task.working_directory)
            } else {
                std::env::current_dir()?
            };
            let resolved_command = apply_command_runtime_values(&command.command, runtime_values)?;
            let preview = apply_command_runtime_values(&command.command, preview_values)?;
            Ok(PreparedCommand {
                program: "cmd".to_string(),
                args: vec!["/C".to_string(), resolved_command],
                working_directory,
                env_vars,
                preview,
            })
        }
    }
}

async fn stream_reader<R: AsyncRead + Unpin, T: tauri::Runtime>(
    mut reader: R,
    log_path: PathBuf,
    app: AppHandle<T>,
    run_id: String,
    event_name: &'static str,
    output_encoding: String,
) -> anyhow::Result<()> {
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .await?;
    let mut decoder = OutputDecoder::new(&output_encoding);
    let mut buffer = [0_u8; 4096];
    loop {
        let bytes = reader.read(&mut buffer).await?;
        if bytes == 0 {
            let tail = decoder.decode(&[], true);
            if !tail.is_empty() {
                file.write_all(tail.as_bytes()).await?;
                let _ = app.emit(
                    event_name,
                    RunStreamEvent {
                        run_id: run_id.clone(),
                        chunk: tail,
                    },
                );
            }
            break;
        }
        let chunk = decoder.decode(&buffer[..bytes], false);
        if chunk.is_empty() {
            continue;
        }
        file.write_all(chunk.as_bytes()).await?;
        let _ = app.emit(
            event_name,
            RunStreamEvent {
                run_id: run_id.clone(),
                chunk,
            },
        );
    }
    Ok(())
}

fn update_run_completion(
    db_path: PathBuf,
    run_id: &str,
    status: &str,
    exit_code: Option<i32>,
    finished_at: &str,
    duration_ms: i64,
    attempt_count: i64,
    termination_reason: Option<&str>,
) -> anyhow::Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "
        UPDATE run_records
        SET status = ?1,
            exit_code = ?2,
            finished_at = ?3,
            duration_ms = ?4,
            attempt_count = ?5,
            termination_reason = ?6
        WHERE id = ?7
        ",
        params![
            status,
            exit_code,
            finished_at,
            duration_ms,
            attempt_count,
            termination_reason,
            run_id
        ],
    )?;
    Ok(())
}

fn update_run_attempt(db_path: &Path, run_id: &str, attempt_count: i64) -> anyhow::Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute(
        "UPDATE run_records SET attempt_count = ?1 WHERE id = ?2",
        params![attempt_count, run_id],
    )?;
    Ok(())
}

fn spawn_prepared_command(prepared: &PreparedCommand) -> anyhow::Result<tokio::process::Child> {
    let mut command = tokio::process::Command::new(&prepared.program);
    command
        .args(&prepared.args)
        .current_dir(&prepared.working_directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    for (key, value) in &prepared.env_vars {
        command.env(key, value);
    }
    command.spawn().map_err(Into::into)
}

#[derive(Debug)]
enum AttemptOutcome {
    Exited(Option<i32>),
    TimedOut,
    WaitFailed,
}

async fn wait_for_attempt(
    child: &mut tokio::process::Child,
    tree: &ProcessTree,
    timeout_seconds: u64,
) -> AttemptOutcome {
    if timeout_seconds == 0 {
        return match child.wait().await {
            Ok(exit) => AttemptOutcome::Exited(exit.code()),
            Err(_) => AttemptOutcome::WaitFailed,
        };
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_seconds),
        child.wait(),
    )
    .await
    {
        Ok(Ok(exit)) => AttemptOutcome::Exited(exit.code()),
        Ok(Err(_)) => AttemptOutcome::WaitFailed,
        Err(_) => {
            let _ = tree.terminate();
            let _ = child.wait().await;
            AttemptOutcome::TimedOut
        }
    }
}

async fn monitor_attempt<T: tauri::Runtime>(
    mut child: tokio::process::Child,
    tree: Arc<ProcessTree>,
    stdout_path: PathBuf,
    stderr_path: PathBuf,
    app: AppHandle<T>,
    run_id: String,
    output_encoding: String,
    timeout_seconds: u64,
) -> AttemptOutcome {
    let stdout_handle = child.stdout.take().map(|pipe| {
        tokio::spawn(stream_reader(
            pipe,
            stdout_path,
            app.clone(),
            run_id.clone(),
            "run://stdout",
            output_encoding.clone(),
        ))
    });
    let stderr_handle = child.stderr.take().map(|pipe| {
        tokio::spawn(stream_reader(
            pipe,
            stderr_path,
            app,
            run_id,
            "run://stderr",
            output_encoding,
        ))
    });

    let outcome = wait_for_attempt(&mut child, &tree, timeout_seconds).await;
    if let Some(handle) = stdout_handle {
        let _ = handle.await;
    }
    if let Some(handle) = stderr_handle {
        let _ = handle.await;
    }
    outcome
}

fn read_run_record(conn: &Connection, run_id: &str) -> anyhow::Result<RunRecord> {
    conn.query_row(
        "
        SELECT id, task_id, task_name_snapshot, status, command_preview, working_directory,
               started_at, finished_at, duration_ms, exit_code, stdout_log_path, stderr_log_path,
               runtime_values_json, attempt_count, termination_reason
        FROM run_records
        WHERE id = ?1
        ",
        [run_id],
        |row| {
            Ok(RunRecord {
                id: row.get(0)?,
                task_id: row.get(1)?,
                task_name: row.get(2)?,
                status: row.get(3)?,
                command_preview: row.get(4)?,
                working_directory: row.get(5)?,
                started_at: row.get(6)?,
                finished_at: row.get(7)?,
                duration_ms: row.get(8)?,
                exit_code: row.get(9)?,
                stdout_log_path: row.get(10)?,
                stderr_log_path: row.get(11)?,
                runtime_values: serde_json::from_str(&row.get::<_, String>(12)?)
                    .unwrap_or_default(),
                attempt_count: row.get(13)?,
                termination_reason: row.get(14)?,
            })
        },
    )
    .map_err(Into::into)
}

#[tauri::command]
fn list_tasks(state: State<'_, AppState>) -> Result<Vec<TaskRecord>, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id FROM tasks ORDER BY favorite DESC, updated_at DESC")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|err| err.to_string())?;

    let mut tasks = Vec::new();
    for row in rows {
        tasks.push(
            row_to_task(&conn, row.map_err(|err| err.to_string())?)
                .map_err(|err| err.to_string())?,
        );
    }
    Ok(tasks)
}

#[tauri::command]
fn save_task(state: State<'_, AppState>, task: TaskRecord) -> Result<TaskRecord, String> {
    if task.name.trim().is_empty() {
        return Err("任务名称不能为空".to_string());
    }

    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let task_id = task
        .id
        .clone()
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    let existing_created_at = conn
        .query_row(
            "SELECT created_at FROM tasks WHERE id = ?1",
            [task_id.clone()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|err| err.to_string())?;
    let created_at = existing_created_at.unwrap_or_else(now_iso);
    let updated_at = now_iso();
    let reliability = task.reliability.clone();
    if reliability.timeout_seconds > 604_800 {
        return Err("任务超时不能超过 7 天".to_string());
    }
    if reliability.retry_count > 10 {
        return Err("失败重试次数不能超过 10 次".to_string());
    }
    if reliability.retry_delay_seconds > 86_400 {
        return Err("重试间隔不能超过 24 小时".to_string());
    }
    if !matches!(
        reliability.concurrency_policy.as_str(),
        "allow" | "reject" | "stop_existing"
    ) {
        return Err("未知的并发策略".to_string());
    }
    if !matches!(reliability.output_encoding.as_str(), "utf8" | "gbk") {
        return Err("未知的输出编码".to_string());
    }

    match task.kind {
        TaskKind::PythonTask => {
            let python = task
                .python
                .as_ref()
                .ok_or_else(|| "Python 任务缺少脚本配置".to_string())?;
            if python.interpreter_profile_id.trim().is_empty() {
                return Err("Python 任务必须选择解释器".to_string());
            }
            if python.script_path.trim().is_empty() {
                return Err("Python 任务必须填写脚本路径".to_string());
            }
        }
        TaskKind::CommandTask => {
            let command = task
                .command
                .as_ref()
                .ok_or_else(|| "命令任务缺少命令内容".to_string())?;
            if command.command.trim().is_empty() {
                return Err("命令任务必须填写完整命令".to_string());
            }
        }
    }

    let runtime_variables = runtime_variables_for_task(&task).map_err(|err| err.to_string())?;
    let runtime_parameters = synchronize_definitions(&runtime_variables, &task.runtime_parameters)
        .map_err(|err| err.to_string())?;

    conn.execute(
        "
        INSERT INTO tasks (id, kind, name, working_directory, env_vars_json, tags_json, notes, favorite, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            name = excluded.name,
            working_directory = excluded.working_directory,
            env_vars_json = excluded.env_vars_json,
            tags_json = excluded.tags_json,
            notes = excluded.notes,
            favorite = excluded.favorite,
            updated_at = excluded.updated_at
        ",
        params![
            task_id,
            serialize_task_kind(&task.kind),
            task.name,
            task.working_directory,
            serialize_json(&task.env_vars).map_err(|err| err.to_string())?,
            serialize_json(&task.tags).map_err(|err| err.to_string())?,
            task.notes,
            bool_to_int(task.favorite),
            created_at,
            updated_at
        ],
    )
    .map_err(|err| err.to_string())?;

    conn.execute(
        "INSERT INTO task_runtime_policies (
            task_id, timeout_seconds, retry_count, retry_delay_seconds, concurrency_policy, output_encoding
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(task_id) DO UPDATE SET
            timeout_seconds=excluded.timeout_seconds,
            retry_count=excluded.retry_count,
            retry_delay_seconds=excluded.retry_delay_seconds,
            concurrency_policy=excluded.concurrency_policy,
            output_encoding=excluded.output_encoding",
        params![task_id.clone(), reliability.timeout_seconds, reliability.retry_count,
            reliability.retry_delay_seconds, reliability.concurrency_policy, reliability.output_encoding],
    ).map_err(|err| err.to_string())?;

    conn.execute(
        "DELETE FROM task_runtime_parameters WHERE task_id = ?1",
        [task_id.clone()],
    )
    .map_err(|err| err.to_string())?;
    for (position, parameter) in runtime_parameters.iter().enumerate() {
        conn.execute(
            "INSERT INTO task_runtime_parameters (
                task_id, variable_name, label, description, parameter_type, required,
                default_value, options_json, min_value, max_value, group_name, is_advanced,
                source, confidence, locked, condition_json, derived_template,
                allow_override, enabled, position
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                task_id.clone(),
                parameter.name,
                parameter.label,
                parameter.description,
                parameter.parameter_type.as_str(),
                bool_to_int(parameter.required),
                parameter.default_value,
                serialize_json(&parameter.options).map_err(|err| err.to_string())?,
                parameter.min,
                parameter.max,
                parameter.group,
                bool_to_int(parameter.advanced),
                parameter.source,
                parameter.confidence,
                bool_to_int(parameter.locked),
                parameter
                    .condition
                    .as_ref()
                    .map(serialize_json)
                    .transpose()
                    .map_err(|err| err.to_string())?,
                parameter.derived_template,
                bool_to_int(parameter.allow_override),
                bool_to_int(parameter.enabled),
                position as i64,
            ],
        )
        .map_err(|err| err.to_string())?;
        if parameter.parameter_type == RuntimeParameterType::Secret {
            conn.execute(
                "DELETE FROM task_runtime_values WHERE task_id = ?1 AND variable_name = ?2",
                params![task_id.clone(), parameter.name],
            )
            .map_err(|err| err.to_string())?;
        }
    }

    conn.execute(
        "DELETE FROM python_task_configs WHERE task_id = ?1",
        [task_id.clone()],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM command_task_configs WHERE task_id = ?1",
        [task_id.clone()],
    )
    .map_err(|err| err.to_string())?;

    match task.kind {
        TaskKind::PythonTask => {
            let python = task
                .python
                .ok_or_else(|| "Python 任务缺少配置".to_string())?;
            conn.execute(
                "
                INSERT INTO python_task_configs (
                    task_id, interpreter_profile_id, script_path, args_template,
                    argument_mode, argument_rules_json, validation_rules_json,
                    script_hash, scan_snapshot_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                ",
                params![
                    task_id.clone(),
                    python.interpreter_profile_id,
                    python.script_path,
                    python.args_template,
                    serialize_argument_mode(&python.argument_mode),
                    serialize_json(&python.argument_rules).map_err(|err| err.to_string())?,
                    serialize_json(&python.validation_rules).map_err(|err| err.to_string())?,
                    python.script_hash,
                    python
                        .scan_snapshot
                        .as_ref()
                        .map(serialize_json)
                        .transpose()
                        .map_err(|err| err.to_string())?
                ],
            )
            .map_err(|err| err.to_string())?;
        }
        TaskKind::CommandTask => {
            let command = task.command.ok_or_else(|| "命令任务缺少配置".to_string())?;
            conn.execute(
                "
                INSERT INTO command_task_configs (task_id, command_text)
                VALUES (?1, ?2)
                ",
                params![task_id.clone(), command.command],
            )
            .map_err(|err| err.to_string())?;
        }
    }

    row_to_task(&conn, task_id).map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_task(state: State<'_, AppState>, task_id: String) -> Result<(), String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM python_task_configs WHERE task_id = ?1",
        [task_id.clone()],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM command_task_configs WHERE task_id = ?1",
        [task_id.clone()],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM task_runtime_values WHERE task_id = ?1",
        [task_id.clone()],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM task_runtime_policies WHERE task_id = ?1",
        [task_id.clone()],
    )
    .map_err(|err| err.to_string())?;
    conn.execute(
        "DELETE FROM task_runtime_parameters WHERE task_id = ?1",
        [task_id.clone()],
    )
    .map_err(|err| err.to_string())?;
    conn.execute("DELETE FROM tasks WHERE id = ?1", [task_id])
        .map_err(|err| err.to_string())?;
    Ok(())
}

#[tauri::command]
fn preview_task_command(
    state: State<'_, AppState>,
    task: TaskRecord,
    runtime_values: HashMap<String, String>,
) -> Result<String, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let resolved = task_runtime_values(&task, &runtime_values).map_err(|err| err.to_string())?;
    prepare_command(&task, &conn, &resolved.actual, &resolved.redacted)
        .map(|command| command.preview)
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn scan_python_script(
    state: State<'_, AppState>,
    script_path: String,
    interpreter_profile_id: String,
    args_template: String,
    allow_help: bool,
) -> Result<ScriptScanPreview, String> {
    let interpreter = {
        let conn = open_connection(&state).map_err(|err| err.to_string())?;
        resolve_interpreter_path(&conn, &interpreter_profile_id).map_err(|err| err.to_string())?
    };
    python_scanner::scan_python_script_impl(
        &interpreter,
        Path::new(&script_path),
        &args_template,
        allow_help,
    )
    .await
    .map_err(|err| err.to_string())
}

#[tauri::command]
async fn check_script_scan_status(
    state: State<'_, AppState>,
    script_path: String,
    interpreter_profile_id: String,
    args_template: String,
    script_hash: Option<String>,
    scan_snapshot: Option<serde_json::Value>,
) -> Result<ScriptScanStatus, String> {
    let path = Path::new(&script_path);
    if !path.is_file() {
        return Ok(ScriptScanStatus {
            status: "missing".to_string(),
            current_hash: None,
            ..ScriptScanStatus::default()
        });
    }
    let current_hash = python_scanner::script_hash(path).map_err(|err| err.to_string())?;
    if script_hash.as_deref() == Some(current_hash.as_str()) {
        return Ok(ScriptScanStatus {
            status: "unchanged".to_string(),
            current_hash: Some(current_hash),
            ..ScriptScanStatus::default()
        });
    }
    if script_hash.is_none() {
        return Ok(ScriptScanStatus {
            status: "not_scanned".to_string(),
            current_hash: Some(current_hash),
            ..ScriptScanStatus::default()
        });
    }
    let interpreter = {
        let conn = open_connection(&state).map_err(|err| err.to_string())?;
        resolve_interpreter_path(&conn, &interpreter_profile_id).map_err(|err| err.to_string())?
    };
    let preview =
        python_scanner::scan_python_script_impl(&interpreter, path, &args_template, false)
            .await
            .map_err(|err| err.to_string())?;
    let diff = python_scanner::compare_scan_snapshots(scan_snapshot.as_ref(), &preview);
    Ok(ScriptScanStatus {
        status: "changed".to_string(),
        current_hash: Some(current_hash),
        diff,
        preview: Some(preview),
    })
}

#[tauri::command]
fn import_command(
    state: State<'_, AppState>,
    command_text: String,
) -> Result<CommandImportResult, String> {
    let normalized = normalize_command(&command_text);
    if normalized.trim().is_empty() {
        return Err("请输入要导入的命令".to_string());
    }
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let tokens = tokenize_command_line(&normalized).map_err(|err| err.to_string())?;

    if let Some(result) =
        build_imported_python_task(&conn, &tokens).map_err(|err| err.to_string())?
    {
        return Ok(result);
    }

    Ok(build_imported_command_task(&normalized))
}

#[tauri::command]
fn list_runs(state: State<'_, AppState>) -> Result<Vec<RunRecord>, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "
            SELECT id, task_id, task_name_snapshot, status, command_preview, working_directory,
                   started_at, finished_at, duration_ms, exit_code, stdout_log_path, stderr_log_path,
                    runtime_values_json, attempt_count, termination_reason
            FROM run_records
            ORDER BY started_at DESC
            ",
        )
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RunRecord {
                id: row.get(0)?,
                task_id: row.get(1)?,
                task_name: row.get(2)?,
                status: row.get(3)?,
                command_preview: row.get(4)?,
                working_directory: row.get(5)?,
                started_at: row.get(6)?,
                finished_at: row.get(7)?,
                duration_ms: row.get(8)?,
                exit_code: row.get(9)?,
                stdout_log_path: row.get(10)?,
                stderr_log_path: row.get(11)?,
                runtime_values: serde_json::from_str(&row.get::<_, String>(12)?)
                    .unwrap_or_default(),
                attempt_count: row.get(13)?,
                termination_reason: row.get(14)?,
            })
        })
        .map_err(|err| err.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|err| err.to_string())
}

fn delete_completed_run_records(conn: &Connection) -> anyhow::Result<(usize, Vec<PathBuf>)> {
    let transaction = conn.unchecked_transaction()?;
    let log_paths = {
        let mut statement = transaction.prepare(
            "SELECT stdout_log_path, stderr_log_path FROM run_records WHERE status <> 'running'",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut paths = Vec::new();
        for row in rows {
            let (stdout_path, stderr_path) = row?;
            paths.push(PathBuf::from(stdout_path));
            paths.push(PathBuf::from(stderr_path));
        }
        paths
    };
    let deleted_count =
        transaction.execute("DELETE FROM run_records WHERE status <> 'running'", [])?;
    transaction.commit()?;
    Ok((deleted_count, log_paths))
}

#[tauri::command]
fn clear_run_history(state: State<'_, AppState>) -> Result<ClearRunHistoryResult, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let (deleted_count, log_paths) =
        delete_completed_run_records(&conn).map_err(|err| err.to_string())?;
    let mut deleted_log_count = 0;
    let mut failed_log_count = 0;
    let mut unique_paths = HashSet::new();

    for path in log_paths {
        if !unique_paths.insert(path.clone()) {
            continue;
        }
        if path.parent() != Some(state.log_dir.as_path()) {
            failed_log_count += 1;
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => deleted_log_count += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => failed_log_count += 1,
        }
    }

    Ok(ClearRunHistoryResult {
        deleted_count,
        deleted_log_count,
        failed_log_count,
    })
}

#[tauri::command]
fn read_run_output(state: State<'_, AppState>, run_id: String) -> Result<RunOutput, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let run = read_run_record(&conn, &run_id).map_err(|err| err.to_string())?;
    let stdout = fs::read_to_string(&run.stdout_log_path).unwrap_or_default();
    let stderr = fs::read_to_string(&run.stderr_log_path).unwrap_or_default();
    Ok(RunOutput { stdout, stderr })
}

#[tauri::command]
fn get_task_runtime_values(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<HashMap<String, String>, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare("SELECT variable_name, value FROM task_runtime_values WHERE task_id = ?1")
        .map_err(|err| err.to_string())?;
    let rows = stmt
        .query_map([task_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|err| err.to_string())?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|err| err.to_string())
}

#[tauri::command]
async fn start_run(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    runtime_values: HashMap<String, String>,
) -> Result<RunRecord, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let task = get_task(&conn, &task_id).map_err(|err| err.to_string())?;
    let resolved_runtime_values =
        task_runtime_values(&task, &runtime_values).map_err(|err| err.to_string())?;
    let prepared = prepare_command(
        &task,
        &conn,
        &resolved_runtime_values.actual,
        &resolved_runtime_values.redacted,
    )
    .map_err(|err| err.to_string())?;
    let active_runs = state
        .running
        .lock()
        .map_err(|_| "运行状态锁已损坏".to_string())?
        .iter()
        .filter(|(_, process)| process.task_id == task_id)
        .map(|(run_id, process)| (run_id.clone(), process.clone()))
        .collect::<Vec<_>>();
    match concurrency_action(&task.reliability.concurrency_policy, active_runs.len()) {
        ConcurrencyAction::Reject => {
            return Err("该任务已有运行实例，并发策略已拒绝本次启动".to_string());
        }
        ConcurrencyAction::StopExisting => {
            for (existing_run_id, process) in active_runs {
                state
                    .stopping
                    .lock()
                    .map_err(|_| "停止状态锁已损坏".to_string())?
                    .insert(existing_run_id, "concurrency_replaced".to_string());
                process.tree.terminate().map_err(|err| err.to_string())?;
            }
        }
        ConcurrencyAction::Proceed => {}
    }
    let run_id = Uuid::new_v4().to_string();
    let started_at = now_iso();
    let stdout_log_path = state.log_dir.join(format!("{run_id}-stdout.log"));
    let stderr_log_path = state.log_dir.join(format!("{run_id}-stderr.log"));
    let stdout_log_string = stdout_log_path.to_string_lossy().into_owned();
    let stderr_log_string = stderr_log_path.to_string_lossy().into_owned();
    let runtime_values_json =
        serde_json::to_string(&resolved_runtime_values.persisted).map_err(|err| err.to_string())?;

    conn.execute(
        "
        INSERT INTO run_records (
            id, task_id, task_name_snapshot, status, command_preview, working_directory,
            started_at, finished_at, duration_ms, exit_code, stdout_log_path, stderr_log_path,
            runtime_values_json
        )
        VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, NULL, NULL, NULL, ?7, ?8, ?9)
        ",
        params![
            run_id,
            task.id.clone(),
            task.name.clone(),
            prepared.preview.clone(),
            prepared.working_directory.to_string_lossy().into_owned(),
            started_at,
            stdout_log_string,
            stderr_log_string,
            runtime_values_json
        ],
    )
    .map_err(|err| err.to_string())?;

    if let Some(saved_task_id) = &task.id {
        conn.execute(
            "DELETE FROM task_runtime_values WHERE task_id = ?1",
            [saved_task_id],
        )
        .map_err(|err| err.to_string())?;
        for (variable_name, value) in &resolved_runtime_values.persisted {
            conn.execute(
                "INSERT INTO task_runtime_values (task_id, variable_name, value, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(task_id, variable_name) DO UPDATE SET
                    value = excluded.value, updated_at = excluded.updated_at",
                params![saved_task_id, variable_name, value, started_at],
            )
            .map_err(|err| err.to_string())?;
        }
    }

    let mut child = match spawn_prepared_command(&prepared) {
        Ok(child) => child,
        Err(error) => {
            let diagnostic = format!("[Script Workbench] 进程启动失败: {error}\n");
            let _ = fs::write(&stderr_log_path, diagnostic.as_bytes());
            let finished_at = now_iso();
            conn.execute(
                "UPDATE run_records SET status='failed', finished_at=?1, duration_ms=0,
                 termination_reason='spawn_failed' WHERE id=?2",
                params![finished_at, run_id],
            )
            .map_err(|db_error| db_error.to_string())?;
            return Err(diagnostic.trim().to_string());
        }
    };
    let pid = match child.id() {
        Some(pid) => pid,
        None => {
            let _ = child.kill().await;
            let finished_at = now_iso();
            let _ = conn.execute(
                "UPDATE run_records SET status='failed', finished_at=?1, duration_ms=0,
                 termination_reason='pid_unavailable' WHERE id=?2",
                params![finished_at, run_id],
            );
            return Err("无法获取进程 PID".to_string());
        }
    };
    let tree = match ProcessTree::attach(&child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill().await;
            let finished_at = now_iso();
            let _ = conn.execute(
                "UPDATE run_records SET status='failed', finished_at=?1, duration_ms=0,
                 termination_reason='job_attach_failed' WHERE id=?2",
                params![finished_at, run_id],
            );
            return Err(error.to_string());
        }
    };
    state
        .running
        .lock()
        .map_err(|_| "运行状态锁已损坏".to_string())?
        .insert(
            run_id.clone(),
            RunningProcess {
                pid,
                task_id: task_id.clone(),
                tree: tree.clone(),
            },
        );
    let _ = app.emit(
        "run://status",
        RunStatusEvent {
            run_id: run_id.clone(),
            status: "running".to_string(),
            exit_code: None,
            finished_at: None,
            duration_ms: None,
        },
    );

    let app_handle = app.clone();
    let db_path = state.db_path.clone();
    let running = state.running.clone();
    let stopping = state.stopping.clone();
    let run_id_for_task = run_id.clone();
    let started_at_for_task = started_at.clone();
    let output_encoding = task.reliability.output_encoding.clone();
    let timeout_seconds = task.reliability.timeout_seconds;
    let retry_count = task.reliability.retry_count;
    let retry_delay_seconds = task.reliability.retry_delay_seconds;
    let prepared_for_task = prepared.clone();
    let task_id_for_task = task_id.clone();
    let stdout_path = stdout_log_path.clone();
    let stderr_path = stderr_log_path.clone();

    tauri::async_runtime::spawn(async move {
        let mut attempt_count = 1_i64;
        let mut current_child = child;
        let mut current_tree = tree;
        let final_result: (String, Option<i32>, Option<String>);

        loop {
            let outcome = monitor_attempt(
                current_child,
                current_tree,
                stdout_path.clone(),
                stderr_path.clone(),
                app_handle.clone(),
                run_id_for_task.clone(),
                output_encoding.clone(),
                timeout_seconds,
            )
            .await;
            let stop_reason = stopping
                .lock()
                .ok()
                .and_then(|set| set.get(&run_id_for_task).cloned());
            let was_stopping = stop_reason.is_some();
            let observed_exit_code = match outcome {
                AttemptOutcome::Exited(code) => code,
                AttemptOutcome::TimedOut | AttemptOutcome::WaitFailed => None,
            };
            let succeeded = matches!(outcome, AttemptOutcome::Exited(Some(0)));

            if !succeeded
                && runtime_policy::should_retry(attempt_count as u32, retry_count, was_stopping)
            {
                attempt_count += 1;
                let message = format!(
                    "[Script Workbench] 第 {} 次尝试失败，{} 秒后进行第 {} 次尝试。\n",
                    attempt_count - 1,
                    retry_delay_seconds,
                    attempt_count
                );
                if let Ok(mut file) = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&stderr_path)
                    .await
                {
                    let _ = file.write_all(message.as_bytes()).await;
                }
                let _ = app_handle.emit(
                    "run://stderr",
                    RunStreamEvent {
                        run_id: run_id_for_task.clone(),
                        chunk: message,
                    },
                );
                let _ = update_run_attempt(&db_path, &run_id_for_task, attempt_count);
                tokio::time::sleep(std::time::Duration::from_secs(retry_delay_seconds)).await;

                match spawn_prepared_command(&prepared_for_task) {
                    Ok(mut next_child) => {
                        let pid = match next_child.id() {
                            Some(pid) => pid,
                            None => {
                                let _ = next_child.kill().await;
                                final_result = (
                                    "failed".to_string(),
                                    None,
                                    Some("retry_pid_unavailable".to_string()),
                                );
                                break;
                            }
                        };
                        match ProcessTree::attach(&next_child) {
                            Ok(next_tree) => {
                                if let Ok(mut map) = running.lock() {
                                    map.insert(
                                        run_id_for_task.clone(),
                                        RunningProcess {
                                            pid,
                                            task_id: task_id_for_task.clone(),
                                            tree: next_tree.clone(),
                                        },
                                    );
                                }
                                current_child = next_child;
                                current_tree = next_tree;
                                continue;
                            }
                            Err(error) => {
                                let _ = next_child.kill().await;
                                let message =
                                    format!("[Script Workbench] 重试进程托管失败: {error}\n");
                                if let Ok(mut file) = OpenOptions::new()
                                    .create(true)
                                    .append(true)
                                    .open(&stderr_path)
                                    .await
                                {
                                    let _ = file.write_all(message.as_bytes()).await;
                                }
                                final_result = (
                                    "failed".to_string(),
                                    None,
                                    Some("retry_job_attach_failed".to_string()),
                                );
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        let message = format!("[Script Workbench] 重试进程启动失败: {error}\n");
                        if let Ok(mut file) = OpenOptions::new()
                            .create(true)
                            .append(true)
                            .open(&stderr_path)
                            .await
                        {
                            let _ = file.write_all(message.as_bytes()).await;
                        }
                        final_result = (
                            "failed".to_string(),
                            None,
                            Some("retry_spawn_failed".to_string()),
                        );
                        break;
                    }
                }
            }

            final_result = if was_stopping {
                ("stopped".to_string(), observed_exit_code, stop_reason)
            } else {
                match outcome {
                    AttemptOutcome::Exited(Some(0)) => ("finished".to_string(), Some(0), None),
                    AttemptOutcome::Exited(code) => (
                        "failed".to_string(),
                        code,
                        Some("non_zero_exit".to_string()),
                    ),
                    AttemptOutcome::TimedOut => {
                        ("timed_out".to_string(), None, Some("timeout".to_string()))
                    }
                    AttemptOutcome::WaitFailed => {
                        ("failed".to_string(), None, Some("wait_failed".to_string()))
                    }
                }
            };
            break;
        }

        let finished_at = now_iso();
        let start_time = chrono::DateTime::parse_from_rfc3339(&started_at_for_task)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        let finish_time = chrono::DateTime::parse_from_rfc3339(&finished_at)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        let duration_ms = (finish_time - start_time).num_milliseconds();
        let (status, exit_code, termination_reason) = final_result;

        if let Ok(mut running_map) = running.lock() {
            running_map.remove(&run_id_for_task);
        }
        if let Ok(mut stopping_set) = stopping.lock() {
            stopping_set.remove(&run_id_for_task);
        }
        let _ = update_run_completion(
            db_path,
            &run_id_for_task,
            &status,
            exit_code,
            &finished_at,
            duration_ms,
            attempt_count,
            termination_reason.as_deref(),
        );
        let _ = app_handle.emit(
            "run://status",
            RunStatusEvent {
                run_id: run_id_for_task,
                status,
                exit_code,
                finished_at: Some(finished_at),
                duration_ms: Some(duration_ms),
            },
        );
    });

    read_run_record(&conn, &run_id).map_err(|err| err.to_string())
}

#[tauri::command]
fn stop_run(state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    let process = state
        .running
        .lock()
        .map_err(|_| "运行状态锁已损坏".to_string())?
        .get(&run_id)
        .cloned()
        .ok_or_else(|| "找不到正在运行的任务".to_string())?;
    state
        .stopping
        .lock()
        .map_err(|_| "停止状态锁已损坏".to_string())?
        .insert(run_id.clone(), "user_stop".to_string());

    if let Err(error) = process.tree.terminate() {
        if let Ok(mut stopping) = state.stopping.lock() {
            stopping.remove(&run_id);
        }
        return Err(format!("停止进程树失败（PID {}）: {error}", process.pid));
    }
    Ok(())
}

#[tauri::command]
fn list_interpreter_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<InterpreterProfile>, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let mut stmt = conn
        .prepare(
            "
            SELECT id, name, type, executable_path, is_default
            FROM interpreter_profiles
            ORDER BY is_default DESC, name ASC
            ",
        )
        .map_err(|err| err.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })
        .map_err(|err| err.to_string())?;
    let mut profiles = Vec::new();
    for row in rows {
        let (id, name, type_value, executable_path, is_default) =
            row.map_err(|err| err.to_string())?;
        profiles.push(
            interpreter_profile_from_row_values(id, name, type_value, executable_path, is_default)
                .map_err(|err| err.to_string())?,
        );
    }
    Ok(profiles)
}

#[tauri::command]
fn save_interpreter_profile(
    state: State<'_, AppState>,
    profile: InterpreterProfile,
) -> Result<InterpreterProfile, String> {
    if profile.name.trim().is_empty() {
        return Err("解释器名称不能为空".to_string());
    }
    if profile.executable_path.trim().is_empty() {
        return Err("解释器路径不能为空".to_string());
    }

    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let profile_id = if profile.id.trim().is_empty() {
        Uuid::new_v4().to_string()
    } else {
        profile.id.clone()
    };

    if profile.is_default {
        conn.execute("UPDATE interpreter_profiles SET is_default = 0", [])
            .map_err(|err| err.to_string())?;
    }

    conn.execute(
        "
        INSERT INTO interpreter_profiles (id, name, type, executable_path, is_default)
        VALUES (?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            type = excluded.type,
            executable_path = excluded.executable_path,
            is_default = excluded.is_default
        ",
        params![
            profile_id,
            profile.name,
            serialize_interpreter_type(&profile.r#type),
            profile.executable_path,
            bool_to_int(profile.is_default)
        ],
    )
    .map_err(|err| err.to_string())?;

    if profile.is_default {
        conn.execute(
            "UPDATE settings SET default_interpreter_id = ?1 WHERE id = 1",
            [profile_id.clone()],
        )
        .map_err(|err| err.to_string())?;
    }

    let row = conn
        .query_row(
            "
        SELECT id, name, type, executable_path, is_default
        FROM interpreter_profiles
        WHERE id = ?1
        ",
            [profile_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .map_err(|err| err.to_string())?;

    interpreter_profile_from_row_values(row.0, row.1, row.2, row.3, row.4)
        .map_err(|err| err.to_string())
}

#[tauri::command]
fn delete_interpreter_profile(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<(), String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let was_default: bool = conn
        .query_row(
            "SELECT is_default FROM interpreter_profiles WHERE id = ?1",
            [profile_id.clone()],
            |row| Ok(row.get::<_, i64>(0)? != 0),
        )
        .optional()
        .map_err(|err| err.to_string())?
        .unwrap_or(false);

    conn.execute(
        "DELETE FROM interpreter_profiles WHERE id = ?1",
        [profile_id.clone()],
    )
    .map_err(|err| err.to_string())?;

    if was_default {
        if let Some(next_id) = conn
            .query_row(
                "SELECT id FROM interpreter_profiles ORDER BY name ASC LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| err.to_string())?
        {
            conn.execute("UPDATE interpreter_profiles SET is_default = 0", [])
                .map_err(|err| err.to_string())?;
            conn.execute(
                "UPDATE interpreter_profiles SET is_default = 1 WHERE id = ?1",
                [next_id.clone()],
            )
            .map_err(|err| err.to_string())?;
            conn.execute(
                "UPDATE settings SET default_interpreter_id = ?1 WHERE id = 1",
                [next_id],
            )
            .map_err(|err| err.to_string())?;
        } else {
            conn.execute(
                "UPDATE settings SET default_interpreter_id = NULL WHERE id = 1",
                [],
            )
            .map_err(|err| err.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn check_interpreter_health(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<InterpreterHealth, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    let executable_path =
        resolve_interpreter_path(&conn, &profile_id).map_err(|err| err.to_string())?;

    let output = std::process::Command::new(&executable_path)
        .arg("--version")
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|err| err.to_string())?;

    let version = if !output.stdout.is_empty() {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    };

    Ok(InterpreterHealth {
        ok: output.status.success(),
        version: version.clone(),
        message: if output.status.success() {
            "解释器可用".to_string()
        } else {
            "解释器不可用".to_string()
        },
    })
}

#[tauri::command]
fn get_bundled_python_status(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BundledPythonStatus, String> {
    Ok(bundled_python_status(&app, &state))
}

#[tauri::command]
fn install_bundled_python(
    app: AppHandle,
    state: State<'_, AppState>,
    source_path: String,
) -> Result<BundledPythonStatus, String> {
    let source_root =
        resolve_python_installation_root(Path::new(&source_path)).map_err(|err| err.to_string())?;
    let installed_python =
        install_bundled_python_from_source(&source_root, &state.bundled_python_dir)
            .map_err(|err| err.to_string())?;

    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    upsert_bundled_interpreter_profile(&conn, &installed_python, false)
        .map_err(|err| err.to_string())?;

    Ok(bundled_python_status(&app, &state))
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    conn.query_row(
        "
        SELECT theme, default_interpreter_id, log_retention_days, auto_save_editor, confirm_before_stop
        FROM settings
        WHERE id = 1
        ",
        [],
        |row| {
            Ok(AppSettings {
                theme: row.get(0)?,
                default_interpreter_id: row.get(1)?,
                log_retention_days: row.get(2)?,
                auto_save_editor: row.get::<_, i64>(3)? != 0,
                confirm_before_stop: row.get::<_, i64>(4)? != 0,
            })
        },
    )
    .optional()
    .map(|value| value.unwrap_or_default())
    .map_err(|err| err.to_string())
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> Result<AppSettings, String> {
    let conn = open_connection(&state).map_err(|err| err.to_string())?;
    conn.execute(
        "
        INSERT INTO settings (id, theme, default_interpreter_id, log_retention_days, auto_save_editor, confirm_before_stop)
        VALUES (1, ?1, ?2, ?3, ?4, ?5)
        ON CONFLICT(id) DO UPDATE SET
            theme = excluded.theme,
            default_interpreter_id = excluded.default_interpreter_id,
            log_retention_days = excluded.log_retention_days,
            auto_save_editor = excluded.auto_save_editor,
            confirm_before_stop = excluded.confirm_before_stop
        ",
        params![
            settings.theme,
            settings.default_interpreter_id,
            settings.log_retention_days,
            bool_to_int(settings.auto_save_editor),
            bool_to_int(settings.confirm_before_stop)
        ],
    )
    .map_err(|err| err.to_string())?;

    if let Some(default_id) = settings.default_interpreter_id.clone() {
        conn.execute("UPDATE interpreter_profiles SET is_default = 0", [])
            .map_err(|err| err.to_string())?;
        conn.execute(
            "UPDATE interpreter_profiles SET is_default = 1 WHERE id = ?1",
            [default_id],
        )
        .map_err(|err| err.to_string())?;
    }

    get_settings(state)
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    backup_files::read(path)
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    backup_files::write(path, content)
}

fn convert_dialog_path(file_path: FilePath) -> Option<String> {
    match file_path {
        FilePath::Path(path) => Some(path.to_string_lossy().into_owned()),
        FilePath::Url(url) => url
            .to_file_path()
            .ok()
            .map(|path| path.to_string_lossy().into_owned()),
    }
}

#[tauri::command]
fn pick_file(app: AppHandle, directory: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if let Some(directory) = directory {
        dialog = dialog.set_directory(directory);
    }
    Ok(dialog.blocking_pick_file().and_then(convert_dialog_path))
}

#[tauri::command]
fn pick_directory(app: AppHandle, directory: Option<String>) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    if let Some(directory) = directory {
        dialog = dialog.set_directory(directory);
    }
    Ok(dialog.blocking_pick_folder().and_then(convert_dialog_path))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_repeated_book_id_in_url_and_output_path() {
        let template = "--book-url https://www.comicbox.xyz/book/{{book_id}} --output F:\\CIL\\conmic\\comicbox_{{book_id}}_backup --delay 0 --workers 12";
        let values = HashMap::from([("book_id".to_string(), "5101".to_string())]);

        let arguments = tokenize_command_line(template)
            .unwrap()
            .into_iter()
            .map(|argument| apply_runtime_values(&argument, &values).unwrap())
            .collect::<Vec<_>>();

        assert_eq!(arguments[1], "https://www.comicbox.xyz/book/5101");
        assert_eq!(arguments[3], "F:\\CIL\\conmic\\comicbox_5101_backup");
        assert_eq!(arguments[5], "0");
        assert_eq!(arguments[7], "12");
        assert!(template.contains("{{book_id}}"));
    }

    #[test]
    fn extracts_each_runtime_variable_once() {
        let variables = extract_runtime_variables("{{book_id}}/{{book_id}}/{{quality}}").unwrap();
        assert_eq!(variables, vec!["book_id", "quality"]);
    }

    #[test]
    fn rejects_missing_and_invalid_runtime_values() {
        let missing = apply_runtime_values("--id {{video_id}}", &HashMap::new());
        assert!(missing.unwrap_err().to_string().contains("video_id"));
        assert!(extract_runtime_variables("{{4741}}").is_err());
        assert!(extract_runtime_variables("{{book-id}}").is_err());
    }

    #[test]
    fn quotes_command_values_with_spaces() {
        let values = HashMap::from([(
            "input".to_string(),
            "F:\\Video Files\\sample.mp4".to_string(),
        )]);
        let resolved = apply_command_runtime_values("ffmpeg -i {{input}}", &values).unwrap();
        assert_eq!(resolved, "ffmpeg -i \"F:\\Video Files\\sample.mp4\"");
    }

    #[test]
    fn python_commands_use_unbuffered_output() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE interpreter_profiles (
                id TEXT PRIMARY KEY,
                executable_path TEXT NOT NULL
            );
            INSERT INTO interpreter_profiles (id, executable_path)
            VALUES ('python', 'python.exe');",
        )
        .unwrap();
        let task = TaskRecord {
            id: Some("task".to_string()),
            kind: TaskKind::PythonTask,
            name: "test".to_string(),
            working_directory: "C:\\work".to_string(),
            env_vars: Vec::new(),
            tags: Vec::new(),
            notes: String::new(),
            favorite: false,
            runtime_parameters: Vec::new(),
            reliability: TaskReliabilityPolicy::default(),
            created_at: String::new(),
            updated_at: String::new(),
            python: Some(PythonTaskConfig {
                interpreter_profile_id: "python".to_string(),
                script_path: "script.py".to_string(),
                args_template: "--id {{id}}".to_string(),
                ..PythonTaskConfig::default()
            }),
            command: None,
        };
        let values = HashMap::from([("id".to_string(), "5101".to_string())]);

        let prepared = prepare_command(&task, &conn, &values, &values).unwrap();

        assert_eq!(prepared.args, vec!["-u", "script.py", "--id", "5101"]);
        assert!(prepared
            .env_vars
            .contains(&("PYTHONIOENCODING".to_string(), "utf-8".to_string())));
        assert!(prepared
            .preview
            .contains("python.exe -u script.py --id 5101"));
    }

    #[test]
    fn structured_python_commands_build_the_same_argv_used_by_the_preview() {
        use structured_arguments::ArgumentEmission;

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE interpreter_profiles (
                id TEXT PRIMARY KEY,
                executable_path TEXT NOT NULL
            );
            INSERT INTO interpreter_profiles (id, executable_path)
            VALUES ('python', 'python.exe');",
        )
        .unwrap();
        let task = TaskRecord {
            id: Some("structured".to_string()),
            kind: TaskKind::PythonTask,
            name: "ComicBox".to_string(),
            working_directory: "C:\\work".to_string(),
            env_vars: Vec::new(),
            tags: Vec::new(),
            notes: String::new(),
            favorite: false,
            runtime_parameters: vec![default_parameter("book_id"), default_parameter("chapters")],
            reliability: TaskReliabilityPolicy::default(),
            created_at: String::new(),
            updated_at: String::new(),
            python: Some(PythonTaskConfig {
                interpreter_profile_id: "python".to_string(),
                script_path: "comic.py".to_string(),
                argument_mode: ArgumentMode::Structured,
                argument_rules: vec![
                    TaskArgumentRule {
                        id: "book-url".to_string(),
                        input_name: "book_id".to_string(),
                        flag: Some("--book-url".to_string()),
                        emission: ArgumentEmission::Always,
                        value_template: "https://www.comicbox.xyz/book/{{book_id}}".to_string(),
                        condition: None,
                        enabled: true,
                    },
                    TaskArgumentRule {
                        id: "chapters".to_string(),
                        input_name: "chapters".to_string(),
                        flag: Some("--chapters".to_string()),
                        emission: ArgumentEmission::WhenNonEmpty,
                        value_template: "{{chapters}}".to_string(),
                        condition: None,
                        enabled: true,
                    },
                ],
                ..PythonTaskConfig::default()
            }),
            command: None,
        };
        let values = HashMap::from([
            ("book_id".to_string(), "5101".to_string()),
            ("chapters".to_string(), String::new()),
        ]);

        let prepared = prepare_command(&task, &conn, &values, &values).unwrap();

        assert_eq!(
            prepared.args,
            vec![
                "-u",
                "comic.py",
                "--book-url",
                "https://www.comicbox.xyz/book/5101",
            ]
        );
        assert_eq!(prepared.preview, join_command("python.exe", &prepared.args));
    }

    #[test]
    fn secret_runtime_values_reach_the_process_but_not_the_command_preview() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE interpreter_profiles (
                id TEXT PRIMARY KEY,
                executable_path TEXT NOT NULL
            );
            INSERT INTO interpreter_profiles (id, executable_path)
            VALUES ('python', 'python.exe');",
        )
        .unwrap();
        let task = TaskRecord {
            id: Some("secret-task".to_string()),
            kind: TaskKind::PythonTask,
            name: "secret".to_string(),
            working_directory: "C:\\work".to_string(),
            env_vars: Vec::new(),
            tags: Vec::new(),
            notes: String::new(),
            favorite: false,
            runtime_parameters: vec![RuntimeParameterDefinition {
                name: "token".to_string(),
                label: "Token".to_string(),
                description: String::new(),
                parameter_type: RuntimeParameterType::Secret,
                required: true,
                default_value: String::new(),
                options: Vec::new(),
                min: None,
                max: None,
                ..default_parameter("token")
            }],
            reliability: TaskReliabilityPolicy::default(),
            created_at: String::new(),
            updated_at: String::new(),
            python: Some(PythonTaskConfig {
                interpreter_profile_id: "python".to_string(),
                script_path: "script.py".to_string(),
                args_template: "--token {{token}}".to_string(),
                ..PythonTaskConfig::default()
            }),
            command: None,
        };
        let provided = HashMap::from([("token".to_string(), "top-secret".to_string())]);

        let resolved = task_runtime_values(&task, &provided).unwrap();
        let prepared = prepare_command(&task, &conn, &resolved.actual, &resolved.redacted).unwrap();

        assert!(prepared
            .args
            .iter()
            .any(|argument| argument == "top-secret"));
        assert!(!prepared.preview.contains("top-secret"));
        assert!(prepared.preview.contains("••••••••"));
    }

    #[test]
    fn clearing_run_history_keeps_running_records() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE run_records (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                stdout_log_path TEXT NOT NULL,
                stderr_log_path TEXT NOT NULL
            );
            INSERT INTO run_records VALUES
                ('finished', 'finished', 'finished-out.log', 'finished-err.log'),
                ('failed', 'failed', 'failed-out.log', 'failed-err.log'),
                ('active', 'running', 'active-out.log', 'active-err.log');",
        )
        .unwrap();

        let (deleted_count, log_paths) = delete_completed_run_records(&conn).unwrap();

        assert_eq!(deleted_count, 2);
        assert_eq!(log_paths.len(), 4);
        let remaining = conn
            .query_row("SELECT id FROM run_records", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap();
        assert_eq!(remaining, "active");
    }

    #[tokio::test]
    async fn timeout_terminates_a_real_process_tree() {
        let mut child = tokio::process::Command::new("cmd")
            .args(["/C", "ping -n 30 127.0.0.1 >NUL"])
            .spawn()
            .unwrap();
        let tree = ProcessTree::attach(&child).unwrap();
        let outcome = wait_for_attempt(&mut child, &tree, 1).await;
        assert!(matches!(outcome, AttemptOutcome::TimedOut));
    }
}
