"""Static Python CLI scanner used through ``python -I -S -c``.

The target module is parsed with :mod:`ast` and is never imported or executed.
Only JSON-serialisable literals are evaluated.
"""

import ast
import json
import pathlib
import sys


def literal(node, default=None):
    if node is None:
        return default
    try:
        return ast.literal_eval(node)
    except Exception:
        return default


def dotted_name(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
    return ".".join(reversed(parts))


def kwargs(call):
    return {item.arg: item.value for item in call.keywords if item.arg}


def option_name(flags, explicit=None):
    if explicit:
        return str(explicit).replace("-", "_")
    long_flags = [flag for flag in flags if isinstance(flag, str) and flag.startswith("--")]
    selected = long_flags[0] if long_flags else (flags[0] if flags else "argument")
    return str(selected).lstrip("-").replace("-", "_")


def annotation_type(node):
    name = dotted_name(node).lower()
    if name.endswith("bool"):
        return "boolean"
    if name.endswith("int") or name.endswith("float"):
        return "number"
    if name.endswith("path"):
        return "file"
    return "text"


def call_type(node):
    if node is None:
        return "text", []
    name = dotted_name(node.func if isinstance(node, ast.Call) else node).lower()
    if name.endswith("path"):
        return "file", []
    if name.endswith("int") or name.endswith("float"):
        return "number", []
    if name.endswith("choice") and isinstance(node, ast.Call):
        choices = literal(node.args[0], []) if node.args else []
        return "choice", [str(value) for value in choices]
    return "text", []


def serialise_default(value):
    if value is None or value is ...:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (list, tuple)):
        return "\n".join(str(item) for item in value)
    return str(value)


def base_parameter(name, flag=None):
    return {
        "name": name,
        "label": name.replace("_", " ").strip().title(),
        "description": "",
        "type": "text",
        "required": False,
        "defaultValue": "",
        "options": [],
        "min": None,
        "max": None,
        "flag": flag,
        "position": flag is None,
        "action": "value",
        "repeat": False,
        "group": "常用参数",
    }


