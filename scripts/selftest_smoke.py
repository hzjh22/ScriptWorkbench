"""Isolated desktop E2E smoke test for Script Workbench reliability features."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import sys
import time
from pathlib import Path

from pywinauto import Application, Desktop, mouse
import win32gui
import win32process


ROOT = Path(__file__).resolve().parents[1]
APP_EXE = Path(os.environ.get(
    "SCRIPT_WORKBENCH_SELFTEST_EXE",
    ROOT / "src-tauri" / "target" / "release" / "script-workbench.exe",
))
ARTIFACTS = ROOT / "artifacts" / "desktop_selftest"
DATA_DIR = ARTIFACTS / "appdata"
DB_PATH = DATA_DIR / "workbench.sqlite"
REAL_DB = Path(os.environ["APPDATA"]) / "com.lmoon.scriptworkbench" / "workbench.sqlite"
REPORT_PATH = ARTIFACTS / "selftest_report.json"
TASK_ID = "desktop-reliability-selftest"
STRUCTURED_FIXTURE = ROOT / "fixtures" / "structured_e2e.py"


def digest(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None


def launch_app() -> tuple[Application, object]:
    previous = os.environ.get("SCRIPT_WORKBENCH_DATA_DIR")
    os.environ["SCRIPT_WORKBENCH_DATA_DIR"] = str(DATA_DIR)
    try:
        app = Application(backend="uia").start(str(APP_EXE), wait_for_idle=False)
    finally:
        if previous is None:
            os.environ.pop("SCRIPT_WORKBENCH_DATA_DIR", None)
        else:
            os.environ["SCRIPT_WORKBENCH_DATA_DIR"] = previous
    window_handle = None
    for _ in range(20):
        time.sleep(0.5)
        candidates: list[int] = []

        def collect(hwnd: int, _: object) -> None:
            _, process_id = win32process.GetWindowThreadProcessId(hwnd)
            if process_id == app.process and win32gui.IsWindowVisible(hwnd):
                candidates.append(hwnd)

        win32gui.EnumWindows(collect, None)
        if candidates:
            window_handle = candidates[0]
            break
    if window_handle is None:
        app.kill()
        raise RuntimeError("desktop selftest window did not become available")
    win = Desktop(backend="uia").window(handle=window_handle).wrapper_object()
    win.maximize()
    win.set_focus()
    time.sleep(1)
    return app, win


def initialize_database() -> None:
    app, _ = launch_app()
    app.kill()
    time.sleep(1)
    if not DB_PATH.exists():
        raise AssertionError("isolated desktop database was not created")


def seed_task(command: str, *, timeout: int = 0, retries: int = 0,
              concurrency: str = "allow",
              parameters: list[dict[str, object]] | None = None) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        for table in (
            "python_task_configs", "command_task_configs", "task_runtime_values",
            "task_runtime_parameters", "task_runtime_policies", "run_records", "tasks",
        ):
            conn.execute(f"DELETE FROM {table}")
        conn.execute(
            "INSERT INTO tasks VALUES (?, 'command_task', ?, ?, '[]', '[\"selftest\"]', ?, 0, ?, ?)",
            (TASK_ID, "Desktop Reliability E2E", str(ROOT), "isolated desktop E2E", now(), now()),
        )
        conn.execute("INSERT INTO command_task_configs VALUES (?, ?)", (TASK_ID, command))
        conn.execute(
            "INSERT INTO task_runtime_policies VALUES (?, ?, ?, 0, ?, 'utf8')",
            (TASK_ID, timeout, retries, concurrency),
        )
        for position, parameter in enumerate(parameters or []):
            conn.execute(
                "INSERT INTO task_runtime_parameters ("
                "task_id, variable_name, label, description, parameter_type, required, "
                "default_value, options_json, min_value, max_value, position"
                ") VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)",
                (
                    TASK_ID,
                    parameter["name"],
                    parameter.get("label", parameter["name"]),
                    parameter.get("type", "text"),
                    1 if parameter.get("required", True) else 0,
                    parameter.get("default", ""),
                    json.dumps(parameter.get("options", []), ensure_ascii=False),
                    parameter.get("min"),
                    parameter.get("max"),
                    position,
                ),
            )


def seed_structured_python_task(name: str, parameters: list[dict[str, object]],
                                rules: list[dict[str, object]],
                                validation_rules: list[dict[str, object]] | None = None) -> None:
    with sqlite3.connect(DB_PATH) as conn:
        for table in (
            "python_task_configs", "command_task_configs", "task_runtime_values",
            "task_runtime_parameters", "task_runtime_policies", "run_records", "tasks",
        ):
            conn.execute(f"DELETE FROM {table}")
        interpreter = conn.execute(
            "SELECT id, executable_path FROM interpreter_profiles ORDER BY is_default DESC"
        ).fetchall()
        profile_id = next((row[0] for row in interpreter if Path(row[1]).is_file()), None)
        if profile_id is None:
            profile_id = "structured-e2e-python"
            conn.execute(
                "INSERT OR REPLACE INTO interpreter_profiles VALUES (?, 'E2E Python', 'external', ?, 1)",
                (profile_id, sys.executable),
            )
        conn.execute(
            "INSERT INTO tasks VALUES (?, 'python_task', ?, ?, '[]', '[\"schema-v4\"]', ?, 0, ?, ?)",
            (TASK_ID, name, str(ROOT), "structured desktop E2E", now(), now()),
        )
        snapshot = {
            "source": "ast", "framework": "argparse", "parameters": parameters,
            "groups": [{"id": "common", "label": "常用参数", "advanced": False}],
        }
        conn.execute(
            "INSERT INTO python_task_configs (task_id, interpreter_profile_id, script_path, args_template, "
            "argument_mode, argument_rules_json, validation_rules_json, script_hash, scan_snapshot_json) "
            "VALUES (?, ?, ?, '', 'structured', ?, ?, 'sha256:e2e', ?)",
            (TASK_ID, profile_id, str(STRUCTURED_FIXTURE), json.dumps(rules),
             json.dumps(validation_rules or []), json.dumps(snapshot)),
        )
        conn.execute(
            "INSERT INTO task_runtime_policies VALUES (?, 0, 0, 3, 'allow', 'utf8')",
            (TASK_ID,),
        )
        for position, parameter in enumerate(parameters):
            conn.execute(
                "INSERT INTO task_runtime_parameters (task_id, variable_name, label, description, "
                "parameter_type, required, default_value, options_json, min_value, max_value, "
                "group_name, is_advanced, source, confidence, locked, condition_json, derived_template, "
                "allow_override, enabled, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, "
                "'ast', 'high', 0, ?, ?, ?, ?, ?)",
                (
                    TASK_ID, parameter["name"], parameter.get("label", parameter["name"]),
                    parameter.get("description", ""), parameter.get("type", "text"),
                    1 if parameter.get("required", False) else 0, parameter.get("defaultValue", ""),
                    json.dumps(parameter.get("options", [])), parameter.get("min"), parameter.get("max"),
                    parameter.get("group", "常用参数"), 1 if parameter.get("advanced", False) else 0,
                    json.dumps(parameter.get("condition")) if parameter.get("condition") else None,
                    parameter.get("derivedTemplate"), 1 if parameter.get("allowOverride", True) else 0,
                    1 if parameter.get("enabled", True) else 0, position,
                ),
            )


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def click_run(win: object) -> None:
    rect = win.rectangle()
    # Use the persistent top-bar run button: unlike the task column, it never
    # moves when a column scrolls or responsive layout changes.
    mouse.click(coords=(
        rect.left + int(rect.width() * 0.715),
        rect.top + int(rect.height() * 0.09),
    ))


def run_count() -> int:
    with sqlite3.connect(DB_PATH) as conn:
        return conn.execute("SELECT COUNT(*) FROM run_records").fetchone()[0]


def click_until_run_count(win: object, expected: int) -> None:
    for _ in range(3):
        win.set_focus()
        click_run(win)
        for _ in range(10):
            time.sleep(0.2)
            if run_count() >= expected:
                return
    raise AssertionError(f"desktop click did not create run record {expected}")


def latest_run() -> sqlite3.Row:
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM run_records ORDER BY started_at DESC LIMIT 1").fetchone()
        if row is None:
            raise AssertionError("desktop run record was not created")
        return row


def run_and_wait(seconds: float) -> sqlite3.Row:
    app, win = launch_app()
    try:
        click_until_run_count(win, run_count() + 1)
        time.sleep(seconds)
    finally:
        app.kill()
        time.sleep(1)
    return latest_run()


def main() -> int:
    if not APP_EXE.exists():
        raise AssertionError(f"release executable missing: {APP_EXE}")
    real_before = digest(REAL_DB)
    if ARTIFACTS.exists():
        shutil.rmtree(ARTIFACTS)
    ARTIFACTS.mkdir(parents=True)
    initialize_database()
    report: dict[str, object] = {}

    seed_task("echo DESKTOP_SELFTEST_OK")
    success = run_and_wait(4)
    stdout = Path(success["stdout_log_path"]).read_text(encoding="utf-8", errors="replace")
    if success["status"] != "finished" or "DESKTOP_SELFTEST_OK" not in stdout:
        raise AssertionError("desktop success run failed")
    report["success"] = {"status": success["status"], "exit_code": success["exit_code"]}

    seed_task(
        "echo DYNAMIC_DEFAULTS workers={{workers}} quality={{quality}} enabled={{enabled}}",
        parameters=[
            {"name": "workers", "label": "线程数", "type": "number", "default": "12", "min": 1, "max": 32},
            {"name": "quality", "label": "画质", "type": "choice", "default": "1080p", "options": ["720p", "1080p"]},
            {"name": "enabled", "label": "启用", "type": "boolean", "default": "false"},
        ],
    )
    dynamic = run_and_wait(4)
    dynamic_stdout = Path(dynamic["stdout_log_path"]).read_text(
        encoding="utf-8", errors="replace"
    )
    dynamic_values = json.loads(dynamic["runtime_values_json"])
    if (
        dynamic["status"] != "finished"
        or "DYNAMIC_DEFAULTS workers=12 quality=1080p enabled=false" not in dynamic_stdout
        or dynamic_values != {"workers": "12", "quality": "1080p", "enabled": "false"}
    ):
        raise AssertionError("desktop dynamic parameter defaults failed")
    report["dynamic_parameters"] = {
        "status": dynamic["status"],
        "resolved_defaults": dynamic_values,
        "template_resolved": "{{" not in dynamic["command_preview"],
    }

    comic_parameters = [
        {"name": "book_id", "label": "漫画 ID", "type": "text", "required": True, "defaultValue": "5101"},
        {"name": "book_url", "label": "漫画 URL", "type": "text", "required": False, "defaultValue": "",
         "derivedTemplate": "https://www.comicbox.xyz/book/{{book_id}}", "allowOverride": False},
        {"name": "output", "label": "输出目录", "type": "directory", "required": False, "defaultValue": "",
         "derivedTemplate": "F:\\CIL\\comicbox_{{book_id}}_backup", "allowOverride": True},
        {"name": "chapters", "label": "章节范围", "type": "text", "required": False, "defaultValue": ""},
    ]
    comic_rules = [
        {"id": "book-url", "inputName": "book_url", "flag": "--book-url", "emission": "when_non_empty",
         "valueTemplate": "{{book_url}}", "condition": None, "enabled": True},
        {"id": "output", "inputName": "output", "flag": "--output", "emission": "when_non_empty",
         "valueTemplate": "{{output}}", "condition": None, "enabled": True},
        {"id": "chapters", "inputName": "chapters", "flag": "--chapters", "emission": "when_non_empty",
         "valueTemplate": "{{chapters}}", "condition": None, "enabled": True},
    ]
    seed_structured_python_task("ComicBox Schema v4 E2E", comic_parameters, comic_rules)
    comic = run_and_wait(4)
    if (
        comic["status"] != "finished"
        or "--book-url https://www.comicbox.xyz/book/5101" not in comic["command_preview"]
        or "--output F:\\CIL\\comicbox_5101_backup" not in comic["command_preview"]
        or "--chapters" in comic["command_preview"]
    ):
        raise AssertionError(f"ComicBox structured argv failed: {dict(comic)}")
    report["comicbox_structured"] = {
        "status": comic["status"], "chapters_omitted": "--chapters" not in comic["command_preview"],
        "command_preview": comic["command_preview"],
    }

    def source_condition(value: str) -> dict[str, object]:
        return {"field": "source_mode", "operator": "equals", "value": value}

    video_results: dict[str, str] = {}
    for source_mode, watch_url, input_html, video_id in [
        ("id", "", "", "406871"),
        ("url", "https://hanime1.me/watch?v=406872", "", "406872"),
        ("html", "", str(ROOT / "fixtures" / "sample-watch.html"), "406873"),
    ]:
        video_parameters = [
            {"name": "source_mode", "label": "来源模式", "type": "choice", "required": True,
             "defaultValue": source_mode, "options": ["id", "url", "html"]},
            {"name": "video_id", "label": "视频 ID", "type": "text", "required": False, "defaultValue": video_id},
            {"name": "watch_url", "label": "播放页 URL", "type": "text", "required": False,
             "defaultValue": watch_url, "condition": source_condition("url")},
            {"name": "input_html", "label": "本地 HTML", "type": "file", "required": False,
             "defaultValue": input_html, "condition": source_condition("html")},
            {"name": "output_root", "label": "输出根目录", "type": "directory", "required": False,
             "defaultValue": str(ROOT / "runs")},
            {"name": "download_backup", "label": "下载最高分辨率 MP4", "type": "boolean", "required": False,
             "defaultValue": "true"},
            {"name": "browser_fallback", "label": "浏览器解析回退", "type": "boolean", "required": False,
             "defaultValue": "true"},
            {"name": "timeout", "label": "HTTP 超时", "type": "number", "required": False,
             "defaultValue": "30"},
        ]
        video_rules = [
            {"id": "id-watch", "inputName": "video_id", "flag": "--watch-url", "emission": "always",
             "valueTemplate": "https://hanime1.me/watch?v={{video_id}}", "condition": source_condition("id"), "enabled": True},
            {"id": "url-watch", "inputName": "watch_url", "flag": "--watch-url", "emission": "when_non_empty",
             "valueTemplate": "{{watch_url}}", "condition": source_condition("url"), "enabled": True},
            {"id": "html", "inputName": "input_html", "flag": "--input-html", "emission": "when_non_empty",
             "valueTemplate": "{{input_html}}", "condition": source_condition("html"), "enabled": True},
            {"id": "video-id", "inputName": "video_id", "flag": "--video-id", "emission": "when_non_empty",
             "valueTemplate": "{{video_id}}", "condition": None, "enabled": True},
            {"id": "output-root", "inputName": "output_root", "flag": "--output-root", "emission": "when_non_empty",
             "valueTemplate": "{{output_root}}", "condition": None, "enabled": True},
            {"id": "no-backup", "inputName": "download_backup", "flag": "--no-backup", "emission": "when_false",
             "valueTemplate": "", "condition": None, "enabled": True},
            {"id": "no-browser", "inputName": "browser_fallback", "flag": "--no-browser-fallback", "emission": "when_false",
             "valueTemplate": "", "condition": None, "enabled": True},
            {"id": "timeout", "inputName": "timeout", "flag": "--timeout", "emission": "always",
             "valueTemplate": "{{timeout}}", "condition": None, "enabled": True},
        ]
        validation = [
            {"kind": "conditional_required", "fields": ["video_id"], "condition": source_condition("id"),
             "min": None, "max": None, "options": [], "message": "ID required"},
            {"kind": "conditional_required", "fields": ["watch_url"], "condition": source_condition("url"),
             "min": None, "max": None, "options": [], "message": "URL required"},
            {"kind": "conditional_required", "fields": ["input_html"], "condition": source_condition("html"),
             "min": None, "max": None, "options": [], "message": "HTML required"},
        ]
        seed_structured_python_task(f"Video {source_mode} Schema v4 E2E", video_parameters, video_rules, validation)
        video_run = run_and_wait(4)
        preview = video_run["command_preview"]
        if video_run["status"] != "finished" or "--timeout 30" not in preview \
                or "--no-backup" in preview or "--no-browser-fallback" in preview:
            raise AssertionError(f"video {source_mode} structured argv failed: {dict(video_run)}")
        if source_mode == "id" and "--watch-url https://hanime1.me/watch?v=406871" not in preview:
            raise AssertionError(f"video ID mode failed: {preview}")
        if source_mode == "url" and "--watch-url https://hanime1.me/watch?v=406872" not in preview:
            raise AssertionError(f"video URL mode failed: {preview}")
        if source_mode == "html" and "--input-html" not in preview:
            raise AssertionError(f"video HTML mode failed: {preview}")
        video_results[source_mode] = preview
    report["video_source_modes"] = video_results

    seed_task("echo RETRY_E2E && exit /B 7", retries=1)
    retry = run_and_wait(4)
    if retry["status"] != "failed" or retry["attempt_count"] != 2:
        raise AssertionError("desktop retry policy failed")
    report["retry"] = {
        "status": retry["status"], "attempt_count": retry["attempt_count"],
        "termination_reason": retry["termination_reason"],
    }

    seed_task("ping -n 30 127.0.0.1 >NUL", timeout=1)
    timeout = run_and_wait(4)
    if timeout["status"] != "timed_out" or timeout["termination_reason"] != "timeout":
        raise AssertionError("desktop timeout policy failed")
    report["timeout"] = {
        "status": timeout["status"], "duration_ms": timeout["duration_ms"],
        "termination_reason": timeout["termination_reason"],
    }

    seed_task("ping -n 30 127.0.0.1 >NUL", concurrency="reject")
    app, win = launch_app()
    click_until_run_count(win, 1)
    time.sleep(0.7)
    click_run(win)
    time.sleep(1)
    with sqlite3.connect(DB_PATH) as conn:
        running_rows = conn.execute("SELECT COUNT(*) FROM run_records WHERE status='running'").fetchone()[0]
    if running_rows != 1:
        app.kill()
        raise AssertionError("desktop concurrency rejection failed")
    app.kill()
    time.sleep(1)

    recovery_app, _ = launch_app()
    recovery_app.kill()
    time.sleep(1)
    recovered = latest_run()
    if recovered["status"] != "interrupted" or recovered["termination_reason"] != "application_restarted":
        raise AssertionError("desktop interrupted-run recovery failed")
    report["concurrency_and_recovery"] = {
        "single_running_record": True,
        "recovered_status": recovered["status"],
        "termination_reason": recovered["termination_reason"],
    }

    seed_task("ping -n 30 127.0.0.1 >NUL", concurrency="stop_existing")
    replace_app, replace_win = launch_app()
    click_until_run_count(replace_win, 1)
    time.sleep(0.7)
    click_until_run_count(replace_win, 2)
    time.sleep(2)
    with sqlite3.connect(DB_PATH) as conn:
        rows = conn.execute(
            "SELECT status, termination_reason FROM run_records ORDER BY started_at"
        ).fetchall()
    if len(rows) != 2 or rows[0] != ("stopped", "concurrency_replaced") or rows[1][0] != "running":
        replace_app.kill()
        raise AssertionError(f"desktop stop-existing policy failed: {rows}")
    replace_app.kill()
    time.sleep(1)
    report["stop_existing"] = {
        "run_count": 2,
        "replaced_status": rows[0][0],
        "termination_reason": rows[0][1],
    }

    if digest(REAL_DB) != real_before:
        raise AssertionError("desktop selftest modified the real user database")
    report["isolation"] = {"data_dir": str(DATA_DIR), "real_database_unchanged": True}
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def parse_args() -> None:
    parser = argparse.ArgumentParser(
        description="Run the isolated Script Workbench desktop E2E smoke test."
    )
    parser.parse_args()


if __name__ == "__main__":
    parse_args()
    previous_report = REPORT_PATH.read_bytes() if REPORT_PATH.exists() else None
    try:
        raise SystemExit(main())
    except BaseException:
        # A desktop/automation failure must not erase the last successful report.
        if previous_report is not None:
            REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
            REPORT_PATH.write_bytes(previous_report)
        raise
