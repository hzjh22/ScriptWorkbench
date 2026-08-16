import { invoke } from "@tauri-apps/api/core";
import {
  AppSettings,
  BundledPythonStatus,
  ClearRunHistoryResult,
  CommandImportResult,
  InterpreterHealth,
  InterpreterProfile,
  MobileApiSettings,
  MobileApiStatus,
  RunOutput,
  RunRecord,
  RuntimeValues,
  ScriptScanPreview,
  ScriptScanStatus,
  TaskRecord,
} from "../types";

export const api = {
  listTasks: () => invoke<TaskRecord[]>("list_tasks"),
  saveTask: (task: TaskRecord) => invoke<TaskRecord>("save_task", { task }),
  deleteTask: (taskId: string) => invoke<void>("delete_task", { taskId }),
  previewTaskCommand: (task: TaskRecord, runtimeValues: RuntimeValues = {}) =>
    invoke<string>("preview_task_command", { task, runtimeValues }),
  importCommand: (commandText: string) =>
    invoke<CommandImportResult>("import_command", { commandText }),
  scanPythonScript: (
    scriptPath: string,
    interpreterProfileId: string,
    argsTemplate = "",
    allowHelp = false,
  ) => invoke<ScriptScanPreview>("scan_python_script", {
    scriptPath,
    interpreterProfileId,
    argsTemplate,
    allowHelp,
  }),
  checkScriptScanStatus: (
    scriptPath: string,
    interpreterProfileId: string,
    argsTemplate: string,
    scriptHash: string | null,
    scanSnapshot: ScriptScanPreview | null,
  ) => invoke<ScriptScanStatus>("check_script_scan_status", {
    scriptPath,
    interpreterProfileId,
    argsTemplate,
    scriptHash,
    scanSnapshot,
  }),

  listRuns: () => invoke<RunRecord[]>("list_runs"),
  clearRunHistory: () =>
    invoke<ClearRunHistoryResult>("clear_run_history"),
  getRunOutput: (runId: string) =>
    invoke<RunOutput>("read_run_output", { runId }),
  getTaskRuntimeValues: (taskId: string) =>
    invoke<RuntimeValues>("get_task_runtime_values", { taskId }),
  startRun: (taskId: string, runtimeValues: RuntimeValues = {}) =>
    invoke<RunRecord>("start_run", { taskId, runtimeValues }),
  stopRun: (runId: string) => invoke<void>("stop_run", { runId }),

  listInterpreterProfiles: () =>
    invoke<InterpreterProfile[]>("list_interpreter_profiles"),
  saveInterpreterProfile: (profile: InterpreterProfile) =>
    invoke<InterpreterProfile>("save_interpreter_profile", { profile }),
  deleteInterpreterProfile: (profileId: string) =>
    invoke<void>("delete_interpreter_profile", { profileId }),
  checkInterpreterHealth: (profileId: string) =>
    invoke<InterpreterHealth>("check_interpreter_health", { profileId }),
  getBundledPythonStatus: () =>
    invoke<BundledPythonStatus>("get_bundled_python_status"),
  installBundledPython: (sourcePath: string) =>
    invoke<BundledPythonStatus>("install_bundled_python", { sourcePath }),
  getMobileApiStatus: () =>
    invoke<MobileApiStatus>("get_mobile_api_status"),
  saveMobileApiSettings: (settings: MobileApiSettings) =>
    invoke<MobileApiStatus>("save_mobile_api_settings", { settings }),
  regenerateMobilePairingCode: () =>
    invoke<MobileApiStatus>("regenerate_mobile_pairing_code"),

  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) =>
    invoke<AppSettings>("save_settings", { settings }),

  readTextFile: (path: string) =>
    invoke<string>("read_text_file", { path }),
  writeTextFile: (path: string, content: string) =>
    invoke<void>("write_text_file", { path, content }),

  pickFile: (directory?: string) =>
    invoke<string | null>("pick_file", { directory: directory ?? null }),
  pickDirectory: (directory?: string) =>
    invoke<string | null>("pick_directory", { directory: directory ?? null }),
};