class Scanner(ast.NodeVisitor):
    def __init__(self, tree, path):
        self.tree = tree
        self.path = path
        self.frameworks = set()
        self.parameters = []
        self.groups = {"常用参数"}
        self.group_vars = {}
        self.exclusive_vars = {}
        self.exclusive_groups = []
        self.description = ast.get_docstring(tree) or ""
        self.name = pathlib.Path(path).stem.replace("_", " ")
        self.diagnostics = []

    def visit_Assign(self, node):
        if not isinstance(node.value, ast.Call):
            return self.generic_visit(node)
        call_name = dotted_name(node.value.func)
        targets = [target.id for target in node.targets if isinstance(target, ast.Name)]
        if call_name.endswith("ArgumentParser"):
            self.frameworks.add("argparse")
            values = kwargs(node.value)
            self.description = literal(values.get("description"), self.description) or self.description
            self.name = literal(values.get("prog"), self.name) or self.name
        elif call_name.endswith("add_argument_group"):
            title = literal(node.value.args[0], "参数") if node.value.args else "参数"
            for target in targets:
                self.group_vars[target] = str(title)
                self.groups.add(str(title))
        elif call_name.endswith("add_mutually_exclusive_group"):
            for target in targets:
                self.exclusive_vars[target] = []
        self.generic_visit(node)

    def visit_Call(self, node):
        call_name = dotted_name(node.func)
        if call_name.endswith(".add_argument"):
            self.frameworks.add("argparse")
            self._argparse_argument(node)
        self.generic_visit(node)

    def _argparse_argument(self, call):
        values = kwargs(call)
        flags = [literal(arg) for arg in call.args]
        flags = [flag for flag in flags if isinstance(flag, str)]
        name = option_name(flags, literal(values.get("dest")))
        flag = next((item for item in flags if item.startswith("--")), None)
        if flag is None and flags and flags[0].startswith("-"):
            flag = flags[0]
        parameter = base_parameter(name, flag)
        parameter["position"] = not bool(flag)
        parameter["required"] = bool(literal(values.get("required"), parameter["position"]))
        parameter["description"] = str(literal(values.get("help"), "") or "")
        parameter["defaultValue"] = serialise_default(literal(values.get("default")))
        parameter["group"] = self.group_vars.get(dotted_name(call.func).rsplit(".", 1)[0], "常用参数")
        action = literal(values.get("action"), "store")
        if action in ("store_true", "store_false"):
            parameter["type"] = "boolean"
            parameter["action"] = action
            if not parameter["defaultValue"]:
                parameter["defaultValue"] = "false" if action == "store_true" else "true"
        elif action in ("append", "extend") or literal(values.get("nargs")) in ("+", "*"):
            parameter["repeat"] = True
            parameter["action"] = "repeat"
        choices = literal(values.get("choices"), []) or []
        if choices:
            parameter["type"] = "choice"
            parameter["options"] = [str(item) for item in choices]
        elif action not in ("store_true", "store_false"):
            parameter["type"], inferred_options = call_type(values.get("type"))
            parameter["options"] = inferred_options
        self.parameters.append(parameter)
        owner = dotted_name(call.func).rsplit(".", 1)[0]
        if owner in self.exclusive_vars:
            self.exclusive_vars[owner].append(name)

    def scan_click(self):
        for node in ast.walk(self.tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            decorators = [item for item in node.decorator_list if isinstance(item, ast.Call)]
            if not any(dotted_name(item.func).endswith(("click.command", "click.group")) for item in decorators):
                continue
            self.frameworks.add("click")
            self.name = node.name.replace("_", " ")
            self.description = ast.get_docstring(node) or self.description
            for decorator in reversed(decorators):
                decorator_name = dotted_name(decorator.func)
                if decorator_name.endswith("click.option"):
                    self._click_option(decorator)
                elif decorator_name.endswith("click.argument"):
                    self._click_argument(decorator)

    def _click_option(self, call):
        values = kwargs(call)
        flags = [literal(arg) for arg in call.args]
        flags = [value for value in flags if isinstance(value, str)]
        name = option_name(flags)
        flag = next((value for value in flags if value.startswith("--")), flags[0] if flags else None)
        parameter = base_parameter(name, flag)
        parameter["required"] = bool(literal(values.get("required"), False))
        parameter["description"] = str(literal(values.get("help"), "") or "")
        parameter["defaultValue"] = serialise_default(literal(values.get("default")))
        if literal(values.get("is_flag"), False):
            parameter["type"] = "boolean"
            parameter["action"] = "store_true"
            if not parameter["defaultValue"]:
                parameter["defaultValue"] = "false"
        else:
            parameter["type"], parameter["options"] = call_type(values.get("type"))
        if literal(values.get("multiple"), False):
            parameter["repeat"] = True
            parameter["action"] = "repeat"
        self.parameters.append(parameter)

    def _click_argument(self, call):
        values = kwargs(call)
        name = str(literal(call.args[0], "argument")) if call.args else "argument"
        parameter = base_parameter(name.replace("-", "_"), None)
        parameter["required"] = bool(literal(values.get("required"), True))
        parameter["type"], parameter["options"] = call_type(values.get("type"))
        parameter["repeat"] = literal(values.get("nargs")) == -1
        parameter["action"] = "repeat" if parameter["repeat"] else "value"
        self.parameters.append(parameter)

    def scan_typer(self):
        for node in ast.walk(self.tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            if not any(
                isinstance(item, ast.Call) and dotted_name(item.func).endswith(".command")
                for item in node.decorator_list
            ):
                continue
            typer_args = []
            positional_count = len(node.args.args)
            defaults = [None] * (positional_count - len(node.args.defaults)) + list(node.args.defaults)
            for argument, default in zip(node.args.args, defaults):
                call = default if isinstance(default, ast.Call) else None
                call_name = dotted_name(call.func) if call else ""
                if call_name.endswith(("typer.Option", "typer.Argument")):
                    typer_args.append((argument, call, call_name.endswith("typer.Argument")))
            if not typer_args:
                continue
            self.frameworks.add("typer")
            self.name = node.name.replace("_", " ")
            self.description = ast.get_docstring(node) or self.description
            for argument, call, positional in typer_args:
                values = kwargs(call)
                declared = [literal(item) for item in call.args[1:]]
                flags = [item for item in declared if isinstance(item, str) and item.startswith("-")]
                flag = None if positional else (next((item for item in flags if item.startswith("--")), None) or f"--{argument.arg.replace('_', '-')}")
                parameter = base_parameter(argument.arg, flag)
                default_value = literal(call.args[0]) if call.args else None
                parameter["required"] = default_value is ... or default_value is None and positional
                parameter["defaultValue"] = serialise_default(default_value)
                parameter["description"] = str(literal(values.get("help"), "") or "")
                parameter["type"] = annotation_type(argument.annotation)
                if parameter["type"] == "boolean":
                    parameter["action"] = "store_true"
                    if not parameter["defaultValue"]:
                        parameter["defaultValue"] = "false"
                self.parameters.append(parameter)

    def result(self):
        self.visit(self.tree)
        self.scan_click()
        self.scan_typer()
        for members in self.exclusive_vars.values():
            if len(members) > 1:
                self.exclusive_groups.append(members)
        # Decorator scanners can overlap when aliases are unusual; keep the first occurrence.
        unique = []
        seen = set()
        for parameter in self.parameters:
            key = (parameter["name"], parameter["flag"])
            if key not in seen:
                seen.add(key)
                unique.append(parameter)
        framework = "+".join(sorted(self.frameworks)) or "unknown"
        if not unique:
            self.diagnostics.append("静态 AST 未识别到参数，可使用 --help 补扫或模板占位符。")
        return {
            "framework": framework,
            "name": self.name,
            "description": self.description,
            "parameters": unique,
            "groups": sorted(self.groups),
            "mutuallyExclusive": self.exclusive_groups,
            "diagnostics": self.diagnostics,
        }


def main():
    path = pathlib.Path(sys.argv[1])
    source = path.read_text(encoding="utf-8-sig")
    tree = ast.parse(source, filename=str(path))
    print(json.dumps(Scanner(tree, str(path)).result(), ensure_ascii=False))


if __name__ == "__main__":
    main()
