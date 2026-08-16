import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "./lib/api";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ChoiceField, SafeMultilineInput, SafeSingleLineInput, SafeToggle } from "./components/SafeFields";
import { RuntimeParameterEditor } from "./components/RuntimeParameterEditor";
import { RuntimeParameterFields } from "./components/RuntimeParameterFields";
import { ScriptScanPreviewModal } from "./components/ScriptScanPreviewModal";
import {
  buildPreviewCommand, cloneTask, createEmptyTask,
  formatDateTime, formatDuration, getRuntimeTemplate, parseCommaSeparated,
  resolveTaskWorkingDirectory, taskMatchesSearch,
} from "./lib/taskUtils";
import {
  runtimeValuesAfterChange,
  runtimeValuesWithDefaults,
  syncRuntimeParameters,
  validateRuntimeValues,
} from "./lib/runtimeParameters";
import {
  AppSettings,
  BundledPythonStatus,
  InterpreterHealth,
  InterpreterProfile,
  RunOutput,
  RunRecord,
  RuntimeValues,
  RunStatusEvent,
  RunStreamEvent,
  ScriptScanPreview,
  ScriptScanStatus,
  TaskKind,
  TaskRecord,
  ThemeMode,
  WorkspaceBackup,
} from "./types";
import "./styles.css";

type ViewKey = "dashboard" | "tasks" | "runs" | "settings";

type TerminalBuffer = RunOutput & {
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  finishedAt: string | null;
};

const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  defaultInterpreterId: null,
  logRetentionDays: 14,
  autoSaveEditor: false,
  confirmBeforeStop: true,
};

type QrImageInfo = {
  primaryPath: string;
  latestPath: string | null;
};

const QR_IMAGE_PATH_RE = /[A-Za-z]:[\\/][^\r\n'"),]+?\.png/gi;

function normalizeQrPath(path: string): string {
  return path.replace(/\//g, "\\");
}

function firstQrPath(line: string): string | null {
  const matches = line.match(QR_IMAGE_PATH_RE);
  return matches?.[0] ? normalizeQrPath(matches[0]) : null;
}

function extractLatestQrImage(output: string): QrImageInfo | null {
  let primaryPath: string | null = null;
  let latestPath: string | null = null;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("QR image:")) {
      primaryPath = firstQrPath(line) ?? primaryPath;
    } else if (line.startsWith("QR latest image:")) {
      latestPath = firstQrPath(line) ?? latestPath;
    }
  }
  if (!primaryPath && !latestPath) return null;
  return { primaryPath: primaryPath ?? latestPath!, latestPath };
}

function fileSrcForPreview(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return `file:///${path.replace(/\\/g, "/")}`;
  }
}

function TerminalOutputView({
  output,
  emptyText,
  stream,
}: {
  output: string;
  emptyText: string;
  stream: "stdout" | "stderr";
}) {
  const qrImage = stream === "stdout" ? extractLatestQrImage(output) : null;
  return (
    <div className={`terminal-output-wrap ${stream}`}>
      {qrImage && (
        <div className="qr-preview-card">
          <div className="qr-preview-copy">
            <strong>Telegram 登录二维码</strong>
            <span>请用手机 Telegram：设置 → 设备 → 连接桌面设备，然后扫描下方二维码并确认登录。</span>
            <code>{qrImage.primaryPath}</code>
          </div>
          <div className="qr-preview-actions">
            <img
              className="qr-preview-image"
              src={fileSrcForPreview(qrImage.primaryPath)}
              alt="Telegram 登录二维码"
            />
            <button
              type="button"
              className="secondary-button compact-button"
              onClick={() => void openPath(qrImage.primaryPath)}
            >
              打开二维码图片
            </button>
          </div>
        </div>
      )}
      <pre className={`terminal-output ${stream}`}>{output || emptyText}</pre>
    </div>
  );
}
const WORKSPACE_BACKUP_VERSION = 4;

