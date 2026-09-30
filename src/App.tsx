import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "./lib/api";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { ChoiceField, SafeMultilineInput, SafeSingleLineInput, SafeToggle } from "./components/SafeFields";
import { RuntimeParameterEditor } from "./components/RuntimeParameterEditor";
import { ScriptScanPreviewModal } from "./components/ScriptScanPreviewModal";
import { TaskGallery } from "./components/TaskGallery";
import { TaskRunModal } from "./components/TaskRunModal";
import { LanShareModal } from "./components/LanShareModal";
import {
  buildPreviewCommand, cloneTask, createEmptyTask,
  getRuntimeTemplate, parseCommaSeparated,
  resolveTaskWorkingDirectory,
} from "./lib/taskUtils";
import {
  runtimeValuesAfterChange,
  runtimeValuesWithDefaults,
  syncRuntimeParameters,
  validateRuntimeValues,
} from "./lib/runtimeParameters";
import {
  AppSettings,
  InterpreterProfile,
  MobileApiSettings,
  MobileApiStatus,
  RunOutput,
  RunRecord,
  RuntimeValues,
  RunStatusEvent,
  RunStreamEvent,
  ScriptScanPreview,
  ScriptScanStatus,
  SharedFolder,
  TaskKind,
  TaskRecord,
} from "./types";
import "./styles.css";

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

const DEFAULT_MOBILE_API_SETTINGS: MobileApiSettings = {
  enabled: false,
  bindHost: "0.0.0.0",
  port: 17631,
};

const NEW_TASK_MODAL_ID = "__new_task__";

