use std::path::Path;

use rusqlite::Connection;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
    working_directory TEXT NOT NULL, env_vars_json TEXT NOT NULL,
    tags_json TEXT NOT NULL, notes TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS python_task_configs (
    task_id TEXT PRIMARY KEY, interpreter_profile_id TEXT NOT NULL,
    script_path TEXT NOT NULL, args_template TEXT NOT NULL,
    argument_mode TEXT NOT NULL DEFAULT 'template',
    argument_rules_json TEXT NOT NULL DEFAULT '[]',
    validation_rules_json TEXT NOT NULL DEFAULT '[]',
    script_hash TEXT,
    scan_snapshot_json TEXT
);
CREATE TABLE IF NOT EXISTS command_task_configs (
    task_id TEXT PRIMARY KEY, command_text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interpreter_profiles (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
    executable_path TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS run_records (
    id TEXT PRIMARY KEY, task_id TEXT, task_name_snapshot TEXT NOT NULL,
    status TEXT NOT NULL, command_preview TEXT NOT NULL, working_directory TEXT NOT NULL,
    started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, exit_code INTEGER,
    stdout_log_path TEXT NOT NULL, stderr_log_path TEXT NOT NULL,
    runtime_values_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS task_runtime_values (
    task_id TEXT NOT NULL, variable_name TEXT NOT NULL, value TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY (task_id, variable_name)
);
CREATE TABLE IF NOT EXISTS task_runtime_policies (
    task_id TEXT PRIMARY KEY,
    timeout_seconds INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    retry_delay_seconds INTEGER NOT NULL DEFAULT 3,
    concurrency_policy TEXT NOT NULL DEFAULT 'allow',
    output_encoding TEXT NOT NULL DEFAULT 'utf8'
);
CREATE TABLE IF NOT EXISTS task_runtime_parameters (
    task_id TEXT NOT NULL,
    variable_name TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    parameter_type TEXT NOT NULL DEFAULT 'text',
    required INTEGER NOT NULL DEFAULT 1,
    default_value TEXT NOT NULL DEFAULT '',
    options_json TEXT NOT NULL DEFAULT '[]',
    min_value REAL,
    max_value REAL,
    group_name TEXT NOT NULL DEFAULT '常用参数',
    is_advanced INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'template',
    confidence TEXT NOT NULL DEFAULT 'low',
    locked INTEGER NOT NULL DEFAULT 0,
    condition_json TEXT,
    derived_template TEXT,
    allow_override INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (task_id, variable_name)
);
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY CHECK(id = 1), theme TEXT NOT NULL,
    default_interpreter_id TEXT, log_retention_days INTEGER NOT NULL,
    auto_save_editor INTEGER NOT NULL DEFAULT 0,
    confirm_before_stop INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS mobile_api_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    bind_host TEXT NOT NULL DEFAULT '0.0.0.0',
    port INTEGER NOT NULL DEFAULT 17631,
    pairing_code TEXT NOT NULL DEFAULT '',
    token_hash TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mobile_file_index (
    file_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    modified_at TEXT NOT NULL,
    content_type TEXT NOT NULL,
    indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS mobile_shared_folders (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"#;

pub(crate) fn init_database(db_path: &Path) -> anyhow::Result<()> {
    let conn = Connection::open(db_path)?;
    migrate(&conn)
}

pub(crate) fn migrate(conn: &Connection) -> anyhow::Result<()> {
    let transaction = conn.unchecked_transaction()?;
    transaction.execute_batch(SCHEMA)?;
    if !table_has_column(&transaction, "run_records", "runtime_values_json")? {
        transaction.execute(
            "ALTER TABLE run_records ADD COLUMN runtime_values_json TEXT NOT NULL DEFAULT '{}'",
            [],
        )?;
    }
    if !table_has_column(&transaction, "run_records", "attempt_count")? {
        transaction.execute(
            "ALTER TABLE run_records ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1",
            [],
        )?;
    }
    if !table_has_column(&transaction, "run_records", "termination_reason")? {
        transaction.execute(
            "ALTER TABLE run_records ADD COLUMN termination_reason TEXT",
            [],
        )?;
    }
    add_column_if_missing(
        &transaction,
        "python_task_configs",
        "argument_mode",
        "TEXT NOT NULL DEFAULT 'template'",
    )?;
    add_column_if_missing(
        &transaction,
        "python_task_configs",
        "argument_rules_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(
        &transaction,
        "python_task_configs",
        "validation_rules_json",
        "TEXT NOT NULL DEFAULT '[]'",
    )?;
    add_column_if_missing(&transaction, "python_task_configs", "script_hash", "TEXT")?;
    add_column_if_missing(
        &transaction,
        "python_task_configs",
        "scan_snapshot_json",
        "TEXT",
    )?;
    for (column, definition) in [
        ("group_name", "TEXT NOT NULL DEFAULT '常用参数'"),
        ("is_advanced", "INTEGER NOT NULL DEFAULT 0"),
        ("source", "TEXT NOT NULL DEFAULT 'template'"),
        ("confidence", "TEXT NOT NULL DEFAULT 'low'"),
        ("locked", "INTEGER NOT NULL DEFAULT 0"),
        ("condition_json", "TEXT"),
        ("derived_template", "TEXT"),
        ("allow_override", "INTEGER NOT NULL DEFAULT 1"),
        ("enabled", "INTEGER NOT NULL DEFAULT 1"),
    ] {
        add_column_if_missing(&transaction, "task_runtime_parameters", column, definition)?;
    }
    transaction.execute(
        "INSERT OR IGNORE INTO schema_migrations (version) VALUES (1), (2), (3), (4), (5)",
        [],
    )?;
    transaction.commit()?;
    Ok(())
}

fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    definition: &str,
) -> anyhow::Result<()> {
    if !table_has_column(conn, table, column)? {
        conn.execute_batch(&format!(
            "ALTER TABLE {table} ADD COLUMN {column} {definition}"
        ))?;
    }
    Ok(())
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> anyhow::Result<bool> {
    // Table names are internal constants, never user input.
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_current_schema_on_an_empty_database() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        assert!(table_has_column(&conn, "run_records", "runtime_values_json").unwrap());
        assert!(table_has_column(&conn, "run_records", "attempt_count").unwrap());
        assert!(table_has_column(&conn, "run_records", "termination_reason").unwrap());
        let runtime_parameter_tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_runtime_parameters'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(runtime_parameter_tables, 1);
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(version, 5);
        assert!(table_has_column(&conn, "mobile_api_settings", "pairing_code").unwrap());
        assert!(table_has_column(&conn, "mobile_file_index", "content_type").unwrap());
        assert!(table_has_column(&conn, "python_task_configs", "argument_mode").unwrap());
        assert!(table_has_column(&conn, "task_runtime_parameters", "condition_json").unwrap());
        let tables: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(tables >= 6);
    }

    #[test]
    fn upgrades_a_legacy_run_records_table_without_losing_rows() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE run_records (
                id TEXT PRIMARY KEY, task_id TEXT, task_name_snapshot TEXT NOT NULL,
                status TEXT NOT NULL, command_preview TEXT NOT NULL, working_directory TEXT NOT NULL,
                started_at TEXT NOT NULL, finished_at TEXT, duration_ms INTEGER, exit_code INTEGER,
                stdout_log_path TEXT NOT NULL, stderr_log_path TEXT NOT NULL
             );
             INSERT INTO run_records VALUES ('legacy', NULL, 'task', 'finished', 'cmd', '.',
                '2026-01-01', NULL, NULL, 0, 'out', 'err');"
        ).unwrap();
        migrate(&conn).unwrap();
        let values: String = conn
            .query_row(
                "SELECT runtime_values_json FROM run_records WHERE id='legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(values, "{}");
        let attempt_count: i64 = conn
            .query_row(
                "SELECT attempt_count FROM run_records WHERE id='legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(attempt_count, 1);
    }

    #[test]
    fn upgrades_v3_python_configs_in_template_mode_without_changing_the_template() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE python_task_configs (
                task_id TEXT PRIMARY KEY, interpreter_profile_id TEXT NOT NULL,
                script_path TEXT NOT NULL, args_template TEXT NOT NULL
             );
             INSERT INTO python_task_configs VALUES (
                'legacy', 'python', 'legacy.py', '--id {{book_id}}'
             );",
        )
        .unwrap();

        migrate(&conn).unwrap();

        let row: (String, String, String) = conn
            .query_row(
                "SELECT args_template, argument_mode, argument_rules_json
                 FROM python_task_configs WHERE task_id='legacy'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(row.0, "--id {{book_id}}");
        assert_eq!(row.1, "template");
        assert_eq!(row.2, "[]");
    }
}
