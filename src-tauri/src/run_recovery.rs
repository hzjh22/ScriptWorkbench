use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};

pub(crate) fn recover_interrupted_runs(
    conn: &Connection,
    finished_at: &str,
) -> anyhow::Result<usize> {
    let finished = DateTime::parse_from_rfc3339(finished_at)?.with_timezone(&Utc);
    let mut stmt =
        conn.prepare("SELECT id, started_at FROM run_records WHERE status = 'running'")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let pending = rows.collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    for (run_id, started_at) in &pending {
        let duration_ms = DateTime::parse_from_rfc3339(started_at)
            .map(|started| {
                (finished - started.with_timezone(&Utc))
                    .num_milliseconds()
                    .max(0)
            })
            .unwrap_or(0);
        conn.execute(
            "UPDATE run_records SET status='interrupted', finished_at=?1, duration_ms=?2,
             termination_reason='application_restarted' WHERE id=?3",
            params![finished_at, duration_ms, run_id],
        )?;
    }
    Ok(pending.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database;

    #[test]
    fn recovery_records_duration_and_restart_reason() {
        let conn = Connection::open_in_memory().unwrap();
        database::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO run_records (id, task_name_snapshot, status, command_preview,
             working_directory, started_at, stdout_log_path, stderr_log_path)
             VALUES ('run', 'task', 'running', 'cmd', '.', '2026-01-01T00:00:00Z', 'out', 'err')",
            [],
        )
        .unwrap();
        assert_eq!(
            recover_interrupted_runs(&conn, "2026-01-01T00:00:05Z").unwrap(),
            1
        );
        let row: (String, i64, String) = conn
            .query_row(
                "SELECT status, duration_ms, termination_reason FROM run_records WHERE id='run'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "interrupted".to_string(),
                5000,
                "application_restarted".to_string()
            )
        );
    }
}
