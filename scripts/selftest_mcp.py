"""Isolated stdio MCP selftest for dynamic runtime parameter metadata."""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DB = (
    ROOT / "artifacts" / "selftest_appdata" / "com.lmoon.scriptworkbench"
    / "workbench.sqlite"
)
ARTIFACTS = ROOT / "artifacts" / "mcp_selftest"
DB_PATH = ARTIFACTS / "workbench.sqlite"
SERVER = ROOT / "scripts" / "script_workbench_mcp.py"
TASK_ID = "mcp-dynamic-parameter-selftest"
STRUCTURED_TASK_ID = "mcp-structured-selftest"


def prepare_database() -> None:
    if not SOURCE_DB.exists():
        raise AssertionError("run selftest_backend.py before selftest_mcp.py")
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    shutil.copy2(SOURCE_DB, DB_PATH)
    with sqlite3.connect(DB_PATH) as conn:
        for task_id in (TASK_ID, STRUCTURED_TASK_ID):
          for table in (
            "task_runtime_parameters",
            "task_runtime_policies",
            "python_task_configs",
            "command_task_configs",
            "tasks",
          ):
            conn.execute(f"DELETE FROM {table} WHERE task_id=?" if table != "tasks"
                         else "DELETE FROM tasks WHERE id=?", (task_id,))
        conn.execute(
            "INSERT INTO tasks VALUES (?, 'command_task', ?, ?, '[]', '[\"selftest\"]', ?, 1, ?, ?)",
            (TASK_ID, "MCP Dynamic Selftest", str(ROOT), "isolated MCP selftest", "2999-01-01", "2999-01-01"),
        )
        conn.execute(
            "INSERT INTO command_task_configs VALUES (?, ?)",
            (TASK_ID, "echo workers={{workers}} token={{token}}"),
        )
        conn.execute(
            "INSERT INTO task_runtime_policies VALUES (?, 0, 0, 3, 'allow', 'utf8')",
            (TASK_ID,),
        )
        conn.executemany(
            "INSERT INTO task_runtime_parameters ("
            "task_id, variable_name, label, description, parameter_type, required, "
            "default_value, options_json, min_value, max_value, position"
            ") VALUES (?, ?, ?, '', ?, 1, ?, ?, ?, ?, ?)",
            [
                (TASK_ID, "workers", "线程数", "number", "12", "[]", 1, 32, 0),
                (TASK_ID, "token", "访问令牌", "secret", "", "[]", None, None, 1),
            ],
        )
        interpreter_id = conn.execute(
            "SELECT id FROM interpreter_profiles WHERE executable_path=? LIMIT 1", (sys.executable,)
        ).fetchone()
        if interpreter_id is None:
            interpreter_id = "mcp-python"
            conn.execute(
                "INSERT INTO interpreter_profiles VALUES (?, 'MCP Python', 'external', ?, 0)",
                (interpreter_id, sys.executable),
            )
        else:
            interpreter_id = interpreter_id[0]
        conn.execute(
            "INSERT INTO tasks VALUES (?, 'python_task', ?, ?, '[]', '[\"selftest\"]', ?, 0, ?, ?)",
            (STRUCTURED_TASK_ID, "MCP Structured Selftest", str(ROOT), "schema v4 MCP", "2999-01-01", "2999-01-01"),
        )
        rules = [
            {"id": "url", "inputName": "book_id", "flag": "--url", "emission": "always",
             "valueTemplate": "https://example.test/book/{{book_id}}", "condition": None, "enabled": True},
            {"id": "chapters", "inputName": "chapters", "flag": "--chapters", "emission": "when_non_empty",
             "valueTemplate": "{{chapters}}", "condition": None, "enabled": True},
            {"id": "token", "inputName": "token", "flag": "--token", "emission": "when_non_empty",
             "valueTemplate": "{{token}}", "condition": None, "enabled": True},
            {"id": "format", "inputName": "format", "flag": "--format", "emission": "when_non_empty",
             "valueTemplate": "{{format}}", "condition": None, "enabled": True},
            {"id": "optional-token", "inputName": "optional_token", "flag": "--optional-token",
             "emission": "when_non_empty", "valueTemplate": "{{optional_token}}",
             "condition": None, "enabled": True},
        ]
        snapshot = {
            "source": "ast", "framework": "argparse",
            "groups": [{"id": "common", "label": "常用参数", "advanced": False}],
            "parameters": [
                {"name": "book_id", "type": "text", "defaultValue": ""},
                {"name": "chapters", "type": "text", "defaultValue": ""},
                {"name": "token", "type": "secret", "defaultValue": ""},
                {"name": "format", "type": "choice", "defaultValue": ""},
                {"name": "optional_token", "type": "secret", "defaultValue": ""},
            ],
        }
        conn.execute(
            "INSERT INTO python_task_configs (task_id, interpreter_profile_id, script_path, args_template, "
            "argument_mode, argument_rules_json, validation_rules_json, script_hash, scan_snapshot_json) "
            "VALUES (?, ?, ?, '', 'structured', ?, '[]', NULL, ?)",
            (STRUCTURED_TASK_ID, interpreter_id, str(ROOT / "fixtures" / "selftest_python_task.py"),
             json.dumps(rules), json.dumps(snapshot)),
        )
        conn.executemany(
            "INSERT INTO task_runtime_parameters (task_id, variable_name, label, description, parameter_type, "
            "required, default_value, options_json, min_value, max_value, group_name, is_advanced, source, "
            "confidence, locked, condition_json, derived_template, allow_override, enabled, position) "
            "VALUES (?, ?, ?, '', ?, ?, ?, '[]', NULL, NULL, '常用参数', 0, 'ast', 'high', 0, NULL, ?, 1, 1, ?)",
            [
                (STRUCTURED_TASK_ID, "book_id", "漫画 ID", "text", 1, "5101", None, 0),
                (STRUCTURED_TASK_ID, "chapters", "章节", "text", 0, "", None, 1),
                (STRUCTURED_TASK_ID, "token", "Token", "secret", 1, "", None, 2),
                (STRUCTURED_TASK_ID, "format", "格式", "choice", 0, "", None, 3),
                (STRUCTURED_TASK_ID, "optional_token", "可选 Token", "secret", 0, "", None, 4),
            ],
        )
        conn.execute(
            "UPDATE task_runtime_parameters SET options_json='[\"json\",\"text\"]' "
            "WHERE task_id=? AND variable_name='format'",
            (STRUCTURED_TASK_ID,),
        )