function App() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [interpreters, setInterpreters] = useState<InterpreterProfile[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [galleryCategory, setGalleryCategory] = useState<string>("all");
  const [gallerySearch, setGallerySearch] = useState<string>("");
  const [runModalTaskId, setRunModalTaskId] = useState<string | null>(null);
  const [editModalTaskId, setEditModalTaskId] = useState<string | null>(null);
  const [draftTask, setDraftTask] = useState<TaskRecord | null>(null);
  const [taskDirty, setTaskDirty] = useState(false);
  const [commandPreview, setCommandPreview] = useState("");
  const [runtimeValues, setRuntimeValues] = useState<RuntimeValues>({});
  const [_runtimeValuesLoading, setRuntimeValuesLoading] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importWarnings, setImportWarnings] = useState<string[]>([]);
  const [interpreterPickerOpen, setInterpreterPickerOpen] = useState(false);
  const [argsEditorOpen, setArgsEditorOpen] = useState(false);
  const [argsEditorDraft, setArgsEditorDraft] = useState("");
  const [runtimeParameterEditorOpen, setRuntimeParameterEditorOpen] = useState(false);
  const [lanShareModalOpen, setLanShareModalOpen] = useState(false);
  const [terminalBuffers, setTerminalBuffers] = useState<Record<string, TerminalBuffer>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSavingTask, setIsSavingTask] = useState(false);
  const [mobileApiStatus, setMobileApiStatus] = useState<MobileApiStatus | null>(null);
  const [mobileApiDraft, setMobileApiDraft] =
    useState<MobileApiSettings>(DEFAULT_MOBILE_API_SETTINGS);
  const [mobileApiBusy, setMobileApiBusy] = useState(false);
  const [sharedFolders, setSharedFolders] = useState<SharedFolder[]>([]);
  const [sharedFolderBusy, setSharedFolderBusy] = useState(false);
  const [scriptScanPreview, setScriptScanPreview] = useState<ScriptScanPreview | null>(null);
  const [scriptScanBusy, setScriptScanBusy] = useState(false);
  const [scriptScanStatus, setScriptScanStatus] = useState<ScriptScanStatus | null>(null);
  const statusTimerRef = useRef<number | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const startingRunTaskRef = useRef<string | null>(null);
  const stoppingRunRef = useRef<string | null>(null);
  const [activeRunByTask, setActiveRunByTask] = useState<Record<string, string>>({});

  const defaultInterpreterId = useMemo(() => {
    return (
      settingsDraft.defaultInterpreterId ??
      interpreters.find((item) => item.isDefault)?.id ??
      interpreters[0]?.id ??
      null
    );
  }, [interpreters, settingsDraft.defaultInterpreterId]);
  const activeRunId = selectedTaskId ? activeRunByTask[selectedTaskId] ?? null : null;
  const modalRunningRuns = runModalTaskId
    ? runs.filter((run) => run.taskId === runModalTaskId && run.status === "running")
    : [];
  const modalRunId = modalRunningRuns[0]?.id
    ?? (runModalTaskId ? activeRunByTask[runModalTaskId] ?? null : null);
  const runModalTask = runModalTaskId ? tasks.find((t) => t.id === runModalTaskId) ?? null : null;
  const editModalTask = editModalTaskId
    ? tasks.find((t) => t.id === editModalTaskId) ??
      (editModalTaskId === NEW_TASK_MODAL_ID ? draftTask : null)
    : null;
  // A run only counts as "running" while its live status says so.
  // terminalBuffers is fed by run://stdout|stderr|status events; runs comes from listRuns.
  const runningRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [runId, buffer] of Object.entries(terminalBuffers)) {
      if (buffer.status === "running") ids.add(runId);
    }
    for (const run of runs) {
      if (run.status === "running") ids.add(run.id);
    }
    return ids;
  }, [runs, terminalBuffers]);
  const runningTaskIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of runs) {
      if (run.taskId && runningRunIds.has(run.id)) ids.add(run.taskId);
    }
    return ids;
  }, [runningRunIds, runs]);
  const runningTaskCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const run of runs) {
      if (run.taskId && runningRunIds.has(run.id)) {
        counts[run.taskId] = (counts[run.taskId] ?? 0) + 1;
      }
    }
    return counts;
  }, [runningRunIds, runs]);
  const modalIsRunning = Boolean(modalRunId && runningRunIds.has(modalRunId));
  const activeRunTaskName = activeRunId
    ? runs.find((run) => run.id === activeRunId)?.taskName ?? null
    : null;
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
      setStatusMessage("");
    }, 2400);
  }

  async function loadWorkspace() {
    setIsLoading(true);
    try {
      const [taskList, runList, interpreterList, loadedSettings, loadedMobileApiStatus, loadedSharedFolders] = await Promise.all([
        api.listTasks(),
        api.listRuns(),
        api.listInterpreterProfiles(),
        api.getSettings(),
        api.getMobileApiStatus(),
        api.listSharedFolders(),
      ]);
      setTasks(taskList);
      setRuns(runList);
      rememberLatestTaskRuns(runList);
      setInterpreters(interpreterList);
      setSettings(loadedSettings);
      setSettingsDraft(loadedSettings);
      setMobileApiStatus(loadedMobileApiStatus);
      setSharedFolders(loadedSharedFolders);
      setMobileApiDraft({
        enabled: loadedMobileApiStatus.enabled,
        bindHost: loadedMobileApiStatus.bindHost,
        port: loadedMobileApiStatus.port,
      });
      if (!selectedTaskId && taskList.length > 0) {
        setSelectedTaskId(taskList[0].id);
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
  }

  function rememberLatestTaskRuns(runList: RunRecord[]) {
    // runList is ordered newest-first; compute the newest run per task.
    const newestByTask: Record<string, string> = {};
    for (const run of runList) {
      if (run.taskId && newestByTask[run.taskId] === undefined) {
        newestByTask[run.taskId] = run.id;
      }
    }
    setActiveRunByTask((current) => {
      const next = { ...current };
      let changed = false;
      for (const [taskId, runId] of Object.entries(newestByTask)) {
        if (next[taskId] !== runId) {
          next[taskId] = runId;
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }

  function attachRunToUi(run: RunRecord) {
    const taskId = run.taskId ?? selectedTaskId;
    if (taskId) {
      setActiveRunByTask((current) => ({ ...current, [taskId]: run.id }));
    }
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
    if (!draftTask || missingRuntimeVariables.length > 0) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .previewTaskCommand(draftTask, runtimeValues)
        .then((preview) => {
          if (active) setCommandPreview(preview || fallbackPreview);
        })
        .catch(() => {
        });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [draftTask, interpreters, runtimeValues, missingRuntimeVariables.join("|")]);

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
  }, [selectedTaskId]);

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

  function isManagedScriptPath(scriptPath: string): boolean {
    return /[\\/]managed-scripts[\\/]/i.test(scriptPath);
  }

  async function prepareTaskScript(task: TaskRecord): Promise<TaskRecord> {
    const scriptPath = task.python?.scriptPath?.trim();
    if (task.kind !== "python_task" || !task.python || !scriptPath || isManagedScriptPath(scriptPath)) {
      return task;
    }
    const imported = await api.importPythonScript(scriptPath);
    const managedDirectory = imported.scriptPath.replace(/[\\/][^\\/]+$/, "");
    const prepared = cloneTask(task);
    prepared.workingDirectory = managedDirectory;
    prepared.python = {
      ...prepared.python!,
      scriptPath: imported.scriptPath,
    };
    flashStatus("已将脚本复制到托管脚本库");
    return prepared;
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
      const preparedTask = await prepareTaskScript(draftTask);
      setDraftTask(preparedTask);
      const savedTask = await api.saveTask(preparedTask);
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
      setEditModalTaskId(null);
      return;
    }
    if (!(await confirmDialog(`确认删除任务“${draftTask.name || "未命名任务"}”吗？`))) {
      return;
    }
    const taskId = draftTask.id;
    try {
      await api.deleteTask(taskId);
      setActiveRunByTask((current) => {
        if (!(taskId in current)) return current;
        const next = { ...current };
        delete next[taskId];
        return next;
      });
      flashStatus("任务已删除");
      // Immediately drop every UI reference to the deleted task. Keeping the
      // stale draftTask would let a later click on run resurrect the task
      // through ensureTaskSaved (draftTask.id still exists, taskDirty=false),
      // or leave a ghost editor open for the last remaining task.
      setEditModalTaskId((current) => (current === taskId ? null : current));
      setRunModalTaskId((current) => (current === taskId ? null : current));
      setDraftTask(null);
      setTaskDirty(false);
      setRuntimeValues({});
      setRuntimeValuesLoading(false);
      await refreshTasks();
      await refreshRuns();
    } catch (error) {
      setStatusMessage(`删除失败: ${String(error)}`);
    }
  }
  function handleNewTask(kind: TaskKind) {
    setSelectedTaskId(null);
    setRunModalTaskId(null);
    setEditModalTaskId(NEW_TASK_MODAL_ID);
    setDraftTask(createEmptyTask(kind, defaultInterpreterId));
    setTaskDirty(true);
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
      setEditModalTaskId(NEW_TASK_MODAL_ID);
      setImportModalOpen(false);
      flashStatus("已导入命令草稿");
    } catch (error) {
      setStatusMessage(`导入失败: ${String(error)}`);
    }
  }

  async function ensureTaskSaved(): Promise<string | null> {
    if (!draftTask) return null;
    const preparedTask = await prepareTaskScript(draftTask);
    if (!taskDirty && preparedTask.id && preparedTask.python?.scriptPath === draftTask.python?.scriptPath) {
      return preparedTask.id;
    }
    setIsSavingTask(true);
    try {
      const savedTask = await api.saveTask(preparedTask);
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

  function openRunModal(task: TaskRecord) {
    if (!task.id) return;
    setSelectedTaskId(task.id);
    setRunModalTaskId(task.id);
  }

  function closeRunModal() {
    setRunModalTaskId(null);
  }

  function openEditModal(task: TaskRecord) {
    if (!task.id) return;
    setSelectedTaskId(task.id);
    setEditModalTaskId(task.id);
  }

  function closeEditModal() {
    setEditModalTaskId(null);
  }

  async function handleToggleFavorite(taskId: string) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const updated = { ...task, favorite: !task.favorite };
    try {
      await api.saveTask(updated);
      await refreshTasks();
      flashStatus(updated.favorite ? "已收藏" : "已取消收藏");
    } catch (error) {
      setStatusMessage(`收藏失败: ${String(error)}`);
    }
  }

  async function handleStartRun() {
    if (startingRunTaskRef.current) {
      return;
    }
    const taskId = await ensureTaskSaved();
    if (!taskId) {
      return;
    }
    startingRunTaskRef.current = taskId;
    try {
      if (missingRuntimeVariables.length > 0) {
        setStatusMessage(`请填写运行参数: ${missingRuntimeVariables.join("、")}`);
        return;
      }
      const run = await api.startRun(taskId, runtimeValues);
      attachRunToUi(run);
      await refreshRuns();
      flashStatus(`已启动任务：${draftTask?.name || "未命名任务"}`);
    } catch (error) {
      setStatusMessage(`运行失败: ${String(error)}`);
      await refreshRuns();
    } finally {
      startingRunTaskRef.current = null;
    }
  }

  async function handleStopRun(
    runId: string | null = activeRunId,
    runTaskName: string | null = activeRunTaskName,
  ) {
    if (!runId || stoppingRunRef.current === runId) {
      return;
    }
    stoppingRunRef.current = runId;
    try {
      const taskName = runTaskName || "当前任务";
      const runLabel = runId.slice(0, 8);
      if (
        settings.confirmBeforeStop &&
        !(await confirmDialog(`确认停止「${taskName}」运行实例 ${runLabel} 吗？`))
      ) {
        return;
      }
      await api.stopRun(runId);
      // Immediately reflect the requested stop in local UI state. The
      // authoritative run://status event normally arrives within tens of
      // milliseconds, but if it is missed the modal button would otherwise
      // stay stuck on "停止运行" even though the process tree
      // has already been terminated.
      setRuns((current) =>
        current.map((run) =>
          run.id === runId && run.status === "running"
            ? { ...run, status: "stopped" }
            : run,
        ),
      );
      setTerminalBuffers((current) => {
        const buffer = current[runId];
        if (!buffer || buffer.status !== "running") return current;
        return { ...current, [runId]: { ...buffer, status: "stopped" } };
      });
      // Reconcile with the database as a fallback in case the status event
      // was emitted before our listener was ready.
      window.setTimeout(() => {
        void refreshRuns().catch(() => undefined);
      }, 350);
      flashStatus(`已向「${taskName}」实例 ${runLabel} 发送停止信号`);
    } catch (error) {
      // The process may have already exited between the click and the backend
      // lookup (or a second stop raced with the first). Reconcile against the
      // database before showing a failure so we do not claim "停止失败" for a
      // run that is already finished/stopped.
      try {
        const latest = await api.listRuns();
        setRuns(latest);
        rememberLatestTaskRuns(latest);
        const run = latest.find((item) => item.id === runId);
        if (run && run.status !== "running") {
          flashStatus(`任务已结束，状态: ${run.status}`);
          return;
        }
      } catch {
        // Ignore refresh failures and fall through to the error message.
      }
      setStatusMessage(`停止失败: ${String(error)}`);
    } finally {
      if (stoppingRunRef.current === runId) {
        stoppingRunRef.current = null;
      }
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
    try {
      const imported = await api.importPythonScript(picked);
      const managedDirectory = imported.scriptPath.replace(/[\\/][^\\/]+$/, "");
      updateDraftTask((current) => ({
        ...current,
        workingDirectory: managedDirectory,
        python: current.python
          ? {
              ...current.python,
              scriptPath: imported.scriptPath,
            }
          : current.python,
      }));
      await startScriptScan(imported.scriptPath, false);
      flashStatus(
        imported.copiedFiles.length > 0
          ? `已复制到软件脚本库：${imported.copiedFiles.join("、")}`
          : "脚本已位于软件脚本库",
      );
    } catch (error) {
      setStatusMessage(`脚本导入失败: ${String(error)}`);
    }
  }

  async function handleHelpRescan() {
    const path = draftTask?.python?.scriptPath;
    if (!path) return;
    if (!(await confirmDialog("将启动该脚本的 --help 扫描，最长 3 秒。继续吗？"))) return;
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

  async function handleSaveMobileApiSettings() {
    setMobileApiBusy(true);
    try {
      const saved = await api.saveMobileApiSettings(mobileApiDraft);
      setMobileApiStatus(saved);
      setMobileApiDraft({
        enabled: saved.enabled,
        bindHost: saved.bindHost,
        port: saved.port,
      });
      flashStatus(saved.serverRunning ? "移动端 API 已启动" : "移动端 API 设置已保存");
    } catch (error) {
      setStatusMessage(`移动端 API 设置失败: ${String(error)}`);
    } finally {
      setMobileApiBusy(false);
    }
  }

  async function handleToggleLanShare(enabled: boolean) {
    setMobileApiBusy(true);
    try {
      const saved = await api.saveMobileApiSettings({ ...mobileApiDraft, enabled });
      setMobileApiStatus(saved);
      setMobileApiDraft({
        enabled: saved.enabled,
        bindHost: saved.bindHost,
        port: saved.port,
      });
      flashStatus(saved.serverRunning ? "局域网共享已开启" : "局域网共享已停止");
    } catch (error) {
      setStatusMessage(`局域网共享操作失败: ${String(error)}`);
    } finally {
      setMobileApiBusy(false);
    }
  }

  async function handleRegenerateMobilePairingCode() {
    setMobileApiBusy(true);
    try {
      const status = await api.regenerateMobilePairingCode();
      setMobileApiStatus(status);
      flashStatus("移动端配对码已重置");
    } catch (error) {
      setStatusMessage(`重置配对码失败: ${String(error)}`);
    } finally {
      setMobileApiBusy(false);
    }
  }

  async function handleAddSharedFolder() {
    setSharedFolderBusy(true);
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected !== "string" || !selected) {
        return;
      }
      const folders = await api.addSharedFolder(selected);
      setSharedFolders(folders);
      flashStatus("共享文件夹已添加");
    } catch (error) {
      setStatusMessage(`添加共享文件夹失败: ${String(error)}`);
    } finally {
      setSharedFolderBusy(false);
    }
  }

  async function handleRemoveSharedFolder(id: string) {
    setSharedFolderBusy(true);
    try {
      const folders = await api.removeSharedFolder(id);
      setSharedFolders(folders);
      flashStatus("共享文件夹已移除");
    } catch (error) {
      setStatusMessage(`移除共享文件夹失败: ${String(error)}`);
    } finally {
      setSharedFolderBusy(false);
    }
  }

  return (
    <AppErrorBoundary>
    <div className="shell">

      <main ref={workspaceRef} className="workspace" data-layout-boundary="workspace">
        {isLoading ? (
          <section className="panel loading-panel">正在加载工作区...</section>
        ) : (
          <>
            <TaskGallery
              tasks={tasks}
              search={gallerySearch}
              onSearch={setGallerySearch}
              selectedCategory={galleryCategory}
              onSelectCategory={setGalleryCategory}
              onRun={openRunModal}
              onEdit={openEditModal}
              onToggleFavorite={(id) => void handleToggleFavorite(id)}
              onNewTask={() => handleNewTask("python_task")}
              onNewCommand={() => handleNewTask("command_task")}
              onRefresh={() => void refreshTasks()}
              runningTaskIds={runningTaskIds}
              runningTaskCounts={runningTaskCounts}
              lanShareActive={Boolean(mobileApiStatus?.serverRunning)}
              onOpenLanShare={() => setLanShareModalOpen(true)}
            />
            {runModalTask && (
              <TaskRunModal
                task={runModalTask}
                parameters={runtimeParameters}
                values={runtimeValues}
                errors={runtimeValueErrors}
                commandPreview={commandPreview}
                onValueChange={handleRuntimeValueChange}
                onPickPath={chooseRuntimePath}
                onRun={() => void handleStartRun()}
                onStop={() => void handleStopRun(modalRunId, runModalTask?.name ?? null)}
                onEditConfig={() => {
                  const task = runModalTask;
                  closeRunModal();
                  if (task) openEditModal(task);
                }}
                onClose={closeRunModal}
                isRunning={modalIsRunning}
                runningCount={modalRunningRuns.length}
                allowConcurrentStart={
                  (runModalTask.reliability?.concurrencyPolicy ?? "allow") === "allow"
                }
                runStatus={modalRunId ? terminalBuffers[modalRunId]?.status ?? "" : ""}
                stdout={modalRunId ? terminalBuffers[modalRunId]?.stdout ?? "" : ""}
                stderr={modalRunId ? terminalBuffers[modalRunId]?.stderr ?? "" : ""}
              />
            )}

            {editModalTask && (
              <div className="modal-backdrop" onClick={closeEditModal}>
                <div className="modal-card task-edit-modal" onClick={(e) => e.stopPropagation()}>
                  <div className="task-edit-modal-header">
                    <div>
                      <h3>{draftTask?.name || "任务配置"}</h3>
                      <p className="muted">
                        {draftTask?.kind === "python_task" ? "结构化 Python 任务" : draftTask?.kind === "command_task" ? "原始命令任务" : "任务配置"}
                      </p>
                    </div>
                    <div className="panel-actions">
                      <button className="ghost-button" disabled={!commandPreview} onClick={() => void handleCopyText("命令预览", commandPreview)}>复制命令</button>
                      <button className="ghost-button" onClick={() => void handleOpenTaskWorkingDirectory()}>打开工作目录</button>
                      {draftTask?.kind === "python_task" && (
                        <button className="ghost-button" onClick={() => void handleRevealTaskScript()}>定位脚本</button>
                      )}
                      <button className="ghost-button danger" onClick={() => void handleDeleteTask()}>删除</button>
                      <button className="secondary-button" disabled={!draftTask} onClick={() => void handleSaveTask()}>
                        {isSavingTask ? "保存中..." : "保存任务"}
                      </button>
                      <button className="ghost-button" onClick={closeEditModal}>✕</button>
                    </div>
                  </div>
                  <div className="task-edit-modal-body">
                  <div className="panel task-editor-panel" style={{ boxShadow: "none", border: "none", padding: 0 }}>
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

                  </div>
                </div>
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

      {lanShareModalOpen && (
        <LanShareModal
          status={mobileApiStatus}
          draft={mobileApiDraft}
          busy={mobileApiBusy}
          sharedFolders={sharedFolders}
          sharedFolderBusy={sharedFolderBusy}
          onDraftChange={(updater) => setMobileApiDraft((current) => updater(current))}
          onSave={() => void handleSaveMobileApiSettings()}
          onToggleEnabled={(enabled) => void handleToggleLanShare(enabled)}
          onRegeneratePairingCode={() => void handleRegenerateMobilePairingCode()}
          onAddSharedFolder={() => void handleAddSharedFolder()}
          onRemoveSharedFolder={(id) => void handleRemoveSharedFolder(id)}
          onCopy={(label, text) => void handleCopyText(label, text)}
          onClose={() => setLanShareModalOpen(false)}
        />
      )}

      {statusMessage && (
        <div className="status-toast" role="status" aria-live="polite">
          <span className="status-toast-text">{statusMessage}</span>
          <button
            className="status-toast-close"
            onClick={() => setStatusMessage("")}
            aria-label="关闭提示"
            title="关闭提示"
          >
            ✕
          </button>
        </div>
      )}
    </div>
    </AppErrorBoundary>
  );
}

export default App;
