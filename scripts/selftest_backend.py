import json
import hashlib
import os
import shutil
import sqlite3
import subprocess
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RELEASE_EXE = Path(os.environ.get(
    "SCRIPT_WORKBENCH_SELFTEST_EXE",
    ROOT / "src-tauri" / "target" / "release" / "script-workbench.exe",
))
INSTALLER = Path(os.environ.get(
    "SCRIPT_WORKBENCH_SELFTEST_INSTALLER",
    ROOT / "src-tauri" / "target" / "release" / "bundle" / "nsis"
    / "Script Workbench_0.1.0_x64-setup.exe",
))
SELFTEST_APPDATA_ROOT = ROOT / "artifacts" / "selftest_appdata"
APPDATA_DIR = SELFTEST_APPDATA_ROOT / "com.lmoon.scriptworkbench"
DB_PATH = APPDATA_DIR / "workbench.sqlite"
REAL_DB_PATH = Path(os.environ["APPDATA"]) / "com.lmoon.scriptworkbench" / "workbench.sqlite"
RESOURCE_PYTHON = ROOT / "src-tauri" / "resources" / "python" / "python.exe"
FIXTURE_PY = ROOT / "fixtures" / "selftest_python_task.py"
REPORT_PATH = ROOT / "artifacts" / "backend_selftest_report.json"


def launch_for_init() -> None:
    process = subprocess.Popen(
        [str(RELEASE_EXE)],
        env={**os.environ, "SCRIPT_WORKBENCH_DATA_DIR": str(APPDATA_DIR)},
    )
    time.sleep(6)
    process.kill()
    process.wait()


def run_python(python_exe: Path, extra_args: list[str], env: dict[str, str] | None = None) -> tuple[int, str]:
    completed = subprocess.run(
        [str(python_exe), str(FIXTURE_PY), *extra_args],
        check=False,
        capture_output=True,
        text=True,
        env={**os.environ, **(env or {})},
        cwd=str(FIXTURE_PY.parent),
    )
    return completed.returncode, completed.stdout + completed.stderr


