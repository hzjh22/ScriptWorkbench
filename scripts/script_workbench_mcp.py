"""MCP debug bridge for Script Workbench.

The server reads the application's SQLite state directly and can execute a
short, bounded probe using the exact interpreter and task template saved by
the application. It intentionally has no third-party dependencies.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import unquote


APPDATA_DIR = Path(os.environ.get("APPDATA", Path.home() / "AppData/Roaming")) / "com.lmoon.scriptworkbench"
DB_PATH = Path(os.environ.get("SCRIPT_WORKBENCH_DB", APPDATA_DIR / "workbench.sqlite"))
PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")
MAX_OUTPUT_CHARS = 120_000


TOOLS = [
    {
        "name": "health",
        "description": "Check the Script Workbench database, logs, and desktop process.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "list_tasks",
        "description": "List configured tasks and their kinds without opening the UI.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "inspect_task",
        "description": "Read one task, interpreter, paths, template, and runtime variables.",
        "inputSchema": {
            "type": "object",
            "properties": {"task": {"type": "string", "description": "Task ID or exact task name"}},
            "required": ["task"],
            "additionalProperties": False,
        },
    },
    {
        "name": "preview_task",
        "description": "Resolve runtime placeholders and return the exact command without executing it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string"},
                "runtime_values": {"type": "object", "additionalProperties": {"type": "string"}},
            },
            "required": ["task"],
            "additionalProperties": False,
        },
    },
    {
        "name": "probe_task",
        "description": "Execute a configured task briefly, capture real output, then terminate it on timeout.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string"},
                "runtime_values": {"type": "object", "additionalProperties": {"type": "string"}},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 60, "default": 8},
                "confirm": {"type": "boolean", "description": "Must be true because this executes the task"},
            },
            "required": ["task", "confirm"],
            "additionalProperties": False,
        },
    },
    {
        "name": "list_runs",
        "description": "List recent application run records with command snapshots and statuses.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "task": {"type": "string"},
                "status": {"type": "string"},
                "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 20},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "read_run_output",
        "description": "Read stdout and stderr logs for one application run ID.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "run_id": {"type": "string"},
                "max_chars": {"type": "integer", "minimum": 100, "maximum": 120000, "default": 30000},
            },
            "required": ["run_id"],
            "additionalProperties": False,
        },
    },
]


def connect() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise RuntimeError(f"Script Workbench database does not exist: {DB_PATH}")
    conn = sqlite3.connect(DB_PATH, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def json_value(raw: str, fallback: Any) -> Any:
    try:
        return json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return fallback


def find_task(conn: sqlite3.Connection, selector: str) -> sqlite3.Row:
    structured_columns = (
        "p.argument_mode, p.argument_rules_json, p.validation_rules_json, "
        "p.script_hash, p.scan_snapshot_json,"
        if column_exists(conn, "python_task_configs", "argument_mode")
        else "'template' AS argument_mode, '[]' AS argument_rules_json, "
             "'[]' AS validation_rules_json, NULL AS script_hash, NULL AS scan_snapshot_json,"
    )
    row = conn.execute(
        f"""
        SELECT t.*, p.interpreter_profile_id, p.script_path, p.args_template,
               {structured_columns}
               c.command_text, i.name AS interpreter_name, i.type AS interpreter_type,
               i.executable_path
        FROM tasks t
        LEFT JOIN python_task_configs p ON p.task_id = t.id
        LEFT JOIN command_task_configs c ON c.task_id = t.id
        LEFT JOIN interpreter_profiles i ON i.id = p.interpreter_profile_id
        WHERE t.id = ? OR t.name = ?
        ORDER BY CASE WHEN t.id = ? THEN 0 ELSE 1 END
        LIMIT 1
        """,
        (selector, selector, selector),
    ).fetchone()
    if row is None:
        raise ValueError(f"Task not found: {selector}")
    return row


def table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone() is not None


def column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    return any(item[1] == column for item in conn.execute(f"PRAGMA table_info({table})"))


def task_policy(conn: sqlite3.Connection, task_id: str) -> dict[str, Any]:
    defaults = {
        "timeout_seconds": 0, "retry_count": 0, "retry_delay_seconds": 3,
        "concurrency_policy": "allow", "output_encoding": "utf8",
    }
    if not table_exists(conn, "task_runtime_policies"):
        return defaults
    row = conn.execute("SELECT * FROM task_runtime_policies WHERE task_id=?", (task_id,)).fetchone()
    if row is None:
        return defaults
    values = dict(row)
    values.pop("task_id", None)
    return defaults | values


def task_parameters(
    conn: sqlite3.Connection, task_id: str, template: str, argument_mode: str = "template"
) -> list[dict[str, Any]]:
    variables = list(dict.fromkeys(PLACEHOLDER_RE.findall(template)))
    configured: dict[str, dict[str, Any]] = {}
    if table_exists(conn, "task_runtime_parameters"):
        extended = column_exists(conn, "task_runtime_parameters", "group_name")
        extension_columns = (
            ", group_name, is_advanced, source, confidence, locked, condition_json, "
            "derived_template, allow_override, enabled"
            if extended else ""
        )
        rows = conn.execute(
            "SELECT variable_name, label, description, parameter_type, required, "
            "default_value, options_json, min_value, max_value " + extension_columns + " "
            "FROM task_runtime_parameters WHERE task_id=? ORDER BY position, variable_name",
            (task_id,),
        ).fetchall()
        configured = {
            item["variable_name"]: {
                "name": item["variable_name"],
                "label": item["label"],
                "description": item["description"],
                "type": item["parameter_type"],
                "required": bool(item["required"]),
                "default_value": item["default_value"],
                "options": json_value(item["options_json"], []),
                "min": item["min_value"],
                "max": item["max_value"],
                "group": item["group_name"] if extended else "常用参数",
                "advanced": bool(item["is_advanced"]) if extended else False,
                "source": item["source"] if extended else "template",
                "confidence": item["confidence"] if extended else "low",
                "locked": bool(item["locked"]) if extended else False,
                "condition": json_value(item["condition_json"], None) if extended else None,
                "derived_template": item["derived_template"] if extended else None,
                "allow_override": bool(item["allow_override"]) if extended else True,
                "enabled": bool(item["enabled"]) if extended else True,
            }
            for item in rows
        }
    if argument_mode == "structured":
        variables = list(configured)
    return [
        configured.get(name, {
            "name": name,
            "label": name,
            "description": "",
            "type": "text",
            "required": True,
            "default_value": "",
            "options": [],
            "min": None,
            "max": None,
            "group": "常用参数",
            "advanced": False,
            "source": "template",
            "confidence": "low",
            "locked": False,
            "condition": None,
            "derived_template": None,
            "allow_override": True,
            "enabled": True,
        })
        for name in variables
    ]


def condition_matches(condition: dict[str, Any] | None, values: dict[str, str]) -> bool:
    if not condition:
        return True
    actual = values.get(str(condition.get("field", "")), "")
    expected = str(condition.get("value") or "")
    operator = condition.get("operator")
    return {
        "equals": actual == expected,
        "not_equals": actual != expected,
        "truthy": actual == "true",
        "falsy": actual == "false",
        "non_empty": bool(actual.strip()),
        "empty": not actual.strip(),
    }.get(str(operator), False)


def interpolate(template: str, values: dict[str, str]) -> str:
    return PLACEHOLDER_RE.sub(lambda match: values.get(match.group(1), ""), template)


def validate_joint_rules(rules: list[dict[str, Any]], values: dict[str, str]) -> None:
    non_empty = lambda field: bool(values.get(str(field), "").strip())
    for rule in rules:
        if not condition_matches(rule.get("condition"), values):
            continue
        fields = [str(field) for field in rule.get("fields", [])]
        kind = rule.get("kind")
        invalid = False
        if kind == "conditional_required":
            invalid = any(not non_empty(field) for field in fields)
        elif kind == "at_least_one":
            invalid = not any(non_empty(field) for field in fields)
        elif kind == "mutually_exclusive":
            invalid = sum(non_empty(field) for field in fields) > 1
        elif kind == "enum":
            options = [str(item) for item in rule.get("options", [])]
            invalid = any(non_empty(field) and values[field] not in options for field in fields)
        elif kind == "range":
            for field in fields:
                if not non_empty(field):
                    continue
                try:
                    number = float(values[field])
                except ValueError:
                    invalid = True
                    break
                minimum, maximum = rule.get("min"), rule.get("max")
                invalid = not math.isfinite(number) or (minimum is not None and number < minimum) \
                    or (maximum is not None and number > maximum)
                if invalid:
                    break
        elif kind == "repeat":
            minimum, maximum = rule.get("min"), rule.get("max")
            for field in fields:
                count = len([item for item in values.get(field, "").splitlines() if item.strip()])
                if (minimum is not None and count < minimum) or (maximum is not None and count > maximum):
                    invalid = True
                    break
        if invalid:
            raise ValueError(rule.get("message") or f"Joint runtime validation failed: {', '.join(fields)}")


def resolve_task_runtime_values(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    provided: dict[str, str],
) -> tuple[dict[str, str], dict[str, str]]:
    template = row["args_template"] if row["kind"] == "python_task" else row["command_text"]
    argument_mode = row["argument_mode"] if row["kind"] == "python_task" else "template"
    argument_rules = json_value(row["argument_rules_json"], []) if argument_mode == "structured" else []
    multiline_names = {
        str(rule.get("inputName", "")) for rule in argument_rules if rule.get("emission") == "repeat"
    }
    parameters = task_parameters(conn, row["id"], template or "", argument_mode)
    actual: dict[str, str] = {
        parameter["name"]: str(provided.get(parameter["name"], parameter["default_value"]))
        for parameter in parameters
    }
    if actual.get("source_mode") == "url" and actual.get("watch_url", "").strip():
        match = re.search(r"[?&]v=([^&#]+)", actual["watch_url"], re.IGNORECASE)
        if match:
            actual["video_id"] = unquote(match.group(1))
    for _ in range(max(1, len(parameters))):
        changed = False
        for parameter in parameters:
            derived = parameter.get("derived_template")
            if not derived:
                continue
            current = actual.get(parameter["name"], "")
            if parameter.get("allow_override", True) and current.strip():
                continue
            value = interpolate(str(derived), actual)
            if value != current:
                actual[parameter["name"]] = value
                changed = True
        if not changed:
            break
    redacted: dict[str, str] = {}
    for parameter in parameters:
        name = parameter["name"]
        value = actual.get(name, "")
        active = parameter.get("enabled", True) and condition_matches(parameter.get("condition"), actual)
        if active and parameter["required"] and not value.strip():
            raise ValueError(f"Missing runtime value: {name}")
        forbidden = ("\0", "\r") if name in multiline_names else ("\0", "\r", "\n")
        if any(character in value for character in forbidden):
            raise ValueError(f"Runtime value {name!r} contains a forbidden control character")
        if parameter["type"] == "number" and value.strip():
            try:
                number = float(value)
            except ValueError as exc:
                raise ValueError(f"Runtime value {name!r} must be a number") from exc
            if not math.isfinite(number):
                raise ValueError(f"Runtime value {name!r} must be finite")
            if parameter["min"] is not None and number < parameter["min"]:
                raise ValueError(f"Runtime value {name!r} must be at least {parameter['min']}")
            if parameter["max"] is not None and number > parameter["max"]:
                raise ValueError(f"Runtime value {name!r} must be at most {parameter['max']}")
        if parameter["type"] == "boolean" and value not in ("true", "false"):
            raise ValueError(f"Runtime value {name!r} must be true or false")
        if parameter["type"] == "choice" and value.strip() and value not in parameter["options"]:
            raise ValueError(f"Runtime value {name!r} is not a configured option")
        redacted[name] = "••••••••" if parameter["type"] == "secret" and value else value
    if argument_mode == "structured":
        validate_joint_rules(json_value(row["validation_rules_json"], []), actual)
    return actual, redacted


def task_dict(
    row: sqlite3.Row,
    policy: dict[str, Any] | None = None,
    parameters: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    template = row["args_template"] if row["kind"] == "python_task" else row["command_text"]
    argument_mode = row["argument_mode"] if row["kind"] == "python_task" else "template"
    argument_rules = json_value(row["argument_rules_json"], []) if argument_mode == "structured" else []
    validation_rules = json_value(row["validation_rules_json"], []) if argument_mode == "structured" else []
    snapshot = json_value(row["scan_snapshot_json"], None) if argument_mode == "structured" else None
    script_change_status = "not_scanned"
    current_hash = None
    if row["script_path"] and Path(row["script_path"]).is_file():
        current_hash = "sha256:" + hashlib.sha256(Path(row["script_path"]).read_bytes()).hexdigest()
        script_change_status = "unchanged" if row["script_hash"] == current_hash else "changed"
    elif row["script_path"]:
        script_change_status = "missing"
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "working_directory": row["working_directory"],
        "environment": json_value(row["env_vars_json"], []),
        "tags": json_value(row["tags_json"], []),
        "notes": row["notes"],
        "favorite": bool(row["favorite"]),
        "interpreter": {
            "id": row["interpreter_profile_id"],
            "name": row["interpreter_name"],
            "type": row["interpreter_type"],
            "executable_path": row["executable_path"],
        } if row["kind"] == "python_task" else None,
        "script_path": row["script_path"],
        "template": template or "",
        "argument_mode": argument_mode,
        "runtime_variables": [item["name"] for item in (parameters or [])]
            if argument_mode == "structured"
            else list(dict.fromkeys(PLACEHOLDER_RE.findall(template or ""))),
        "runtime_parameters": parameters or [],
        "argument_rules": argument_rules,
        "validation_rules": validation_rules,
        "scan": {
            "source": snapshot.get("source") if isinstance(snapshot, dict) else None,
            "framework": snapshot.get("framework") if isinstance(snapshot, dict) else None,
            "groups": snapshot.get("groups", []) if isinstance(snapshot, dict) else [],
            "stored_hash": row["script_hash"],
            "current_hash": current_hash,
            "change_status": script_change_status,
        },
        "reliability": policy or {
            "timeout_seconds": 0, "retry_count": 0, "retry_delay_seconds": 3,
            "concurrency_policy": "allow", "output_encoding": "utf8",
        },
    }


def split_windows(command_line: str) -> list[str]:
    if not command_line.strip():
        return []
    argc = ctypes.c_int()
    command_line_to_argv = ctypes.windll.shell32.CommandLineToArgvW
    command_line_to_argv.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    command_line_to_argv.restype = ctypes.POINTER(ctypes.c_wchar_p)
    argv = command_line_to_argv(command_line, ctypes.byref(argc))
    if not argv:
        raise ctypes.WinError()
    try:
        return [argv[index] for index in range(argc.value)]
    finally:
        ctypes.windll.kernel32.LocalFree(argv)


def resolve_template(template: str, values: dict[str, str]) -> str:
    missing: list[str] = []

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        value = str(values.get(name, "")).strip()
        if not value:
            missing.append(name)
            return match.group(0)
        if "\x00" in value or "\r" in value or "\n" in value:
            raise ValueError(f"Runtime value {name!r} contains a forbidden control character")
        return value

    resolved = PLACEHOLDER_RE.sub(replace, template)
    if missing:
        raise ValueError(f"Missing runtime values: {', '.join(dict.fromkeys(missing))}")
    return resolved


def structured_argv(rules: list[dict[str, Any]], values: dict[str, str]) -> list[str]:
    argv: list[str] = []
    for rule in rules:
        if rule.get("enabled", True) is False or not condition_matches(rule.get("condition"), values):
            continue
        name = str(rule.get("inputName", ""))
        value = values.get(name, "")
        emission = rule.get("emission", "always")
        emit = emission == "always" or (emission == "when_non_empty" and bool(value.strip())) \
            or (emission == "when_true" and value == "true") \
            or (emission == "when_false" and value == "false") \
            or (emission == "repeat" and bool(value.strip()))
        if not emit:
            continue
        flag = rule.get("flag")
        template = str(rule.get("valueTemplate", ""))
        if emission == "repeat":
            for item in (item.strip() for item in value.splitlines()):
                if not item:
                    continue
                if flag:
                    argv.append(str(flag))
                item_values = dict(values)
                item_values[name] = item
                rendered = interpolate(template, item_values)
                if rendered:
                    argv.append(rendered)
            continue
        if flag:
            argv.append(str(flag))
        rendered = interpolate(template, values)
        if rendered:
            argv.append(rendered)
    return argv


def command_for(row: sqlite3.Row, runtime_values: dict[str, str]) -> tuple[list[str], str]:
    if row["kind"] == "python_task":
        executable = row["executable_path"]
        script = row["script_path"]
        if not executable or not script:
            raise ValueError("Python task has no interpreter or script path")
        if row["argument_mode"] == "structured":
            args = structured_argv(json_value(row["argument_rules_json"], []), runtime_values)
        else:
            args = split_windows(resolve_template(row["args_template"] or "", runtime_values))
        command = [executable, "-u", script, *args]
    else:
        text = resolve_template(row["command_text"] or "", runtime_values)
        command = [os.environ.get("COMSPEC", "cmd.exe"), "/D", "/S", "/C", text]
    return command, subprocess.list2cmdline(command)


def task_environment(row: sqlite3.Row) -> dict[str, str]:
    env = os.environ.copy()
    for item in json_value(row["env_vars_json"], []):
        if isinstance(item, dict) and item.get("key"):
            env[str(item["key"])] = str(item.get("value", ""))
    return env


def read_tail(path: str, max_chars: int) -> str:
    if not path or not Path(path).exists():
        return ""
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    return text[-max_chars:]


def call_tool(name: str, args: dict[str, Any]) -> Any:
    if name == "health":
        process = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq script-workbench.exe", "/FO", "CSV", "/NH"],
            capture_output=True,
            text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        logs = APPDATA_DIR / "logs"
        schema_version = None
        if DB_PATH.exists():
            with connect() as conn:
                if table_exists(conn, "schema_migrations"):
                    schema_version = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        return {
            "ok": DB_PATH.exists(),
            "database": str(DB_PATH),
            "database_size": DB_PATH.stat().st_size if DB_PATH.exists() else None,
            "logs_directory": str(logs),
            "desktop_process_running": "script-workbench.exe" in process.stdout.lower(),
            "schema_version": schema_version,
        }

    with connect() as conn:
        if name == "list_tasks":
            rows = conn.execute(
                "SELECT id, name, kind, favorite, updated_at FROM tasks ORDER BY favorite DESC, name"
            ).fetchall()
            return [dict(row) | {"favorite": bool(row["favorite"])} for row in rows]

        if name == "inspect_task":
            row = find_task(conn, args["task"])
            template = row["args_template"] if row["kind"] == "python_task" else row["command_text"]
            return task_dict(
                row,
                task_policy(conn, row["id"]),
                task_parameters(
                    conn,
                    row["id"],
                    template or "",
                    row["argument_mode"] if row["kind"] == "python_task" else "template",
                ),
            )

        if name == "preview_task":
            row = find_task(conn, args["task"])
            actual, redacted = resolve_task_runtime_values(
                conn, row, args.get("runtime_values") or {}
            )
            command, _ = command_for(row, actual)
            redacted_command, preview = command_for(row, redacted)
            return {
                "task": row["name"],
                "command": redacted_command,
                "command_preview": preview,
                "working_directory": row["working_directory"],
                "working_directory_exists": Path(row["working_directory"]).is_dir(),
                "executable_exists": Path(command[0]).is_file(),
                "script_exists": Path(row["script_path"]).is_file() if row["script_path"] else None,
            }

        if name == "probe_task":
            if args.get("confirm") is not True:
                raise ValueError("probe_task requires confirm=true")
            timeout = max(1, min(int(args.get("timeout_seconds", 8)), 60))
            row = find_task(conn, args["task"])
            actual, redacted = resolve_task_runtime_values(
                conn, row, args.get("runtime_values") or {}
            )
            command, _ = command_for(row, actual)
            _, preview = command_for(row, redacted)
            started = time.monotonic()
            process = subprocess.Popen(
                command,
                cwd=row["working_directory"] or None,
                env=task_environment(row),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            timed_out = False
            try:
                stdout, stderr = process.communicate(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                subprocess.run(
                    ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                    capture_output=True,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                stdout, stderr = process.communicate(timeout=5)
            return {
                "task": row["name"],
                "command_preview": preview,
                "pid": process.pid,
                "timed_out": timed_out,
                "duration_ms": round((time.monotonic() - started) * 1000),
                "exit_code": process.returncode,
                "stdout": stdout[-MAX_OUTPUT_CHARS:],
                "stderr": stderr[-MAX_OUTPUT_CHARS:],
            }

        if name == "list_runs":
            limit = max(1, min(int(args.get("limit", 20)), 100))
            clauses: list[str] = []
            values: list[Any] = []
            if args.get("task"):
                clauses.append("(task_id = ? OR task_name_snapshot = ?)")
                values.extend([args["task"], args["task"]])
            if args.get("status"):
                clauses.append("status = ?")
                values.append(args["status"])
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
            attempt_select = "attempt_count" if column_exists(conn, "run_records", "attempt_count") else "1 AS attempt_count"
            reason_select = "termination_reason" if column_exists(conn, "run_records", "termination_reason") else "NULL AS termination_reason"
            rows = conn.execute(
                f"""SELECT id, task_id, task_name_snapshot AS task_name, status,
                           command_preview, started_at, finished_at, duration_ms, exit_code,
                           {attempt_select}, {reason_select}
                    FROM run_records {where} ORDER BY started_at DESC LIMIT ?""",
                [*values, limit],
            ).fetchall()
            return [dict(row) for row in rows]

        if name == "read_run_output":
            max_chars = max(100, min(int(args.get("max_chars", 30000)), MAX_OUTPUT_CHARS))
            row = conn.execute(
                "SELECT * FROM run_records WHERE id = ?", (args["run_id"],)
            ).fetchone()
            if row is None:
                raise ValueError(f"Run not found: {args['run_id']}")
            return {
                "id": row["id"],
                "task_name": row["task_name_snapshot"],
                "status": row["status"],
                "exit_code": row["exit_code"],
                "command_preview": row["command_preview"],
                "stdout": read_tail(row["stdout_log_path"], max_chars),
                "stderr": read_tail(row["stderr_log_path"], max_chars),
                "attempt_count": row["attempt_count"] if "attempt_count" in row.keys() else 1,
                "termination_reason": row["termination_reason"] if "termination_reason" in row.keys() else None,
            }

    raise ValueError(f"Unknown tool: {name}")


def send(message: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle(message: dict[str, Any]) -> None:
    request_id = message.get("id")
    method = message.get("method")
    if request_id is None:
        return
    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "2025-03-26",
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "script-workbench-debug", "version": "0.1.0"},
            },
        })
        return
    if method == "ping":
        send({"jsonrpc": "2.0", "id": request_id, "result": {}})
        return
    if method == "tools/list":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}})
        return
    if method == "tools/call":
        params = message.get("params") or {}
        try:
            result = call_tool(params.get("name", ""), params.get("arguments") or {})
            content = json.dumps(result, ensure_ascii=False, indent=2)
            send({"jsonrpc": "2.0", "id": request_id, "result": {"content": [{"type": "text", "text": content}]}})
        except Exception as exc:
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "result": {"content": [{"type": "text", "text": f"{type(exc).__name__}: {exc}"}], "isError": True},
            })
        return
    send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": f"Method not found: {method}"}})


def main() -> int:
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            handle(json.loads(line))
        except json.JSONDecodeError as exc:
            send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