def call_server() -> dict[int, object]:
    requests = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "health", "arguments": {},
        }},
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "inspect_task", "arguments": {"task": TASK_ID},
        }},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "preview_task",
            "arguments": {"task": TASK_ID, "runtime_values": {"token": "top-secret"}},
        }},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {
            "name": "inspect_task", "arguments": {"task": STRUCTURED_TASK_ID},
        }},
        {"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {
            "name": "preview_task",
            "arguments": {"task": STRUCTURED_TASK_ID, "runtime_values": {"token": "top-secret"}},
        }},
    ]
    completed = subprocess.run(
        [sys.executable, str(SERVER)],
        input="\n".join(json.dumps(item, ensure_ascii=False) for item in requests) + "\n",
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "SCRIPT_WORKBENCH_DB": str(DB_PATH)},
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(completed.stderr)
    responses = {item["id"]: item for item in map(json.loads, completed.stdout.splitlines())}
    return {
        request_id: json.loads(response["result"]["content"][0]["text"])
        for request_id, response in responses.items()
        if request_id != 1
    }


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    prepare_database()
    responses = call_server()
    health = responses[2]
    task = responses[3]
    preview = responses[4]
    structured_task = responses[5]
    structured_preview = responses[6]
    if health["schema_version"] != 4:
        raise AssertionError(f"unexpected MCP schema version: {health}")
    parameter_types = {item["name"]: item["type"] for item in task["runtime_parameters"]}
    if parameter_types != {"workers": "number", "token": "secret"}:
        raise AssertionError(f"unexpected MCP parameter metadata: {parameter_types}")
    preview_text = preview["command_preview"]
    if "workers=12" not in preview_text or "top-secret" in preview_text or "••••••••" not in preview_text:
        raise AssertionError(f"MCP preview was not safely resolved: {preview_text}")
    if structured_task["argument_mode"] != "structured":
        raise AssertionError(f"structured metadata missing: {structured_task}")
    structured_text = structured_preview["command_preview"]
    if "https://example.test/book/5101" not in structured_text or "--chapters" in structured_text:
        raise AssertionError(f"structured argv mismatch: {structured_text}")
    if "top-secret" in structured_text or "••••••••" not in structured_text:
        raise AssertionError(f"structured secret leaked: {structured_text}")
    if "--format" in structured_text or "--optional-token" in structured_text:
        raise AssertionError(f"empty optional structured values were emitted: {structured_text}")
    report = {
        "schema_version": health["schema_version"],
        "runtime_parameters": parameter_types,
        "default_applied": "workers=12" in preview_text,
        "secret_redacted": "top-secret" not in preview_text and "••••••••" in preview_text,
        "structured_preview": structured_text,
        "structured_source": structured_task["scan"]["source"],
        "database": str(DB_PATH),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