def main() -> int:
    report: dict[str, object] = {}
    real_db_before = hashlib.sha256(REAL_DB_PATH.read_bytes()).hexdigest() if REAL_DB_PATH.exists() else None
    if SELFTEST_APPDATA_ROOT.exists():
        shutil.rmtree(SELFTEST_APPDATA_ROOT)

    launch_for_init()

    if not DB_PATH.exists():
        raise RuntimeError("workbench.sqlite not created after app init")

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    task_names = [row[0] for row in cur.execute("select name from tasks order by name").fetchall()]
    task_templates = dict(
        cur.execute(
            "select tasks.name, python_task_configs.args_template from tasks join python_task_configs on tasks.id = python_task_configs.task_id"
        ).fetchall()
    )
    interpreters = cur.execute(
        "select name, type, is_default, executable_path from interpreter_profiles order by name"
    ).fetchall()
    default_interpreter = cur.execute(
        "select default_interpreter_id from settings where id = 1"
    ).fetchone()[0]

    report["seeded_db"] = {
        "tasks": task_names,
        "interpreters": interpreters,
        "default_interpreter_id": default_interpreter,
        "task_templates": task_templates,
    }

    expected_tasks = {"ComicBox 备份", "共模脚本", "视频源摘要"}
    if set(task_names) != expected_tasks:
        raise AssertionError(f"seeded tasks mismatch: {task_names}")
    video_template = task_templates.get("视频源摘要", "")
    if "--watch-url https://hanime1.me/watch?v={{video_id}}" not in video_template:
        raise AssertionError("video task must derive its required watch URL from video_id")
    comic_template = task_templates.get("ComicBox 备份", "")
    if comic_template.count("{{book_id}}") != 2:
        raise AssertionError("ComicBox task must use book_id in URL and output path")

    run_columns = {
        row[1] for row in cur.execute("pragma table_info(run_records)").fetchall()
    }
    if "runtime_values_json" not in run_columns:
        raise AssertionError("run_records runtime value migration missing")
    if not {"attempt_count", "termination_reason"}.issubset(run_columns):
        raise AssertionError("run reliability columns migration missing")
    schema_version = cur.execute("select max(version) from schema_migrations").fetchone()[0]
    if schema_version != 4:
        raise AssertionError(f"unexpected schema version: {schema_version}")
    policy_table = cur.execute(
        "select 1 from sqlite_master where type='table' and name='task_runtime_policies'"
    ).fetchone()
    if not policy_table:
        raise AssertionError("task runtime policy table missing")
    parameter_table = cur.execute(
        "select 1 from sqlite_master where type='table' and name='task_runtime_parameters'"
    ).fetchone()
    if not parameter_table:
        raise AssertionError("task runtime parameter table missing")
    python_config_columns = {
        row[1] for row in cur.execute("pragma table_info(python_task_configs)").fetchall()
    }
    if not {"argument_mode", "argument_rules_json", "validation_rules_json", "script_hash", "scan_snapshot_json"}.issubset(python_config_columns):
        raise AssertionError("schema v4 Python configuration columns missing")
    parameter_columns = {
        row[1] for row in cur.execute("pragma table_info(task_runtime_parameters)").fetchall()
    }
    if not {"group_name", "condition_json", "derived_template", "enabled"}.issubset(parameter_columns):
        raise AssertionError("schema v4 runtime parameter metadata columns missing")
    report["migrations"] = {
        "schema_version": schema_version,
        "run_columns": sorted(run_columns),
        "task_runtime_policies": True,
        "task_runtime_parameters": True,
        "python_config_columns": sorted(python_config_columns),
    }

    if not RESOURCE_PYTHON.exists():
        raise AssertionError("bundled resource python missing")

    resource_code, resource_output = run_python(
        RESOURCE_PYTHON,
        ["--ping", "resource", "--extra", "backend"],
        {"SELFTEST_ENV": "resource"},
    )
    if resource_code != 0 or "SELFTEST_PYTHON_OK" not in resource_output:
        raise AssertionError("resource bundled python failed")
    report["resource_python"] = {
        "returncode": resource_code,
        "output": resource_output,
    }

    system_python_path = next(
        (row[3] for row in interpreters if row[1] == "external"),
        None,
    )
    if not system_python_path:
        raise AssertionError("system python interpreter missing in DB")
    system_code, system_output = run_python(
        Path(system_python_path),
        ["--ping", "system", "--extra", "backend"],
        {"SELFTEST_ENV": "system"},
    )
    if system_code != 0 or "SELFTEST_PYTHON_OK" not in system_output:
        raise AssertionError("system python failed")
    report["system_python"] = {
        "returncode": system_code,
        "output": system_output,
    }

    command_run = subprocess.run(
        ["cmd", "/c", "echo SELFTEST_COMMAND_OK && echo %CD%"],
        check=False,
        capture_output=True,
        text=True,
        cwd=str(ROOT),
    )
    if command_run.returncode != 0 or "SELFTEST_COMMAND_OK" not in command_run.stdout:
        raise AssertionError("command execution smoke failed")
    report["command_execution"] = {
        "returncode": command_run.returncode,
        "output": command_run.stdout,
    }

    report["artifacts"] = {
        "release_exe_exists": RELEASE_EXE.exists(),
        "installer_exists": INSTALLER.exists(),
        "installer_size": INSTALLER.stat().st_size if INSTALLER.exists() else 0,
    }
    if not RELEASE_EXE.exists() or not INSTALLER.exists():
        raise AssertionError("release artifacts missing")

    real_db_after = hashlib.sha256(REAL_DB_PATH.read_bytes()).hexdigest() if REAL_DB_PATH.exists() else None
    if real_db_before != real_db_after:
        raise AssertionError("selftest modified the real user database")
    report["isolation"] = {
        "test_database": str(DB_PATH),
        "real_database_unchanged": True,
    }

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