function App() {
  const [view, setView] = useState<ViewKey>("tasks");
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [interpreters, setInterpreters] = useState<InterpreterProfile[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [draftTask, setDraftTask] = useState<TaskRecord | null>(null);
  const [taskDirty, setTaskDirty] = useState(false);
  const [commandPreview, setCommandPreview] = useState("");
  const [runtimeValues, setRuntimeValues] = useState<RuntimeValues>({});
  const [runtimeValuesLoading, setRuntimeValuesLoading] = useState(false);
  const [runtimePreviewError, setRuntimePreviewError] = useState("");
  const [taskSearch, setTaskSearch] = useState("");
  const [statusMessage, setStatusMessage] = useState("准备就绪");
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [interpreterPickerOpen, setInterpreterPickerOpen] = useState(false);
  const [argsEditorOpen, setArgsEditorOpen] = useState(false);
  const [argsEditorDraft, setArgsEditorDraft] = useState("");
  const [runtimeParameterEditorOpen, setRuntimeParameterEditorOpen] = useState(false);
  const [terminalBuffers, setTerminalBuffers] = useState<Record<string, TerminalBuffer>>({});
  const [runOutputLoading, setRunOutputLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingTask, setIsSavingTask] = useState(false);
  const [newInterpreterName, setNewInterpreterName] = useState("");
  const [newInterpreterPath, setNewInterpreterPath] = useState("");
  const [selectedInterpreterHealth, setSelectedInterpreterHealth] =
    useState<Record<string, InterpreterHealth>>({});
  const [selectedRunSnapshot, setSelectedRunSnapshot] = useState<RunOutput | null>(null);
  const [bundledPythonStatus, setBundledPythonStatus] = useState<BundledPythonStatus | null>(null);
  const [bundledPythonBusy, setBundledPythonBusy] = useState(false);
  const [taskKindFilter, setTaskKindFilter] = useState<"all" | TaskKind>("all");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [runSearch, setRunSearch] = useState("");
  const [runStatusFilter, setRunStatusFilter] = useState("all");
  const [isClearingRunHistory, setIsClearingRunHistory] = useState(false);
  const [scriptScanPreview, setScriptScanPreview] = useState<ScriptScanPreview | null>(null);
  const [scriptScanBusy, setScriptScanBusy] = useState(false);
  const [scriptScanStatus, setScriptScanStatus] = useState<ScriptScanStatus | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [activeRunByTask, setActiveRunByTask] = useState<Record<string, string>>({});

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? null,
    [runs, selectedRunId],
  );
  const visibleTasks = useMemo(
    () =>
      tasks.filter((task) => {
        if (!taskMatchesSearch(task, taskSearch)) return false;
        if (taskKindFilter !== "all" && task.kind !== taskKindFilter) return false;
        if (favoritesOnly && !task.favorite) return false;
        return true;
      }),
    [favoritesOnly, taskKindFilter, taskSearch, tasks],
  );
  const visibleRuns = useMemo(
    () =>
      runs.filter((run) => {
        const query = runSearch.trim().toLowerCase();
        const matchesQuery =
          !query ||
          [run.taskName, run.commandPreview, run.workingDirectory, run.status]
            .join(" ")
            .toLowerCase()
            .includes(query);
        const matchesStatus = runStatusFilter === "all" || run.status === runStatusFilter;
        return matchesQuery && matchesStatus;
      }),
    [runSearch, runStatusFilter, runs],
  );
  const defaultInterpreterId = useMemo(() => {
    return (
      settingsDraft.defaultInterpreterId ??
      interpreters.find((item) => item.isDefault)?.id ??
      interpreters[0]?.id ??
      null
    );
  }, [interpreters, settingsDraft.defaultInterpreterId]);
  const preferredExternalInterpreter = useMemo(
    () =>
      interpreters.find((item) => item.type === "external" && item.executablePath) ?? null,
    [interpreters],
  );
  const activeRunId = selectedTaskId ? activeRunByTask[selectedTaskId] ?? null : null;
  const activeTerminal = activeRunId ? terminalBuffers[activeRunId] : null;
  const activeRunTaskName = activeRunId
    ? runs.find((run) => run.id === activeRunId)?.taskName ?? null
    : null;
  const taskTerminalRuns = useMemo(
    () => selectedTaskId ? runs.filter((run) => run.taskId === selectedTaskId) : [],
    [runs, selectedTaskId],
  );
  const runtimeParameters = useMemo(
    () => syncRuntimeParameters(
      getRuntimeTemplate(draftTask),
      draftTask?.runtimeParameters ?? [],
      draftTask?.python?.argumentMode ?? "template",
    ),
    [draftTask],
  );
  const runtimeValueErrors = useMemo(
    () => validateRuntimeValues(
      runtimeParameters,
      runtimeValues,
      draftTask?.python?.validationRules ?? [],
      (draftTask?.python?.argumentRules ?? [])
        .filter((rule) => rule.emission === "repeat")
        .map((rule) => rule.inputName),
    ),
    [draftTask?.python?.argumentRules, draftTask?.python?.validationRules, runtimeParameters, runtimeValues],
  );
  const missingRuntimeVariables = Object.keys(runtimeValueErrors);
  function flashStatus(message: string) {
    setStatusMessage(message);
    if (statusTimerRef.current) {
      window.clearTimeout(statusTimerRef.current);
    }
    statusTimerRef.current = window.setTimeout(() => {
      setStatusMessage("准备就绪");
    }, 2400);
  }

  async function loadWorkspace() {
    setIsLoading(true);
    try {
      const [taskList, runList, interpreterList, loadedSettings] = await Promise.all([
        api.listTasks(),
        api.listRuns(),
        api.listInterpreterProfiles(),
        api.getSettings(),
      ]);
      const bundledStatus = await api.getBundledPythonStatus();
      setTasks(taskList);
      setRuns(runList);
      rememberLatestTaskRuns(runList);
      setInterpreters(interpreterList);
      setSettings(loadedSettings);
      setSettingsDraft(loadedSettings);
      setBundledPythonStatus(bundledStatus);
      if (!selectedTaskId && taskList.length > 0) {
        setSelectedTaskId(taskList[0].id);
      }
      if (!selectedRunId && runList.length > 0) {
        setSelectedRunId(runList[0].id);
      }
    } catch (error) {
      console.error(error);
      setStatusMessage(`初始化失败: ${String(error)}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function refreshTasks() {
    const taskList = await api.listTasks();
    setTasks(taskList);
    if (selectedTaskId) {
      const exists = taskList.some((task) => task.id === selectedTaskId);
      if (!exists) {
        setSelectedTaskId(taskList[0]?.id ?? null);
      }
    } else if (taskList[0]) {
      setSelectedTaskId(taskList[0].id);
    }
  }

  async function refreshRuns() {
    const runList = await api.listRuns();
    setRuns(runList);
    rememberLatestTaskRuns(runList);
    if (!selectedRunId && runList[0]) {
      setSelectedRunId(runList[0].id);
    }
  }

  async function handleClearRunHistory() {
    const historyCount = runs.filter((run) => run.status !== "running").length;
    if (historyCount === 0) {
      flashStatus("没有可清除的历史运行记录");
      return;
    }
    const runningCount = runs.length - historyCount;
    const runningNotice = runningCount > 0
      ? `\n\n当前有 ${runningCount} 个运行中实例，它们不会被停止或清除。`
      : "";
    if (!window.confirm(
      `确定清除 ${historyCount} 条历史运行记录及其日志吗？此操作不可撤销。${runningNotice}`,
    )) {
      return;
    }

    setIsClearingRunHistory(true);
    try {
      const result = await api.clearRunHistory();
      const remainingRuns = await api.listRuns();
      const remainingIds = new Set(remainingRuns.map((run) => run.id));
      const nextActiveRunByTask: Record<string, string> = {};
      for (const run of remainingRuns) {
        if (run.taskId && !nextActiveRunByTask[run.taskId]) {
          nextActiveRunByTask[run.taskId] = run.id;
        }
      }

      setRuns(remainingRuns);
      setSelectedRunId((current) =>
        current && remainingIds.has(current) ? current : remainingRuns[0]?.id ?? null,
      );
      setSelectedRunSnapshot(null);
      setTerminalBuffers((current) =>
        Object.fromEntries(
          Object.entries(current).filter(([runId]) => remainingIds.has(runId)),
        ),
      );
      setActiveRunByTask(nextActiveRunByTask);

      const logWarning = result.failedLogCount > 0
        ? `；${result.failedLogCount} 个日志文件未能删除`
        : "";
      flashStatus(`已清除 ${result.deletedCount} 条历史运行记录${logWarning}`);
    } catch (error) {
      setStatusMessage(`清除运行记录失败: ${String(error)}`);
    } finally {
      setIsClearingRunHistory(false);
    }
  }

  function rememberLatestTaskRuns(runList: RunRecord[]) {
    setActiveRunByTask((current) => {
      const next = { ...current };
      for (const run of runList) {
        if (run.taskId && !next[run.taskId]) next[run.taskId] = run.id;
      }
      return next;
    });
  }

  function selectTaskTerminalRun(run: RunRecord) {
    if (!run.taskId || !tasks.some((task) => task.id === run.taskId)) {
      setStatusMessage("该运行记录对应的任务已被删除，请在运行详情中查看日志。");
      return;
    }
    setSelectedTaskId(run.taskId);
    setActiveRunByTask((current) => ({ ...current, [run.taskId!]: run.id }));
    setView("tasks");
  }

  async function refreshInterpreters() {
    const interpreterList = await api.listInterpreterProfiles();
    setInterpreters(interpreterList);
  }

  async function refreshBundledPythonStatus() {
    const status = await api.getBundledPythonStatus();
    setBundledPythonStatus(status);
  }

  function attachRunToUi(run: RunRecord, nextView: ViewKey = "tasks") {
    const taskId = run.taskId ?? selectedTaskId;
    if (taskId) {
      setActiveRunByTask((current) => ({ ...current, [taskId]: run.id }));
    }
    setSelectedRunId(run.id);
    setView(nextView);
    setTerminalBuffers((current) => ({
      ...current,
      [run.id]: current[run.id] ?? {
        stdout: "",
        stderr: "",
        status: run.status,
        exitCode: null,
        durationMs: null,
        finishedAt: null,
      },
    }));
  }

  useEffect(() => {
    void loadWorkspace();
  }, []);

  useEffect(() => {
    if (!selectedTaskId) {
      return;
    }
    const task = tasks.find((item) => item.id === selectedTaskId);
    if (!task) {
      return;
    }
    const clonedTask = cloneTask(task);
    clonedTask.runtimeParameters = syncRuntimeParameters(
      getRuntimeTemplate(clonedTask),
      clonedTask.runtimeParameters,
      clonedTask.python?.argumentMode ?? "template",
    );
    setDraftTask(clonedTask);
    setTaskDirty(false);
    setImportWarnings([]);
    setInterpreterPickerOpen(false);
    setArgsEditorOpen(false);
    setRuntimeParameterEditorOpen(false);
    setScriptScanPreview(null);
    setScriptScanStatus(null);
    setArgsEditorDraft(task.python?.argsTemplate ?? "");
    workspaceRef.current?.scrollTo?.({ top: 0, left: 0 });
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    let active = true;
    setRuntimeValues({});
    setRuntimeValuesLoading(Boolean(selectedTaskId));
    if (!selectedTaskId) return () => {
      active = false;
    };
    const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
    const parameters = syncRuntimeParameters(
      getRuntimeTemplate(selectedTask),
      selectedTask?.runtimeParameters ?? [],
      selectedTask?.python?.argumentMode ?? "template",
    );
    void api
      .getTaskRuntimeValues(selectedTaskId)
      .then((values) => {
        if (active) setRuntimeValues(runtimeValuesWithDefaults(parameters, values));
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setRuntimeValuesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    setRuntimeValues((current) => runtimeValuesWithDefaults(runtimeParameters, current));
  }, [runtimeParameters]);

  useEffect(() => {
    const selectedTask = tasks.find((task) => task.id === selectedTaskId);
    const python = selectedTask?.python;
    if (!python || python.argumentMode !== "structured" || !python.scriptPath || !python.interpreterProfileId) {
      setScriptScanStatus(null);
      return;
    }
    let active = true;
    void api.checkScriptScanStatus(
      python.scriptPath,
      python.interpreterProfileId,
      python.argsTemplate,
      python.scriptHash ?? null,
      python.scanSnapshot ?? null,
    ).then((status) => {
      if (active) setScriptScanStatus(status);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [selectedTaskId, tasks]);

  useEffect(() => {
    const fallbackPreview = buildPreviewCommand(draftTask, interpreters);
    setCommandPreview(fallbackPreview);
    setRuntimePreviewError("");
    if (!draftTask || missingRuntimeVariables.length > 0) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .previewTaskCommand(draftTask, runtimeValues)
        .then((preview) => {
          if (active) setCommandPreview(preview || fallbackPreview);
        })
        .catch((error) => {
          if (active) setRuntimePreviewError(String(error));
        });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draftTask, interpreters, runtimeValues, missingRuntimeVariables.join("|")]);

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunSnapshot(null);
      return;
    }
    const cached = terminalBuffers[selectedRunId];
    if (cached) {
      setSelectedRunSnapshot({
        stdout: cached.stdout,
        stderr: cached.stderr,
      });
      return;
    }
    setRunOutputLoading(true);
    api
      .getRunOutput(selectedRunId)
      .then((output) => setSelectedRunSnapshot(output))
      .finally(() => setRunOutputLoading(false));
  }, [selectedRunId, terminalBuffers]);

  useEffect(() => {
    if (!activeRunId || terminalBuffers[activeRunId]) return;
    const run = runs.find((item) => item.id === activeRunId);
    if (!run) return;
    let active = true;
    void api.getRunOutput(activeRunId).then((output) => {
      if (!active) return;
      setTerminalBuffers((current) => {
        if (current[activeRunId]) return current;
        return {
          ...current,
          [activeRunId]: {
            ...output,
            status: run.status,
            exitCode: run.exitCode,
            durationMs: run.durationMs,
            finishedAt: run.finishedAt,
          },
        };
      });
    });
    return () => {
      active = false;
    };
  }, [activeRunId, runs, terminalBuffers]);

  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];

    void (async () => {
      const unlistenStdout = await listen<RunStreamEvent>("run://stdout", (event) => {
        setTerminalBuffers((current) => {
          const previous = current[event.payload.runId] ?? {
            stdout: "",
            stderr: "",
            status: "running",
            exitCode: null,
            durationMs: null,
            finishedAt: null,
          };
          return {
            ...current,
            [event.payload.runId]: {
              ...previous,
              stdout: `${previous.stdout}${event.payload.chunk}`,
            },
          };
        });
      });
      const unlistenStderr = await listen<RunStreamEvent>("run://stderr", (event) => {
        setTerminalBuffers((current) => {
          const previous = current[event.payload.runId] ?? {
            stdout: "",
            stderr: "",
            status: "running",
            exitCode: null,
            durationMs: null,
            finishedAt: null,
          };
          return {
            ...current,
            [event.payload.runId]: {
              ...previous,
              stderr: `${previous.stderr}${event.payload.chunk}`,
            },
          };
        });
      });
      const unlistenStatus = await listen<RunStatusEvent>("run://status", (event) => {
        setTerminalBuffers((current) => {
          const previous = current[event.payload.runId] ?? {
            stdout: "",
            stderr: "",
            status: event.payload.status,
            exitCode: null,
            durationMs: null,
            finishedAt: null,
          };
          return {
            ...current,
            [event.payload.runId]: {
              ...previous,
              status: event.payload.status,
              exitCode: event.payload.exitCode,
              durationMs: event.payload.durationMs,
              finishedAt: event.payload.finishedAt,
            },
          };
        });
        if (event.payload.status !== "running") {
          void refreshRuns();
          flashStatus(`任务已结束，状态: ${event.payload.status}`);
        }
      });

      if (active) {
        unlisteners.push(unlistenStdout, unlistenStderr, unlistenStatus);
      } else {
        unlistenStdout();
        unlistenStderr();
        unlistenStatus();
      }
    })();

    return () => {
      active = false;
      unlisteners.forEach((cleanup) => cleanup());
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = settingsDraft.theme;
  }, [settingsDraft.theme]);

  useEffect(() => {
    workspaceRef.current?.scrollTo?.({ top: 0, left: 0 });
  }, [view]);

  function updateDraftTask(updater: (current: TaskRecord) => TaskRecord) {
    setDraftTask((current) => {
      if (!current) return current;
      const next = updater(cloneTask(current));
      next.runtimeParameters = syncRuntimeParameters(
        getRuntimeTemplate(next),
        next.runtimeParameters,
        next.python?.argumentMode ?? "template",
      );
      return next;
    });
    setTaskDirty(true);
  }

  async function handleCopyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      flashStatus(`${label}已复制`);
    } catch (error) {
      setStatusMessage(`复制失败: ${String(error)}`);
    }
  }

  async function handleSaveTask() {
    if (!draftTask) {
      return;
    }
    setIsSavingTask(true);
    try {
      const savedTask = await api.saveTask(draftTask);
      flashStatus("任务已保存");
      await refreshTasks();
      setSelectedTaskId(savedTask.id);
      setDraftTask(cloneTask(savedTask));
      setTaskDirty(false);
    } catch (error) {
      setStatusMessage(`保存失败: ${String(error)}`);
    } finally {
      setIsSavingTask(false);
    }
  }

  async function handleDeleteTask() {
    if (!draftTask?.id) {
      setDraftTask(createEmptyTask("python_task", defaultInterpreterId));
      setTaskDirty(false);
      return;
    }
    if (!window.confirm(`确认删除任务“${draftTask.name || "未命名任务"}”吗？`)) {
      return;
    }
    try {
      await api.deleteTask(draftTask.id);
      flashStatus("任务已删除");
      await refreshTasks();
    } catch (error) {
      setStatusMessage(`删除失败: ${String(error)}`);
    }
  }

  function handleNewTask(kind: TaskKind) {
    setSelectedTaskId(null);
    setDraftTask(createEmptyTask(kind, defaultInterpreterId));
    setTaskDirty(true);
    setView("tasks");
    setRuntimeValues({});
    setRuntimeValuesLoading(false);
  }

  async function handleImportCommand() {
    try {
      const result = await api.importCommand(importText);
      setImportWarnings(result.warnings);
      const importedTask = cloneTask(result.task);
      importedTask.runtimeParameters = syncRuntimeParameters(
        getRuntimeTemplate(importedTask),
        importedTask.runtimeParameters,
        importedTask.python?.argumentMode ?? "template",
      );
      setDraftTask(importedTask);
      setTaskDirty(true);
      setSelectedTaskId(null);
      setImportModalOpen(false);
      flashStatus("已导入命令草稿");
    } catch (error) {
      setStatusMessage(`导入失败: ${String(error)}`);
    }
  }

  async function ensureTaskSaved(): Promise<string | null> {
    if (!draftTask) return null;
    if (!taskDirty && draftTask.id) return draftTask.id;
    setIsSavingTask(true);
    try {
      const savedTask = await api.saveTask(draftTask);
      await refreshTasks();
      setSelectedTaskId(savedTask.id);
      setDraftTask(cloneTask(savedTask));
      setTaskDirty(false);
      return savedTask.id;
    } catch (error) {
      setStatusMessage(`运行前保存失败: ${String(error)}`);
      return null;
    } finally {
      setIsSavingTask(false);
    }
  }

  async function handleStartRun() {
    const taskId = await ensureTaskSaved();
    if (!taskId) {
      return;
    }
    try {
      if (missingRuntimeVariables.length > 0) {
        setStatusMessage(`请填写运行参数: ${missingRuntimeVariables.join("、")}`);
        return;
      }
      const run = await api.startRun(taskId, runtimeValues);
      attachRunToUi(run, "tasks");
      await refreshRuns();
      flashStatus(`已启动任务：${draftTask?.name || "未命名任务"}`);
    } catch (error) {
      setStatusMessage(`运行失败: ${String(error)}`);
      await refreshRuns();
    }
  }

  async function handleStopRun(
    runId: string | null = activeRunId,
    runTaskName: string | null = activeRunTaskName,
  ) {
    if (!runId) {
      return;
    }
    const taskName = runTaskName || "当前任务";
    const runLabel = runId.slice(0, 8);
    if (
      settings.confirmBeforeStop &&
      !window.confirm(`确认停止「${taskName}」运行实例 ${runLabel} 吗？`)
    ) {
      return;
    }
    try {
      await api.stopRun(runId);
      flashStatus(`已向「${taskName}」实例 ${runLabel} 发送停止信号`);
    } catch (error) {
      setStatusMessage(`停止失败: ${String(error)}`);
    }
  }

  async function startScriptScan(scriptPath: string, allowHelp = false) {
    const python = draftTask?.python;
    if (!python?.interpreterProfileId) {
      setStatusMessage("请先选择 Python 解释器，再扫描脚本");
      return;
    }
    setScriptScanBusy(true);
    try {
      const preview = await api.scanPythonScript(
        scriptPath,
        python.interpreterProfileId,
        python.argsTemplate,
        allowHelp,
      );
      const lockedNames = new Set(
        (draftTask?.runtimeParameters ?? [])
          .filter((parameter) => parameter.locked)
          .map((parameter) => parameter.name),
      );
      if (lockedNames.size > 0) {
        const previousByName = new Map(
          (draftTask?.runtimeParameters ?? []).map((parameter) => [parameter.name, parameter]),
        );
        preview.parameters = preview.parameters.map((parameter) => (
          lockedNames.has(parameter.name) ? previousByName.get(parameter.name) ?? parameter : parameter
        ));
        for (const name of lockedNames) {
          if (!preview.parameters.some((parameter) => parameter.name === name)) {
            const locked = previousByName.get(name);
            if (locked) preview.parameters.push(locked);
          }
        }
        const previousRules = python.argumentRules ?? [];
        preview.argumentRules = preview.argumentRules.map((rule) => {
          if (!lockedNames.has(rule.inputName)) return rule;
          return previousRules.find((previous) => previous.id === rule.id) ?? rule;
        });
      }
      setScriptScanPreview(preview);
      setScriptScanStatus(null);
      flashStatus(`扫描完成：识别 ${preview.parameters.length} 个参数`);
    } catch (error) {
      setStatusMessage(`脚本扫描失败: ${String(error)}`);
    } finally {
      setScriptScanBusy(false);
    }
  }

  async function chooseScriptFile() {
    const picked = await api.pickFile(draftTask?.workingDirectory || undefined);
    if (!picked) return;
    updateDraftTask((current) => ({
      ...current,
      python: current.python
        ? {
            ...current.python,
            scriptPath: picked,
          }
        : current.python,
    }));
    await startScriptScan(picked, false);
  }

  async function handleHelpRescan() {
    const path = draftTask?.python?.scriptPath;
    if (!path) return;
    if (!window.confirm("将启动该脚本的 --help 扫描，最长 3 秒。继续吗？")) return;
    await startScriptScan(path, true);
  }

  function applyScriptScanPreview() {
    if (!scriptScanPreview) return;
    const disabledRelations = scriptScanPreview.relationshipCandidates.filter((item) => !item.enabled);
    const preview: ScriptScanPreview = {
      ...scriptScanPreview,
      parameters: scriptScanPreview.parameters.map((parameter) => {
        if (!disabledRelations.some((candidate) => candidate.toFields.includes(parameter.name))) {
          return parameter;
        }
        return { ...parameter, derivedTemplate: null, allowOverride: true };
      }),
    };
    updateDraftTask((current) => {
      if (!current.python) return current;
      const scriptDirectory = current.python.scriptPath.replace(/[\\/][^\\/]+$/, "");
      return {
        ...current,
        name: current.name.trim() ? current.name : preview.taskName,
        notes: current.notes.trim() ? current.notes : preview.description,
        workingDirectory: current.workingDirectory || scriptDirectory,
        runtimeParameters: preview.parameters,
        python: {
          ...current.python,
          argumentMode: "structured",
          argumentRules: preview.argumentRules,
          validationRules: preview.validationRules,
          scriptHash: preview.scriptHash,
          scanSnapshot: preview,
        },
      };
    });
    setRuntimeValues(runtimeValuesWithDefaults(preview.parameters, runtimeValues));
    setScriptScanPreview(null);
    setScriptScanStatus({
      status: "unchanged",
      currentHash: preview.scriptHash,
      diff: { added: [], removed: [], typeChanged: [], defaultChanged: [] },
      preview: null,
    });
    flashStatus("已生成结构化任务草稿，请检查后保存");
  }

  function handleRuntimeValueChange(name: string, value: string) {
    setRuntimeValues((current) => {
      let next = runtimeValuesAfterChange(runtimeParameters, current, name, value);
      if (name === "watch_url") {
        const match = value.match(/[?&]v=([^&#]+)/i);
        if (match) {
          next = runtimeValuesAfterChange(
            runtimeParameters,
            next,
            "video_id",
            decodeURIComponent(match[1]),
          );
        }
      }
      return next;
    });
  }

  async function chooseWorkingDirectory() {
    const picked = await api.pickDirectory(draftTask?.workingDirectory || undefined);
    if (!picked) return;
    updateDraftTask((current) => ({
      ...current,
      workingDirectory: picked,
    }));
  }

  async function chooseRuntimePath(
    name: string,
    type: "file" | "directory",
    currentValue: string,
  ) {
    const initialDirectory = currentValue || draftTask?.workingDirectory || undefined;
    const picked = type === "file"
      ? await api.pickFile(initialDirectory)
      : await api.pickDirectory(initialDirectory);
    if (!picked) return;
    setRuntimeValues((current) => ({ ...current, [name]: picked }));
  }

  async function chooseInterpreterPath() {
    const picked = await api.pickFile(newInterpreterPath || undefined);
    if (!picked) return;
    setNewInterpreterPath(picked);
  }

  function openArgsEditor() {
    setArgsEditorDraft(draftTask?.python?.argsTemplate ?? "");
    setArgsEditorOpen(true);
  }

  async function openRuntimeParameterEditor() {
    const python = draftTask?.python;
    if (python && python.argumentMode !== "structured" && python.scriptPath) {
      await startScriptScan(python.scriptPath, false);
      return;
    }
    setRuntimeParameterEditorOpen(true);
  }

  function applyArgsEditor() {
    updateDraftTask((current) => ({
      ...current,
      python: current.python
        ? {
            ...current.python,
            argsTemplate: argsEditorDraft,
          }
        : current.python,
    }));
    setArgsEditorOpen(false);
  }

  async function handleRevealTaskScript() {
    const scriptPath = draftTask?.python?.scriptPath;
    if (!scriptPath) {
      flashStatus("当前任务还没有脚本路径");
      return;
    }
    try {
      await revealItemInDir(scriptPath);
    } catch (error) {
      setStatusMessage(`无法定位脚本: ${String(error)}`);
    }
  }

  async function handleOpenTaskWorkingDirectory() {
    const directory = resolveTaskWorkingDirectory(draftTask);
    if (!directory) {
      flashStatus("当前任务还没有可打开的工作目录");
      return;
    }
    try {
      await openPath(directory);
    } catch (error) {
      setStatusMessage(`无法打开工作目录: ${String(error)}`);
    }
  }

  async function handleRevealRunLog(kind: "stdout" | "stderr") {
    const targetPath =
      kind === "stdout" ? selectedRun?.stdoutLogPath : selectedRun?.stderrLogPath;
    if (!targetPath) {
      flashStatus("当前运行记录没有对应日志");
      return;
    }
    try {
      await revealItemInDir(targetPath);
    } catch (error) {
      setStatusMessage(`无法定位日志: ${String(error)}`);
    }
  }

  async function handleOpenSelectedRunDirectory() {
    const directory = selectedRun?.workingDirectory;
    if (!directory) {
      flashStatus("当前运行记录没有工作目录");
      return;
    }
    try {
      await openPath(directory);
    } catch (error) {
      setStatusMessage(`无法打开运行目录: ${String(error)}`);
    }
  }

  async function handleRerunSelectedTask() {
    if (!selectedRun?.taskId) {
      flashStatus("这条运行记录没有可重跑的任务");
      return;
    }
    try {
      const run = await api.startRun(selectedRun.taskId, selectedRun.runtimeValues ?? {});
      attachRunToUi(run, "tasks");
      await refreshRuns();
      flashStatus("已从运行记录重新启动任务");
    } catch (error) {
      setStatusMessage(`重跑失败: ${String(error)}`);
    }
  }

  async function handleExportWorkspace() {
    try {
      const destination = await saveDialog({
        defaultPath: "script-workbench-backup.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!destination) return;
      const payload: WorkspaceBackup = {
        version: WORKSPACE_BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        tasks,
        interpreters,
        settings: settingsDraft,
      };
      await api.writeTextFile(destination, JSON.stringify(payload, null, 2));
      flashStatus(`工作区已导出到 ${destination}`);
    } catch (error) {
      setStatusMessage(`导出失败: ${String(error)}`);
    }
  }

  async function handleImportWorkspace() {
    try {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!selected || Array.isArray(selected)) return;
      if (!window.confirm("导入会把备份中的任务和解释器合并到当前工作区，继续吗？")) {
        return;
      }

      const rawText = await api.readTextFile(selected);
      const backup = JSON.parse(rawText) as Partial<WorkspaceBackup>;
      if (!Array.isArray(backup.tasks) || !Array.isArray(backup.interpreters)) {
        throw new Error("备份文件格式不正确");
      }
      if (backup.version !== undefined && ![1, 2, 3, 4].includes(backup.version)) {
        throw new Error(`暂不支持工作区备份版本 ${backup.version}`);
      }

      const nonDefaultProfiles = backup.interpreters.filter((item) => !item.isDefault);
      const defaultProfiles = backup.interpreters.filter((item) => item.isDefault);
      for (const profile of [...nonDefaultProfiles, ...defaultProfiles]) {
        await api.saveInterpreterProfile(profile);
      }
      if (backup.settings) {
        await api.saveSettings(backup.settings);
      }
      for (const task of backup.tasks) {
        const normalizedTask = cloneTask(task);
        if ((backup.version ?? 3) < 4 && normalizedTask.python) {
          normalizedTask.python.argumentMode = "template";
          normalizedTask.python.argumentRules = [];
          normalizedTask.python.validationRules = [];
          normalizedTask.python.scriptHash = null;
          normalizedTask.python.scanSnapshot = null;
        }
        await api.saveTask(normalizedTask);
      }

      await loadWorkspace();
      flashStatus(
        `已导入 ${backup.tasks.length} 个任务，${backup.interpreters.length} 个解释器`,
      );
    } catch (error) {
      setStatusMessage(`导入失败: ${String(error)}`);
    }
  }

  async function handleInstallBundledPython(sourcePath?: string) {
    try {
      let resolvedSource = sourcePath;
      if (!resolvedSource) {
        const picked = await api.pickFile(undefined);
        if (!picked) return;
        resolvedSource = picked;
      }
      setBundledPythonBusy(true);
      const status = await api.installBundledPython(resolvedSource);
      setBundledPythonStatus(status);
      await refreshInterpreters();
      flashStatus("bundled Python 已安装");
    } catch (error) {
      setStatusMessage(`安装 bundled Python 失败: ${String(error)}`);
    } finally {
      setBundledPythonBusy(false);
    }
  }

  async function handleSaveSettings() {
    try {
      const saved = await api.saveSettings(settingsDraft);
      setSettings(saved);
      setSettingsDraft(saved);
      flashStatus("设置已保存");
    } catch (error) {
      setStatusMessage(`设置保存失败: ${String(error)}`);
    }
  }

  async function handleSaveInterpreter(defaultMode = false, profile?: InterpreterProfile) {
    try {
      const baseProfile =
        profile ?? {
          id: "",
          name: newInterpreterName || "自定义解释器",
          type: "external" as const,
          executablePath: newInterpreterPath,
          isDefault: defaultMode,
        };
      const saved = await api.saveInterpreterProfile({
        ...baseProfile,
        isDefault: defaultMode || baseProfile.isDefault,
      });
      setNewInterpreterName("");
      setNewInterpreterPath("");
      if (saved.isDefault) {
        setSettingsDraft((current) => ({ ...current, defaultInterpreterId: saved.id }));
      }
      await refreshInterpreters();
      flashStatus("解释器配置已保存");
    } catch (error) {
      setStatusMessage(`解释器保存失败: ${String(error)}`);
    }
  }

  async function handleDeleteInterpreter(profileId: string) {
    if (!window.confirm("确认删除这个解释器配置吗？")) {
      return;
    }
    try {
      await api.deleteInterpreterProfile(profileId);
      await refreshInterpreters();
      flashStatus("解释器已删除");
    } catch (error) {
      setStatusMessage(`解释器删除失败: ${String(error)}`);
    }
  }

  async function handleCheckInterpreter(profileId: string) {
    try {
      const health = await api.checkInterpreterHealth(profileId);
      setSelectedInterpreterHealth((current) => ({ ...current, [profileId]: health }));
    } catch (error) {
      setStatusMessage(`解释器检测失败: ${String(error)}`);
    }
  }

  const dashboardStats = useMemo(() => {
    const runningCount = runs.filter((run) => run.status === "running").length;
    const failedCount = runs.filter((run) => run.status === "failed").length;
    const favoriteCount = tasks.filter((task) => task.favorite).length;
    return {
      totalTasks: tasks.length,
      runningCount,
      failedCount,
      favoriteCount,
    };
  }, [runs, tasks]);

  return (
    <AppErrorBoundary>
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">SW</div>
          <div>
            <h1>Script Workbench</h1>
            <p>内置终端的脚本工作台</p>
          </div>
        </div>

        <nav className="nav">
          {[
            ["dashboard", "概览"],
            ["tasks", "任务库"],
            ["runs", "运行记录"],
            ["settings", "设置"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={`nav-button ${view === key ? "active" : ""}`}
              onClick={() => setView(key as ViewKey)}
            >
              {label}
            </button>
          ))}
        </nav>

        <section className="sidebar-meta">
          <div>
            <span>任务</span>
            <strong>{tasks.length}</strong>
          </div>
          <div>
            <span>运行中</span>
            <strong>{dashboardStats.runningCount}</strong>
          </div>
          <div>
            <span>默认解释器</span>
            <strong>
              {interpreters.find((item) => item.id === defaultInterpreterId)?.name ?? "未配置"}
            </strong>
          </div>
        </section>
      </aside>

      <main ref={workspaceRef} className="workspace" data-layout-boundary="workspace">
        <header className="topbar" data-scroll-behavior="flow">
          <div>
            <h2>
              {view === "dashboard" && "概览"}
              {view === "tasks" && "任务库"}
              {view === "runs" && "运行记录"}
              {view === "settings" && "设置"}
            </h2>
            <p>{statusMessage}</p>
          </div>
          <div className="topbar-actions">
            {view === "tasks" && draftTask && (
              <button
                className="primary-button persistent-run-button"
                disabled={
                  isSavingTask ||
                  runtimeValuesLoading ||
                  missingRuntimeVariables.length > 0
                }
                title={
                  missingRuntimeVariables.length > 0
                    ? `请先填写：${missingRuntimeVariables.join("、")}`
                    : "使用本次运行参数启动当前任务"
                }
                onClick={() => void handleStartRun()}
              >
                {isSavingTask
                  ? "保存中..."
                  : "开始运行"}
              </button>
            )}
            <button className="ghost-button" onClick={() => void loadWorkspace()}>
              刷新
            </button>
            {view === "tasks" && (
              <>
                <button className="secondary-button" onClick={() => handleNewTask("python_task")}>
                  新建 Python
                </button>
                <button
                  className="secondary-button"
                  onClick={() => handleNewTask("command_task")}
                >
                  新建命令
                </button>
                <button className="ghost-button" onClick={() => setImportModalOpen(true)}>
                  导入命令
                </button>
              </>
            )}
          </div>
        </header>

        {isLoading ? (
          <section className="panel loading-panel">正在加载工作区...</section>
        ) : (
          <>
            {view === "dashboard" && (
              <section className="dashboard-grid">
                <div className="panel stat-card">
                  <span>总任务数</span>
                  <strong>{dashboardStats.totalTasks}</strong>
                </div>
                <div className="panel stat-card">
                  <span>运行中任务</span>
                  <strong>{dashboardStats.runningCount}</strong>
                </div>
                <div className="panel stat-card">
                  <span>失败记录</span>
                  <strong>{dashboardStats.failedCount}</strong>
                </div>
                <div className="panel stat-card">
                  <span>收藏任务</span>
                  <strong>{dashboardStats.favoriteCount}</strong>
                </div>
                <div className="panel wide-card">
                  <h3>最近运行</h3>
                  <div className="table-list">
                    {runs.slice(0, 6).map((run) => (
                      <button
                        key={run.id}
                        className="table-row clickable"
                        onClick={() => {
                          setSelectedRunId(run.id);
                          setView("runs");
                        }}
                      >
                        <span>{run.taskName || "已删除任务"}</span>
                        <span className={`status-pill ${run.status}`}>{run.status}</span>
                        <span>{formatDateTime(run.startedAt)}</span>
                      </button>
                    ))}
                    {runs.length === 0 && <p className="muted">还没有运行记录。</p>}
                  </div>
                </div>
                <div className="panel wide-card">
                  <h3>最近任务</h3>
                  <div className="table-list">
                    {tasks.slice(0, 6).map((task) => (
                      <button
                        key={task.id ?? task.name}
                        className="table-row clickable"
                        onClick={() => {
                          setSelectedTaskId(task.id);
                          setView("tasks");
                        }}
                      >
                        <span>{task.name || "未命名任务"}</span>
                        <span>{task.kind === "python_task" ? "Python" : "命令"}</span>
                        <span>{task.favorite ? "收藏" : "普通"}</span>
                      </button>
                    ))}
                    {tasks.length === 0 && <p className="muted">先创建一个任务。</p>}
                  </div>
                </div>
              </section>
            )}

            {view === "tasks" && (
              <section className="tasks-layout">
                <div className="panel task-list-panel">
                  <div className="panel-header">
                    <div>
                      <h3>任务列表</h3>
                      <p className="muted">按名称、标签、类型和收藏状态筛选。</p>
                    </div>
                  </div>
                  <div className="filter-grid">
                    <input
                      className="text-input compact"
                      value={taskSearch}
                      placeholder="搜索名称、脚本、标签"
                      onChange={(event) => setTaskSearch(event.currentTarget.value)}
                    />
                    <ChoiceField
                      value={taskKindFilter}
                      options={[
                        { value: "all", label: "全部类型" },
                        { value: "python_task", label: "Python" },
                        { value: "command_task", label: "命令" },
                      ]}
                      onChange={(value) => setTaskKindFilter(value as "all" | TaskKind)}
                    />
                    <SafeToggle
                      checked={favoritesOnly}
                      label="仅收藏"
                      onChange={setFavoritesOnly}
                    />
                  </div>
                  <div
                    className="task-list"
                    data-scroll-owner="column"
                    role="region"
                    aria-label="可滚动任务列表"
                    tabIndex={0}
                  >
                    {visibleTasks.map((task) => (
                      <button
                        key={task.id ?? task.name}
                        className={`task-card ${task.id === selectedTaskId ? "selected" : ""}`}
                        onClick={() => {
                          if (taskDirty && !window.confirm("当前修改未保存，仍然切换吗？")) {
                            return;
                          }
                          setSelectedTaskId(task.id);
                        }}
                      >
                        <div className="task-card-top">
                          <strong>{task.name || "未命名任务"}</strong>
                          {task.favorite && <span className="favorite-star">★</span>}
                        </div>
                        <span className="task-kind-tag">
                          {task.kind === "python_task" ? "Python" : "命令"}
                        </span>
                        <small className="task-card-detail">
                          {task.kind === "python_task"
                            ? task.python?.scriptPath || "未设置脚本路径"
                            : task.command?.command || "未设置命令"}
                        </small>
                      </button>
                    ))}
                    {visibleTasks.length === 0 && (
                      <div className="empty-state">
                        <p>没有匹配的任务。</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="task-workbench-layout">
                  <div
                    className="task-config-column"
                    data-scroll-region="task-config"
                    role="region"
                    aria-label="可滚动任务配置"
                    tabIndex={0}
                  >
                  <div className="panel task-editor-panel">
                    <div className="panel-header">
                      <div>
                        <h3>{draftTask?.name || "任务详情"}</h3>
                        <p className="muted">
                          {draftTask?.kind === "python_task"
                            ? "结构化 Python 任务"
                            : draftTask?.kind === "command_task"
                              ? "原始命令任务"
                              : "新建或选择一个任务"}
                        </p>
                      </div>
                      <div className="panel-actions">
                        <button
                          className="ghost-button"
                          disabled={!commandPreview}
                          onClick={() => void handleCopyText("命令预览", commandPreview)}
                        >
                          复制命令
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() => void handleOpenTaskWorkingDirectory()}
                        >
                          打开工作目录
                        </button>
                        {draftTask?.kind === "python_task" && (
                          <button
                            className="ghost-button"
                            onClick={() => void handleRevealTaskScript()}
                          >
                            定位脚本
                          </button>
                        )}
                        <button className="ghost-button" onClick={() => void handleDeleteTask()}>
                          删除
                        </button>
                        <button
                          className="secondary-button"
                          disabled={!draftTask}
                          onClick={() => void handleSaveTask()}
                        >
                          {isSavingTask ? "保存中..." : "保存任务"}
                        </button>
                      </div>
                    </div>

                    {draftTask ? (
                      <div className="editor-grid">
                        <label className="field">
                          <span>任务名称</span>
                          <SafeSingleLineInput
                            value={draftTask.name}
                            ariaLabel="任务名称"
                            placeholder="输入任务名称"
                            onChange={(value) =>
                              updateDraftTask((current) => ({
                                ...current,
                                name: value,
                              }))
                            }
                          />
                        </label>

                        <div className="field inline">
                          <SafeToggle
                            checked={draftTask.favorite}
                            label="收藏"
                            onChange={(next) =>
                              updateDraftTask((current) => ({
                                ...current,
                                favorite: next,
                              }))
                            }
                          />
                          <label className="field grow">
                            <span>标签（逗号分隔）</span>
                            <SafeSingleLineInput
                              value={draftTask.tags.join(", ")}
                              ariaLabel="标签（逗号分隔）"
                              placeholder="输入标签，逗号分隔"
                              onChange={(value) =>
                                updateDraftTask((current) => ({
                                  ...current,
                                  tags: parseCommaSeparated(value),
                                }))
                              }
                            />
                          </label>
                        </div>

                        {draftTask.kind === "python_task" && draftTask.python && (
                          <>
                            <label className="field">
                              <span>解释器</span>
                              <div className="inline-picker">
                                <div className="picker-value">
                                  {interpreters.find(
                                    (interpreter) =>
                                      interpreter.id === draftTask.python?.interpreterProfileId,
                                  )?.name || "请选择解释器"}
                                </div>
                                <button
                                  className="ghost-button"
                                  onClick={() => setInterpreterPickerOpen(true)}
                                >
                                  选择解释器
                                </button>
                              </div>
                            </label>

                            <label className="field">
                              <span>脚本路径</span>
                              <div className="path-row">
                                <SafeSingleLineInput
                                  value={draftTask.python.scriptPath}
                                  ariaLabel="脚本路径"
                                  placeholder="输入或选择脚本路径"
                                  onChange={(value) =>
                                    updateDraftTask((current) => ({
                                      ...current,
                                      python: current.python
                                        ? {
                                            ...current.python,
                                            scriptPath: value,
                                          }
                                        : current.python,
                                    }))
                                  }
                                />
                                <button className="ghost-button" onClick={() => void chooseScriptFile()}>
                                  选择文件
                                </button>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  disabled={scriptScanBusy || !draftTask.python.scriptPath}
                                  onClick={() => void startScriptScan(draftTask.python?.scriptPath ?? "", false)}
                                >
                                  {scriptScanBusy ? "扫描中..." : "扫描参数"}
                                </button>
                              </div>
                            </label>

                            {draftTask.python.argumentMode === "structured" ? (
                              <div className="field structured-mode-card">
                                <span>参数模式</span>
                                <div className="inline-picker">
                                  <div className="picker-value">
                                    结构化 argv · {draftTask.python.argumentRules?.length ?? 0} 条规则
                                  </div>
                                  <button
                                    type="button"
                                    className="ghost-button"
                                    onClick={() => updateDraftTask((current) => ({
                                      ...current,
                                      python: current.python ? {
                                        ...current.python,
                                        argumentMode: "template",
                                      } : current.python,
                                    }))}
                                  >
                                    切换模板模式
                                  </button>
                                </div>
                                <small className="muted">
                                  运行时直接构造参数数组；预览与实际 argv 使用同一组规则。
                                </small>
                              </div>
                            ) : (
                              <label className="field">
                                <span>参数模板</span>
                                <div className="inline-picker">
                                  <pre className="command-preview compact-preview">
                                    {draftTask.python.argsTemplate || "当前没有参数模板"}
                                  </pre>
                                  <button className="ghost-button" onClick={() => openArgsEditor()}>
                                    编辑参数模板
                                  </button>
                                </div>
                                <small className="muted">
                                  动态值使用 {"{{变量名}}"}；选择脚本后可扫描为结构化控件。
                                </small>
                              </label>
                            )}

                            {scriptScanStatus?.status === "changed" && (
                              <div className="alert-banner warning scan-change-banner">
                                <div>
                                  <strong>脚本已变化</strong>
                                  <span>
                                    新增 {scriptScanStatus.diff.added.length}、删除 {scriptScanStatus.diff.removed.length}、
                                    类型变化 {scriptScanStatus.diff.typeChanged.length}、默认值变化 {scriptScanStatus.diff.defaultChanged.length}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="secondary-button"
                                  onClick={() => void startScriptScan(draftTask.python?.scriptPath ?? "", false)}
                                >
                                  查看差异并更新
                                </button>
                              </div>
                            )}
                            {scriptScanStatus?.status === "missing" && (
                              <div className="alert-banner warning">脚本文件当前不存在，请重新选择路径。</div>
                            )}
                          </>
                        )}

                        {draftTask.kind === "command_task" && draftTask.command && (
                          <label className="field">
                            <span>完整命令</span>
                            <SafeMultilineInput
                              value={draftTask.command.command}
                              minHeight={116}
                              onChange={(value) =>
                                updateDraftTask((current) => ({
                                  ...current,
                                  command: current.command
                                    ? {
                                        ...current.command,
                                        command: value,
                                      }
                                    : current.command,
                                }))
                              }
                            />
                          </label>
                        )}

                        <div className="field">
                          <span>运行表单</span>
                          <div className="inline-picker">
                            <div className="picker-value">
                              {runtimeParameters.length > 0
                                ? `${runtimeParameters.length} 个表单字段`
                                : "当前还没有运行表单字段"}
                            </div>
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() => void openRuntimeParameterEditor()}
                            >
                              编辑运行表单
                            </button>
                          </div>
                          <small className="muted">
                            常用字段直接显示，较少使用的选项收在高级设置中。
                          </small>
                        </div>

                        <label className="field">
                          <span>工作目录</span>
                          <div className="path-row">
                            <SafeSingleLineInput
                              value={draftTask.workingDirectory}
                              ariaLabel="工作目录"
                              placeholder="输入或选择工作目录"
                              onChange={(value) =>
                                updateDraftTask((current) => ({
                                  ...current,
                                  workingDirectory: value,
                                }))
                              }
                            />
                            <button className="ghost-button" onClick={() => void chooseWorkingDirectory()}>
                              选择目录
                            </button>
                          </div>
                        </label>

                        <label className="field">
                          <span>环境变量（KEY=VALUE，每行一个）</span>
                          <SafeMultilineInput
                            value={draftTask.envVars
                              .map((entry) => `${entry.key}=${entry.value}`)
                              .join("\n")}
                            minHeight={116}
                            onChange={(value) =>
                              updateDraftTask((current) => ({
                                ...current,
                                envVars: value
                                  .split("\n")
                                  .map((line) => line.trim())
                                  .filter(Boolean)
                                  .map((line) => {
                                    const [key, ...rest] = line.split("=");
                                    return { key, value: rest.join("=") };
                                  }),
                              }))
                            }
                          />
                        </label>

                        <div className="reliability-card">
                          <div>
                            <h4>运行可靠性</h4>
                            <p className="muted">为当前任务设置超时、重试、并发和输出编码。</p>
                          </div>
                          <div className="reliability-grid">
                            <label className="field">
                              <span>超时秒数（0 表示不限时）</span>
                              <SafeSingleLineInput
                                value={String(draftTask.reliability.timeoutSeconds)}
                                ariaLabel="超时秒数"
                                onChange={(value) => updateDraftTask((current) => ({
                                  ...current,
                                  reliability: {
                                    ...current.reliability,
                                    timeoutSeconds: Math.max(0, Number.parseInt(value, 10) || 0),
                                  },
                                }))}
                              />
                            </label>
                            <label className="field">
                              <span>失败重试次数（0-10）</span>
                              <SafeSingleLineInput
                                value={String(draftTask.reliability.retryCount)}
                                ariaLabel="失败重试次数"
                                onChange={(value) => updateDraftTask((current) => ({
                                  ...current,
                                  reliability: {
                                    ...current.reliability,
                                    retryCount: Math.min(10, Math.max(0, Number.parseInt(value, 10) || 0)),
                                  },
                                }))}
                              />
                            </label>
                            <label className="field">
                              <span>重试间隔秒数</span>
                              <SafeSingleLineInput
                                value={String(draftTask.reliability.retryDelaySeconds)}
                                ariaLabel="重试间隔秒数"
                                onChange={(value) => updateDraftTask((current) => ({
                                  ...current,
                                  reliability: {
                                    ...current.reliability,
                                    retryDelaySeconds: Math.max(0, Number.parseInt(value, 10) || 0),
                                  },
                                }))}
                              />
                            </label>
                          </div>
                          <label className="field">
                            <span>并发策略</span>
                            <ChoiceField
                              value={draftTask.reliability.concurrencyPolicy}
                              options={[
                                { value: "allow", label: "允许并发" },
                                { value: "reject", label: "已有运行时拒绝" },
                                { value: "stop_existing", label: "停止旧运行" },
                              ]}
                              onChange={(value) => updateDraftTask((current) => ({
                                ...current,
                                reliability: {
                                  ...current.reliability,
                                  concurrencyPolicy: value as TaskRecord["reliability"]["concurrencyPolicy"],
                                },
                              }))}
                            />
                          </label>
                          <label className="field">
                            <span>输出编码</span>
                            <ChoiceField
                              value={draftTask.reliability.outputEncoding}
                              options={[
                                { value: "utf8", label: "UTF-8" },
                                { value: "gbk", label: "GBK / 中文 Windows" },
                              ]}
                              onChange={(value) => updateDraftTask((current) => ({
                                ...current,
                                reliability: {
                                  ...current.reliability,
                                  outputEncoding: value as TaskRecord["reliability"]["outputEncoding"],
                                },
                              }))}
                            />
                          </label>
                        </div>

                        <label className="field">
                          <span>备注</span>
                          <SafeMultilineInput
                            value={draftTask.notes}
                            minHeight={116}
                            onChange={(value) =>
                              updateDraftTask((current) => ({
                                ...current,
                                notes: value,
                              }))
                            }
                          />
                        </label>

                      </div>
                    ) : (
                      <div className="empty-state">
                        <p>从左侧选择任务，或者新建一个任务。</p>
                      </div>
                    )}
                  </div>

                  </div>

                  <div
                    className="task-run-column"
                    data-scroll-region="task-run"
                    role="region"
                    aria-label="可滚动任务运行"
                    tabIndex={0}
                  >
                    <div className="panel runtime-panel">
                      <div className="panel-header">
                        <div>
                          <h3>任务运行</h3>
                          <p className="muted">填写本次运行参数，不会修改任务配置模板。</p>
                        </div>
                        <button
                          className="primary-button"
                          disabled={
                            !draftTask ||
                            isSavingTask ||
                            runtimeValuesLoading ||
                            missingRuntimeVariables.length > 0
                          }
                          onClick={() => void handleStartRun()}
                        >
                          {isSavingTask
                            ? "保存中..."
                            : "运行任务"}
                        </button>
                      </div>

                      {runtimeValuesLoading ? (
                        <div className="runtime-empty">正在读取上次运行参数...</div>
                      ) : runtimeParameters.length > 0 ? (
                        <RuntimeParameterFields
                          parameters={runtimeParameters}
                          values={runtimeValues}
                          errors={runtimeValueErrors}
                          onChange={handleRuntimeValueChange}
                          onPickPath={(name, type, value) =>
                            void chooseRuntimePath(name, type, value)
                          }
                          repeatParameterNames={(draftTask?.python?.argumentRules ?? [])
                            .filter((rule) => rule.emission === "repeat")
                            .map((rule) => rule.inputName)}
                        />
                      ) : (
                        <div className="runtime-empty">
                          当前任务没有动态参数，可直接运行。需要动态编号时，在模板中写入
                          <code>{" {{video_id}} "}</code>或<code>{" {{book_id}} "}</code>。
                        </div>
                      )}

                      {missingRuntimeVariables.length > 0 && (
                        <div className="alert-banner warning">
                          请检查：{missingRuntimeVariables.map((name) => (
                            `${runtimeParameters.find((item) => item.name === name)?.label || name}（${runtimeValueErrors[name]}）`
                          )).join("、")}
                        </div>
                      )}
                      {runtimePreviewError && (
                        <div className="alert-banner warning">{runtimePreviewError}</div>
                      )}
                      <div className="field runtime-preview-field">
                        <span>本次运行命令</span>
                        <pre className="command-preview">{commandPreview}</pre>
                      </div>
                    </div>

                  <div className="panel terminal-panel">
                    <div className="panel-header">
                      <div>
                        <h3>内置终端</h3>
                        <p className="muted">任务输出始终在软件内显示，不弹系统终端。</p>
                      </div>
                      <div className="panel-actions">
                        <button
                          className="ghost-button"
                          disabled={!activeTerminal?.stdout && !activeTerminal?.stderr}
                          onClick={() =>
                            void handleCopyText(
                              "终端输出",
                              `${activeTerminal?.stdout ?? ""}\n${activeTerminal?.stderr ?? ""}`,
                            )
                          }
                        >
                          复制输出
                        </button>
                        <button
                          className="ghost-button"
                          disabled={!activeTerminal}
                          onClick={() =>
                            setTerminalBuffers((current) => {
                              if (!activeRunId || !current[activeRunId]) return current;
                              return {
                                ...current,
                                [activeRunId]: {
                                  ...current[activeRunId],
                                  stdout: "",
                                  stderr: "",
                                },
                              };
                            })
                          }
                        >
                          清空视图
                        </button>
                        <button
                          className="secondary-button"
                          disabled={!activeRunId || activeTerminal?.status !== "running"}
                          onClick={() => void handleStopRun()}
                        >
                          {activeRunTaskName ? `停止「${activeRunTaskName}」` : "停止运行"}
                        </button>
                      </div>
                    </div>
                    {activeRunId ? (
                      <>
                        {taskTerminalRuns.length > 1 && (
                          <div className="terminal-run-tabs" aria-label="当前任务运行实例">
                            {taskTerminalRuns.slice(0, 8).map((run) => (
                              <button
                                type="button"
                                className={`terminal-run-tab ${run.id === activeRunId ? "active" : ""}`}
                                aria-pressed={run.id === activeRunId}
                                key={run.id}
                                onClick={() => selectTaskTerminalRun(run)}
                              >
                                {run.id.slice(0, 8)} · {run.status}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="terminal-meta">
                          <span>Run ID: {activeRunId}</span>
                          <span className={`status-pill ${activeTerminal?.status ?? "running"}`}>
                            {activeTerminal?.status ?? "running"}
                          </span>
                          <span>退出码: {activeTerminal?.exitCode ?? "—"}</span>
                          <span>耗时: {formatDuration(activeTerminal?.durationMs ?? null)}</span>
                        </div>
                        <div className="terminal-grid">
                          <div>
                            <h4>Stdout</h4>
                            <TerminalOutputView
                              stream="stdout"
                              output={activeTerminal?.stdout ?? ""}
                              emptyText="等待输出..."
                            />
                          </div>
                          <div>
                            <h4>
                              {activeTerminal?.status === "finished"
                                ? "进程信息（stderr）"
                                : "错误与进程信息（stderr）"}
                            </h4>
                            <TerminalOutputView
                              stream="stderr"
                              output={activeTerminal?.stderr ?? ""}
                              emptyText="暂无进程信息。"
                            />
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="empty-state">
                        <p>当前任务还没有终端实例。保存任务后点击“运行任务”。</p>
                      </div>
                    )}
                  </div>
                  </div>
                </div>
              </section>
            )}

            {view === "runs" && (
              <section className="runs-layout">
                <div className="panel runs-list-panel">
                  <div className="panel-header">
                    <div>
                      <h3>运行记录</h3>
                      <p className="muted">按任务名、命令和状态搜索历史运行。</p>
                    </div>
                    <div className="panel-actions">
                      <button className="ghost-button" onClick={() => void refreshRuns()}>
                        刷新列表
                      </button>
                      <button
                        className="ghost-button danger"
                        disabled={
                          isClearingRunHistory ||
                          !runs.some((run) => run.status !== "running")
                        }
                        onClick={() => void handleClearRunHistory()}
                      >
                        {isClearingRunHistory ? "正在清除..." : "一键清除历史"}
                      </button>
                    </div>
                  </div>
                  <div className="filter-grid run-filter-grid">
                    <input
                      className="text-input compact"
                      value={runSearch}
                      placeholder="搜索任务、命令或目录"
                      onChange={(event) => setRunSearch(event.currentTarget.value)}
                    />
                    <select
                      className="text-input compact run-status-select"
                      aria-label="运行状态筛选"
                      value={runStatusFilter}
                      onChange={(event) => setRunStatusFilter(event.currentTarget.value)}
                    >
                      <option value="all">全部状态</option>
                      <option value="running">running</option>
                      <option value="finished">finished</option>
                      <option value="failed">failed</option>
                      <option value="stopped">stopped</option>
                      <option value="timed_out">timed_out</option>
                      <option value="interrupted">interrupted</option>
                    </select>
                  </div>
                  <div className="table-list">
                    {visibleRuns.map((run) => (
                      <button
                        key={run.id}
                        className={`table-row clickable ${selectedRunId === run.id ? "selected" : ""}`}
                        onClick={() => setSelectedRunId(run.id)}
                      >
                        <span>{run.taskName || "已删除任务"}</span>
                        <span className={`status-pill ${run.status}`}>{run.status}</span>
                        <span>{formatDateTime(run.startedAt)}</span>
                      </button>
                    ))}
                    {visibleRuns.length === 0 && <p className="muted">暂无匹配的运行记录。</p>}
                  </div>
                </div>

                <div className="panel run-details-panel">
                  <div className="panel-header">
                    <div>
                      <h3>{selectedRun?.taskName || "运行详情"}</h3>
                      <p className="muted">查看命令快照、输出、耗时和退出码。</p>
                    </div>
                    {selectedRun && (
                      <div className="panel-actions">
                        <button
                          className="ghost-button"
                          onClick={() =>
                            void handleCopyText("命令快照", selectedRun.commandPreview)
                          }
                        >
                          复制命令
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() =>
                            void handleCopyText(
                              "运行输出",
                              `${selectedRunSnapshot?.stdout ?? ""}\n${selectedRunSnapshot?.stderr ?? ""}`,
                            )
                          }
                        >
                          复制输出
                        </button>
                        <button
                          className="ghost-button"
                          disabled={!selectedRun.taskId}
                          onClick={() => void handleRerunSelectedTask()}
                        >
                          重跑任务
                        </button>
                        {selectedRun.status === "running" && (
                          <button
                            className="secondary-button"
                            onClick={() =>
                              void handleStopRun(selectedRun.id, selectedRun.taskName)
                            }
                          >
                            停止此实例
                          </button>
                        )}
                        <button
                          className="ghost-button"
                          onClick={() => void handleOpenSelectedRunDirectory()}
                        >
                          打开工作目录
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() => void handleRevealRunLog("stdout")}
                        >
                          定位 Stdout
                        </button>
                        <button
                          className="ghost-button"
                          onClick={() => void handleRevealRunLog("stderr")}
                        >
                          定位 Stderr
                        </button>
                        <button
                          className="secondary-button"
                          onClick={() => selectTaskTerminalRun(selectedRun)}
                        >
                          在内置终端中查看
                        </button>
                      </div>
                    )}
                  </div>
                  {selectedRun ? (
                    <>
                      <div className="detail-grid">
                        <div>
                          <span>状态</span>
                          <strong className={`status-pill ${selectedRun.status}`}>
                            {selectedRun.status}
                          </strong>
                        </div>
                        <div>
                          <span>开始时间</span>
                          <strong>{formatDateTime(selectedRun.startedAt)}</strong>
                        </div>
                        <div>
                          <span>结束时间</span>
                          <strong>{formatDateTime(selectedRun.finishedAt)}</strong>
                        </div>
                        <div>
                          <span>耗时</span>
                          <strong>{formatDuration(selectedRun.durationMs)}</strong>
                        </div>
                        <div>
                          <span>退出码</span>
                          <strong>{selectedRun.exitCode ?? "—"}</strong>
                        </div>
                        <div>
                          <span>执行尝试</span>
                          <strong>{selectedRun.attemptCount ?? 1}</strong>
                        </div>
                        <div>
                          <span>终止原因</span>
                          <strong>{selectedRun.terminationReason || "正常结束"}</strong>
                        </div>
                        <div>
                          <span>工作目录</span>
                          <strong>{selectedRun.workingDirectory || "自动推导"}</strong>
                        </div>
                      </div>
                      <label className="field">
                        <span>命令快照</span>
                        <pre className="command-preview">{selectedRun.commandPreview}</pre>
                      </label>
                      <div className="terminal-grid run-record-terminal-grid">
                        <div>
                          <h4>Stdout</h4>
                          <TerminalOutputView
                            stream="stdout"
                            output={runOutputLoading ? "加载中..." : selectedRunSnapshot?.stdout ?? ""}
                            emptyText="暂无输出。"
                          />
                        </div>
                        <div>
                          <h4>
                            {selectedRun?.status === "finished"
                              ? "进程信息（stderr）"
                              : "错误与进程信息（stderr）"}
                          </h4>
                          <TerminalOutputView
                            stream="stderr"
                            output={runOutputLoading ? "加载中..." : selectedRunSnapshot?.stderr ?? ""}
                            emptyText="暂无进程信息。"
                          />
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">
                      <p>选择一条运行记录查看详情。</p>
                    </div>
                  )}
                </div>
              </section>
            )}

            {view === "settings" && (
              <section className="settings-layout">
                <div className="panel settings-card">
                  <div className="panel-header">
                    <div>
                      <h3>全局设置</h3>
                      <p className="muted">主题、默认解释器和运行行为。</p>
                    </div>
                    <button className="secondary-button" onClick={() => void handleSaveSettings()}>
                      保存设置
                    </button>
                  </div>

                  <label className="field">
                    <span>主题</span>
                    <ChoiceField
                      value={settingsDraft.theme}
                      options={[
                        { value: "light", label: "浅色" },
                        { value: "dark", label: "深色" },
                      ]}
                      onChange={(value) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          theme: value as ThemeMode,
                        }))
                      }
                    />
                  </label>

                  <label className="field">
                    <span>默认解释器</span>
                    <ChoiceField
                      value={settingsDraft.defaultInterpreterId ?? ""}
                      options={[
                        { value: "", label: "未设置" },
                        ...interpreters.map((interpreter) => ({
                          value: interpreter.id,
                          label: interpreter.name,
                        })),
                      ]}
                      onChange={(value) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          defaultInterpreterId: value || null,
                        }))
                      }
                    />
                  </label>

                  <label className="field">
                    <span>日志保留天数</span>
                    <input
                      className="text-input"
                      type="number"
                      min={1}
                      value={settingsDraft.logRetentionDays}
                      onChange={(event) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          logRetentionDays: Number(event.currentTarget.value) || 1,
                        }))
                      }
                    />
                  </label>

                  <div className="field inline">
                    <SafeToggle
                      checked={settingsDraft.confirmBeforeStop}
                      label="停止运行前确认"
                      onChange={(next) =>
                        setSettingsDraft((current) => ({
                          ...current,
                          confirmBeforeStop: next,
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="panel settings-card">
                  <div className="panel-header">
                    <div>
                      <h3>Bundled Python</h3>
                      <p className="muted">管理应用自带的 Python 运行时，用于正式分发和开箱即跑。</p>
                    </div>
                    <button
                      className="ghost-button"
                      disabled={bundledPythonBusy}
                      onClick={() => void refreshBundledPythonStatus()}
                    >
                      刷新状态
                    </button>
                  </div>
                  <div className="detail-grid">
                    <div>
                      <span>状态</span>
                      <strong>{bundledPythonStatus?.available ? "可用" : "未安装"}</strong>
                    </div>
                    <div>
                      <span>来源</span>
                      <strong>{bundledPythonStatus?.source ?? "none"}</strong>
                    </div>
                    <div>
                      <span>版本</span>
                      <strong>{bundledPythonStatus?.version || "未检测"}</strong>
                    </div>
                  </div>
                  <label className="field">
                    <span>运行时目录</span>
                    <pre className="command-preview">
                      {bundledPythonStatus?.rootDir || "还没有 bundled Python 目录"}
                    </pre>
                  </label>
                  <p className="muted">{bundledPythonStatus?.message || "尚未初始化 bundled Python"}</p>
                  <div className="panel-actions">
                    <button
                      className="secondary-button"
                      disabled={bundledPythonBusy || !preferredExternalInterpreter}
                      onClick={() =>
                        void handleInstallBundledPython(
                          preferredExternalInterpreter?.executablePath,
                        )
                      }
                    >
                      {bundledPythonBusy ? "安装中..." : "从当前系统 Python 安装"}
                    </button>
                    <button
                      className="ghost-button"
                      disabled={bundledPythonBusy}
                      onClick={() => void handleInstallBundledPython()}
                    >
                      从自定义 python.exe 安装
                    </button>
                  </div>
                </div>

                <div className="panel settings-card">
                  <div className="panel-header">
                    <div>
                      <h3>解释器管理</h3>
                      <p className="muted">内置 Python 和外部 Python/venv 都在这里管理。</p>
                    </div>
                  </div>

                  <div className="inline-form">
                    <input
                      className="text-input"
                      placeholder="解释器名称"
                      value={newInterpreterName}
                      onChange={(event) => setNewInterpreterName(event.currentTarget.value)}
                    />
                    <input
                      className="text-input"
                      placeholder="python.exe 路径"
                      value={newInterpreterPath}
                      onChange={(event) => setNewInterpreterPath(event.currentTarget.value)}
                    />
                    <button className="ghost-button" onClick={() => void chooseInterpreterPath()}>
                      选择文件
                    </button>
                    <button
                      className="secondary-button"
                      disabled={!newInterpreterPath}
                      onClick={() => void handleSaveInterpreter(false)}
                    >
                      新增解释器
                    </button>
                  </div>

                  <div className="table-list">
                    {interpreters.map((profile) => (
                      <div key={profile.id} className="table-row static-row">
                        <div className="row-main">
                          <strong>{profile.name}</strong>
                          <small>{profile.executablePath}</small>
                        </div>
                        <div className="row-meta">
                          <span className="task-kind-tag">
                            {profile.type === "bundled" ? "内置" : "外部"}
                          </span>
                          {profile.isDefault && <span className="favorite-star">默认</span>}
                        </div>
                        <div className="row-actions">
                          <button
                            className="ghost-button"
                            onClick={() =>
                              void handleSaveInterpreter(true, { ...profile, isDefault: true })
                            }
                          >
                            设为默认
                          </button>
                          <button
                            className="ghost-button"
                            onClick={() => void handleCheckInterpreter(profile.id)}
                          >
                            健康检查
                          </button>
                          {profile.type !== "bundled" && (
                            <button
                              className="ghost-button danger"
                              onClick={() => void handleDeleteInterpreter(profile.id)}
                            >
                              删除
                            </button>
                          )}
                        </div>
                        {selectedInterpreterHealth[profile.id] && (
                          <div
                            className={`health-pill ${selectedInterpreterHealth[profile.id].ok ? "ok" : "fail"}`}
                          >
                            {selectedInterpreterHealth[profile.id].message}
                            {selectedInterpreterHealth[profile.id].version
                              ? ` (${selectedInterpreterHealth[profile.id].version})`
                              : ""}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                <div className="panel settings-card">
                  <div className="panel-header">
                    <div>
                      <h3>工作区备份</h3>
                      <p className="muted">导出或恢复任务、解释器和全局设置。</p>
                    </div>
                  </div>
                  <div className="panel-actions">
                    <button
                      className="secondary-button"
                      onClick={() => void handleExportWorkspace()}
                    >
                      导出工作区 JSON
                    </button>
                    <button className="ghost-button" onClick={() => void handleImportWorkspace()}>
                      导入工作区 JSON
                    </button>
                  </div>
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {importModalOpen && (
        <div className="modal-backdrop" onClick={() => setImportModalOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <h3>导入命令</h3>
                <p className="muted">支持单行命令和 PowerShell 反引号多行命令。</p>
              </div>
            </div>
            <SafeMultilineInput
              value={importText}
              minHeight={180}
              placeholder="例如：python F:\CIL\conmic\backup_comicbox_book.py --book-url ..."
              onChange={setImportText}
            />
            {importWarnings.length > 0 && (
              <div className="alert-banner warning">{importWarnings.join("；")}</div>
            )}
            <div className="panel-actions end">
              <button className="ghost-button" onClick={() => setImportModalOpen(false)}>
                取消
              </button>
              <button
                className="primary-button"
                disabled={!importText.trim()}
                onClick={() => void handleImportCommand()}
              >
                导入为任务
              </button>
            </div>
          </div>
        </div>
      )}

      {interpreterPickerOpen && draftTask?.kind === "python_task" && (
        <div className="modal-backdrop" onClick={() => setInterpreterPickerOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <h3>选择解释器</h3>
                <p className="muted">为当前 Python 任务指定运行时。</p>
              </div>
            </div>
            <div className="choice-grid choice-grid-vertical">
              {interpreters.map((interpreter) => (
                <button
                  key={interpreter.id}
                  className={`choice-chip choice-chip-block ${
                    draftTask.python?.interpreterProfileId === interpreter.id ? "active" : ""
                  }`}
                  onClick={() => {
                    updateDraftTask((current) => ({
                      ...current,
                      python: current.python
                        ? {
                            ...current.python,
                            interpreterProfileId: interpreter.id,
                          }
                        : current.python,
                    }));
                    setInterpreterPickerOpen(false);
                  }}
                >
                  {interpreter.name}
                  {interpreter.isDefault ? "（默认）" : ""}
                </button>
              ))}
            </div>
            <div className="panel-actions end">
              <button className="ghost-button" onClick={() => setInterpreterPickerOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {scriptScanPreview && (
        <ScriptScanPreviewModal
          preview={scriptScanPreview}
          busy={scriptScanBusy}
          onChange={setScriptScanPreview}
          onCancel={() => setScriptScanPreview(null)}
          onHelpScan={() => void handleHelpRescan()}
          onConfirm={applyScriptScanPreview}
        />
      )}

      {runtimeParameterEditorOpen && draftTask && (
        <div className="modal-backdrop" onClick={() => setRuntimeParameterEditorOpen(false)}>
          <div
            className="modal-card runtime-parameter-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-header">
              <div>
                <h3>编辑运行表单</h3>
                <p className="muted">
                  默认设置表单名称、输入方式和默认值；派生与条件规则按需展开。
                </p>
              </div>
              <button
                type="button"
                className="ghost-button"
                onClick={() => setRuntimeParameterEditorOpen(false)}
              >
                完成
              </button>
            </div>
            <RuntimeParameterEditor
              parameters={runtimeParameters}
              onChange={(parameters) =>
                updateDraftTask((current) => ({
                  ...current,
                  runtimeParameters: parameters,
                }))
              }
            />
          </div>
        </div>
      )}

      {argsEditorOpen && draftTask?.kind === "python_task" && (
        <div className="modal-backdrop" onClick={() => setArgsEditorOpen(false)}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="panel-header">
              <div>
                <h3>编辑参数模板</h3>
                <p className="muted">支持单行或多行参数，保存后会更新命令预览。</p>
              </div>
            </div>
            <textarea
              className="text-area modal-text-area"
              rows={8}
              value={argsEditorDraft}
              onChange={(event) => setArgsEditorDraft(event.currentTarget.value)}
              placeholder="例如：--video-id 406871"
            />
            <div className="panel-actions end">
              <button className="ghost-button" onClick={() => setArgsEditorOpen(false)}>
                取消
              </button>
              <button className="primary-button" onClick={() => applyArgsEditor()}>
                应用参数模板
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </AppErrorBoundary>
  );
}

export default App;
