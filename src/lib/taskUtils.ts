import type { InterpreterProfile, TaskKind, TaskRecord } from "../types";

export function createEmptyTask(kind: TaskKind, defaultInterpreterId: string | null): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: null, kind, name: "", workingDirectory: "", envVars: [], tags: [], notes: "",
    favorite: false,
    runtimeParameters: [],
    reliability: {
      timeoutSeconds: 0,
      retryCount: 0,
      retryDelaySeconds: 3,
      concurrencyPolicy: "allow",
      outputEncoding: "utf8",
    },
    createdAt: now, updatedAt: now,
    python: kind === "python_task" ? {
      interpreterProfileId: defaultInterpreterId ?? "", scriptPath: "", argsTemplate: "",
      argumentMode: "template",
      argumentRules: [],
      validationRules: [],
      scriptHash: null,
      scanSnapshot: null,
    } : null,
    command: kind === "command_task" ? { command: "" } : null,
  };
}

export function cloneTask(task: TaskRecord): TaskRecord {
  const cloned = structuredClone(task);
  cloned.reliability ??= {
    timeoutSeconds: 0,
    retryCount: 0,
    retryDelaySeconds: 3,
    concurrencyPolicy: "allow",
    outputEncoding: "utf8",
  };
  cloned.runtimeParameters ??= [];
  if (cloned.python) {
    cloned.python.argumentMode ??= "template";
    cloned.python.argumentRules ??= [];
    cloned.python.validationRules ??= [];
    cloned.python.scriptHash ??= null;
    cloned.python.scanSnapshot ??= null;
  }
  return cloned;
}

export function formatDateTime(value: string | null): string {
  if (!value) return "未完成";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(new Date(value));
}

export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined) return "进行中";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export function taskMatchesSearch(task: TaskRecord, query: string): boolean {
  if (!query.trim()) return true;
  return [task.name, task.notes, task.tags.join(" "), task.python?.scriptPath ?? "", task.command?.command ?? ""]
    .join(" ").toLowerCase().includes(query.trim().toLowerCase());
}

export function parseCommaSeparated(text: string): string[] {
  return text.split(",").map((item) => item.trim()).filter(Boolean);
}

function quotePreviewArg(value: string): string {
  if (!value) return '""';
  return /\s|"/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export function buildPreviewCommand(task: TaskRecord | null, interpreters: InterpreterProfile[]): string {
  if (!task) return "";
  if (task.kind === "python_task") {
    const scriptPath = task.python?.scriptPath?.trim() ?? "";
    const interpreterId = task.python?.interpreterProfileId?.trim() ?? "";
    const interpreterPath = interpreters.find((item) => item.id === interpreterId)?.executablePath || "<请选择解释器>";
    return [quotePreviewArg(interpreterPath), scriptPath ? quotePreviewArg(scriptPath) : "<请填写脚本路径>", task.python?.argsTemplate?.trim() ?? ""]
      .filter(Boolean).join(" ");
  }
  return task.command?.command ?? "";
}

export function getRuntimeTemplate(task: TaskRecord | null): string {
  if (!task) return "";
  return task.kind === "python_task" ? task.python?.argsTemplate ?? "" : task.command?.command ?? "";
}

export function extractRuntimeVariableNames(template: string): string[] {
  return [...template.matchAll(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g)]
    .map((match) => match[1]).filter((name, index, names) => names.indexOf(name) === index);
}

export function resolveTaskWorkingDirectory(task: TaskRecord | null): string {
  if (!task) return "";
  if (task.workingDirectory.trim()) return task.workingDirectory;
  if (task.kind === "python_task" && task.python?.scriptPath) {
    return task.python.scriptPath.replace(/[\\/][^\\/]+$/, "");
  }
  return "";
}
