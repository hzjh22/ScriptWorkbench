import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

const { saveTaskMock } = vi.hoisted(() => ({
  saveTaskMock: vi.fn(),
}));
const {
  startRunMock,
  writeTextFileMock,
  readTextFileMock,
  saveInterpreterProfileMock,
  saveSettingsMock,
  getTaskRuntimeValuesMock,
  dialogOpenMock,
  dialogSaveMock,
  scanPythonScriptMock,
  checkScriptScanStatusMock,
  pickFileMock,
  listRunsMock,
  clearRunHistoryMock,
} = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  writeTextFileMock: vi.fn(),
  readTextFileMock: vi.fn(),
  saveInterpreterProfileMock: vi.fn(),
  saveSettingsMock: vi.fn(),
  getTaskRuntimeValuesMock: vi.fn(),
  dialogOpenMock: vi.fn(),
  dialogSaveMock: vi.fn(),
  scanPythonScriptMock: vi.fn(),
  checkScriptScanStatusMock: vi.fn(),
  pickFileMock: vi.fn(),
  listRunsMock: vi.fn(),
  clearRunHistoryMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpenMock,
  save: dialogSaveMock,
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(),
  revealItemInDir: vi.fn(),
}));

vi.mock("./lib/api", () => ({
  api: {
    listTasks: vi.fn(async () => [
      {
        id: "task-1",
        kind: "python_task",
        name: "UI Selftest Task",
        workingDirectory: "E:/ScriptWorkbench/fixtures",
        envVars: [],
        tags: ["selftest"],
        notes: "notes",
        favorite: true,
        createdAt: "2026-01-01T00:00:00",
        updatedAt: "2026-01-01T00:00:00",
        python: {
          interpreterProfileId: "system-python",
          scriptPath: "E:/ScriptWorkbench/fixtures/selftest_python_task.py",
          argsTemplate: "--ping 42",
        },
        command: null,
      },
      {
        id: "task-2",
        kind: "command_task",
        name: "UI Command Task",
        workingDirectory: "E:/ScriptWorkbench",
        envVars: [],
        tags: ["selftest", "command"],
        notes: "cmd notes",
        favorite: false,
        createdAt: "2026-01-01T00:00:00",
        updatedAt: "2026-01-01T00:00:00",
        python: null,
        command: {
          command: 'cmd /c "echo test"',
        },
      },
      {
        id: "task-3",
        kind: "python_task",
        name: "ComicBox Dynamic Task",
        workingDirectory: "F:/CIL/conmic",
        envVars: [],
        tags: ["comicbox"],
        notes: "dynamic runtime value",
        favorite: false,
        createdAt: "2026-01-01T00:00:00",
        updatedAt: "2026-01-01T00:00:00",
        python: {
          interpreterProfileId: "system-python",
          scriptPath: "F:/CIL/conmic/backup_comicbox_book.py",
          argsTemplate:
            "--book-url https://www.comicbox.xyz/book/{{book_id}} --output F:\\comicbox_{{book_id}}_backup",
        },
        command: null,
      },
      {
        id: "task-4",
        kind: "python_task",
        name: "Typed Dynamic Task",
        workingDirectory: "E:/ScriptWorkbench/fixtures",
        envVars: [],
        tags: ["dynamic", "typed"],
        notes: "generated runtime controls",
        favorite: false,
        runtimeParameters: [
          {
            name: "workers", label: "线程数", description: "1 到 32", type: "number",
            required: true, defaultValue: "12", options: [], min: 1, max: 32,
          },
          {
            name: "quiet", label: "静默模式", description: "", type: "boolean",
            required: true, defaultValue: "false", options: [], min: null, max: null,
          },
          {
            name: "quality", label: "画质", description: "", type: "choice",
            required: true, defaultValue: "1080p", options: ["720p", "1080p"], min: null, max: null,
          },
          {
            name: "output", label: "输出目录", description: "", type: "directory",
            required: true, defaultValue: "E:/output", options: [], min: null, max: null,
          },
          {
            name: "token", label: "访问令牌", description: "不会保存", type: "secret",
            required: true, defaultValue: "", options: [], min: null, max: null,
          },
        ],
        createdAt: "2026-01-01T00:00:00",
        updatedAt: "2026-01-01T00:00:00",
        python: {
          interpreterProfileId: "system-python",
          scriptPath: "E:/ScriptWorkbench/fixtures/selftest_python_task.py",
          argsTemplate:
            "--workers {{workers}} --quiet {{quiet}} --quality {{quality}} --output {{output}} --token {{token}}",
        },
        command: null,
      },
    ]),
    listRuns: listRunsMock,
    clearRunHistory: clearRunHistoryMock,
    listInterpreterProfiles: vi.fn(async () => [
      {
        id: "system-python",
        name: "System Python",
        type: "external",
        executablePath: "D:/python/Python311/python.exe",
        isDefault: true,
      },
      {
        id: "bundled-python",
        name: "Bundled Python",
        type: "bundled",
        executablePath: "E:/bundled/python.exe",
        isDefault: false,
      },
    ]),
    getSettings: vi.fn(async () => ({
      theme: "light",
      defaultInterpreterId: "system-python",
      logRetentionDays: 14,
      autoSaveEditor: false,
      confirmBeforeStop: true,
    })),
    getBundledPythonStatus: vi.fn(async () => ({
      available: true,
      source: "development",
      pythonPath: "E:/bundled/python.exe",
      rootDir: "E:/bundled",
      version: "Python 3.11.3",
      message: "ok",
    })),
    previewTaskCommand: vi.fn(async () => ""),
    scanPythonScript: scanPythonScriptMock,
    checkScriptScanStatus: checkScriptScanStatusMock,
    saveTask: saveTaskMock,
    deleteTask: vi.fn(),
    importCommand: vi.fn(),
    getRunOutput: vi.fn(async () => ({ stdout: "", stderr: "" })),
    getTaskRuntimeValues: getTaskRuntimeValuesMock,
    startRun: startRunMock,
    stopRun: vi.fn(),
    deleteInterpreterProfile: vi.fn(),
    checkInterpreterHealth: vi.fn(),
    saveInterpreterProfile: saveInterpreterProfileMock,
    saveSettings: saveSettingsMock,
    readTextFile: readTextFileMock,
    writeTextFile: writeTextFileMock,
    pickFile: pickFileMock,
    pickDirectory: vi.fn(async () => null),
    installBundledPython: vi.fn(),
  },
}));

describe("App selftest interactions", () => {
  beforeEach(() => {
    saveTaskMock.mockReset();
    saveTaskMock.mockImplementation(async (task) => task);
    startRunMock.mockReset();
    startRunMock.mockImplementation(async () => ({
      id: "run-1",
      taskId: "task-1",
      taskName: "UI Selftest Task",
      status: "running",
      commandPreview: "python fixture.py",
      workingDirectory: "E:/ScriptWorkbench/fixtures",
      startedAt: "2026-01-01T00:00:00",
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      stdoutLogPath: "stdout.log",
      stderrLogPath: "stderr.log",
      runtimeValues: {},
    }));
    writeTextFileMock.mockReset();
    writeTextFileMock.mockImplementation(async () => undefined);
    readTextFileMock.mockReset();
    readTextFileMock.mockImplementation(async () =>
      JSON.stringify({
        version: 1,
        exportedAt: "2026-01-01T00:00:00",
        tasks: [],
        interpreters: [],
        settings: {
          theme: "dark",
          defaultInterpreterId: null,
          logRetentionDays: 10,
          autoSaveEditor: false,
          confirmBeforeStop: true,
        },
      }),
    );
    saveInterpreterProfileMock.mockReset();
    saveInterpreterProfileMock.mockImplementation(async (profile) => profile);
    saveSettingsMock.mockReset();
    saveSettingsMock.mockImplementation(async (settings) => settings);
    getTaskRuntimeValuesMock.mockReset();
    getTaskRuntimeValuesMock.mockImplementation(async () => ({}));
    dialogOpenMock.mockReset();
    dialogOpenMock.mockImplementation(async () => "E:/import.json");
    dialogSaveMock.mockReset();
    dialogSaveMock.mockImplementation(async () => "E:/export.json");
    pickFileMock.mockReset();
    pickFileMock.mockImplementation(async () => null);
    listRunsMock.mockReset();
    listRunsMock.mockImplementation(async () => []);
    clearRunHistoryMock.mockReset();
    clearRunHistoryMock.mockImplementation(async () => ({
      deletedCount: 0,
      deletedLogCount: 0,
      failedLogCount: 0,
    }));
    checkScriptScanStatusMock.mockReset();
    checkScriptScanStatusMock.mockImplementation(async () => ({
      status: "unchanged",
      currentHash: "sha256:test",
      diff: { added: [], removed: [], typeChanged: [], defaultChanged: [] },
      preview: null,
    }));
    scanPythonScriptMock.mockReset();
    scanPythonScriptMock.mockImplementation(async () => ({
      taskName: "Scanned Task",
      description: "scanned",
      framework: "argparse",
      source: "ast",
      confidence: "high",
      groups: [{ id: "common", label: "常用参数", advanced: false }],
      parameters: [
        {
          name: "video_id", label: "视频 ID", description: "", type: "text",
          required: true, defaultValue: "", options: [], min: null, max: null,
          group: "常用参数", advanced: false, source: "ast", confidence: "high",
          locked: false, condition: null, derivedTemplate: null, allowOverride: true, enabled: true,
        },
        {
          name: "timeout", label: "HTTP 超时", description: "", type: "number",
          required: false, defaultValue: "30", options: [], min: 1, max: null,
          group: "高级设置", advanced: true, source: "ast", confidence: "high",
          locked: false, condition: null, derivedTemplate: null, allowOverride: true, enabled: true,
        },
      ],
      argumentRules: [
        {
          id: "video-id", inputName: "video_id", flag: "--video-id",
          emission: "always", valueTemplate: "{{video_id}}", condition: null, enabled: true,
        },
        {
          id: "timeout", inputName: "timeout", flag: "--timeout",
          emission: "always", valueTemplate: "{{timeout}}", condition: null, enabled: true,
        },
      ],
      validationRules: [],
      relationshipCandidates: [],
      diagnostics: [],
      scriptHash: "sha256:test",
      generatedArguments: ["--video-id", "<video_id>"],
      helpRecommended: false,
    }));
  });

  it("allows switching interpreter and editing args via modal flow", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("UI Selftest Task");
    await user.click(
      screen.getByRole("button", {
        name: /UI Selftest Task.*Python.*selftest_python_task\.py/,
      }),
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "解释器 System Python" })).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "解释器 System Python" }));
    await user.click(screen.getByRole("button", { name: "Bundled Python" }));

    await user.click(screen.getByRole("button", { name: /参数模板 --ping 42/ }));
    const modalInput = screen.getByPlaceholderText("例如：--video-id 406871");
    await user.clear(modalInput);
    await user.type(modalInput, "--ping 77 --extra saved");
    await user.click(screen.getByRole("button", { name: "应用参数模板" }));

    await user.click(screen.getByRole("button", { name: "保存任务" }));

    expect(saveTaskMock).toHaveBeenCalled();
    const payload = saveTaskMock.mock.calls[saveTaskMock.mock.calls.length - 1]?.[0];
    expect(payload.name).toBe("UI Selftest Task");
    expect(payload.python.interpreterProfileId).toBe("bundled-python");
    expect(payload.python.argsTemplate).toBe("--ping 77 --extra saved");
  });

  it("scans a Python script and confirms a structured task draft", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("UI Selftest Task");
    await user.click(screen.getByRole("button", {
      name: /UI Selftest Task.*Python.*selftest_python_task\.py/,
    }));
    await user.click(screen.getByRole("button", { name: "扫描参数" }));

    expect(await screen.findByText("确认运行表单")).toBeTruthy();
    expect(screen.getByText("静态源码扫描")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "使用此运行表单" }));

    expect(await screen.findByText(/结构化 argv · 2 条规则/)).toBeTruthy();
    expect(screen.getByText(/2 个表单字段/)).toBeTruthy();
    expect(scanPythonScriptMock).toHaveBeenCalledWith(
      "E:/ScriptWorkbench/fixtures/selftest_python_task.py",
      "system-python",
      "--ping 42",
      false,
    );
  });

  it("allows the same task to start concurrent run instances", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("UI Selftest Task");
    await user.click(
      screen.getByRole("button", {
        name: /UI Selftest Task.*Python.*selftest_python_task\.py/,
      }),
    );
    const startButton = screen.getByRole("button", { name: "开始运行" });
    await user.click(startButton);
    await user.click(startButton);

    expect(startRunMock).toHaveBeenCalledTimes(2);
    expect(startRunMock).toHaveBeenNthCalledWith(1, "task-1", {});
    expect(startRunMock).toHaveBeenNthCalledWith(2, "task-1", {});
  });

  it("keeps each task bound to its own terminal run", async () => {
    const user = userEvent.setup();
    startRunMock.mockImplementation(async (taskId: string) => ({
      id: `run-${taskId}`,
      taskId,
      taskName: taskId === "task-1" ? "UI Selftest Task" : "UI Command Task",
      status: "running",
      commandPreview: `run ${taskId}`,
      workingDirectory: "E:/ScriptWorkbench",
      startedAt: "2026-01-01T00:00:00",
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      stdoutLogPath: `${taskId}-stdout.log`,
      stderrLogPath: `${taskId}-stderr.log`,
      runtimeValues: {},
      attemptCount: 1,
      terminationReason: null,
    }));
    render(<App />);

    await screen.findByText("UI Selftest Task");
    await user.click(screen.getByRole("button", {
      name: /UI Selftest Task.*Python.*selftest_python_task\.py/,
    }));
    await user.click(screen.getByRole("button", { name: "运行任务" }));
    expect(await screen.findByText("Run ID: run-task-1")).toBeTruthy();

    await user.click(screen.getByRole("button", {
      name: /UI Command Task.*命令.*cmd \/c "echo test"/,
    }));
    expect(await screen.findByText("当前任务还没有终端实例。保存任务后点击“运行任务”。")).toBeTruthy();
    expect(screen.queryByText("Run ID: run-task-1")).toBeNull();

    await user.click(screen.getByRole("button", { name: "运行任务" }));
    expect(await screen.findByText("Run ID: run-task-2")).toBeTruthy();

    await user.click(screen.getByRole("button", {
      name: /UI Selftest Task.*Python.*selftest_python_task\.py/,
    }));
    expect(await screen.findByText("Run ID: run-task-1")).toBeTruthy();
    expect(screen.queryByText("Run ID: run-task-2")).toBeNull();
  });

  it("saves task reliability policies", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByText("UI Selftest Task");
    await user.click(screen.getByRole("button", {
      name: /UI Selftest Task.*Python.*selftest_python_task\.py/,
    }));
    await user.click(screen.getByRole("button", { name: "已有运行时拒绝" }));
    await user.click(screen.getByRole("button", { name: "GBK / 中文 Windows" }));
    await user.click(screen.getByRole("button", { name: "保存任务" }));

    const payload = saveTaskMock.mock.calls[saveTaskMock.mock.calls.length - 1]?.[0];
    expect(payload.reliability).toMatchObject({
      concurrencyPolicy: "reject",
      outputEncoding: "gbk",
      timeoutSeconds: 0,
      retryCount: 0,
    });
  });

  it("opens legacy Python parameters as a scanned business form instead of the schema editor", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("ComicBox Dynamic Task");
    await user.click(
      screen.getByRole("button", {
        name: /ComicBox Dynamic Task.*Python.*backup_comicbox_book\.py/,
      }),
    );
    await user.click(screen.getByRole("button", { name: "编辑运行表单" }));

    expect(await screen.findByText("确认运行表单")).toBeTruthy();
    expect(screen.queryByText("{{book_id}}")).toBeNull();
    expect(scanPythonScriptMock).toHaveBeenCalledWith(
      "F:/CIL/conmic/backup_comicbox_book.py",
      "system-python",
      "--book-url https://www.comicbox.xyz/book/{{book_id}} --output F:\\comicbox_{{book_id}}_backup",
      false,
    );
  });

  it("fills one runtime value for repeated ComicBox placeholders", async () => {
    const user = userEvent.setup();
    let resolveRuntimeValues!: (values: Record<string, string>) => void;
    getTaskRuntimeValuesMock.mockImplementation((taskId: string) => {
      if (taskId !== "task-3") return Promise.resolve({});
      return new Promise((resolve) => {
        resolveRuntimeValues = resolve;
      });
    });
    render(<App />);

    await screen.findByText("ComicBox Dynamic Task");
    await user.click(
      screen.getByRole("button", {
        name: /ComicBox Dynamic Task.*Python.*backup_comicbox_book\.py/,
      }),
    );

    expect(await screen.findByText("正在读取上次运行参数...")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "漫画 ID" })).toBeNull();
    resolveRuntimeValues({});

    const runtimeInput = await screen.findByRole("textbox", { name: "漫画 ID" });
    await user.type(runtimeInput, "5101");
    expect(runtimeInput.textContent).toBe("5101");
    await user.click(screen.getByRole("button", { name: "运行任务" }));

    await waitFor(() => {
      expect(startRunMock).toHaveBeenCalledWith("task-3", { book_id: "5101" });
    });
  });

  it("generates typed runtime controls and submits their resolved values", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("Typed Dynamic Task");
    await user.click(
      screen.getByRole("button", {
        name: /Typed Dynamic Task.*Python.*selftest_python_task\.py/,
      }),
    );

    expect((await screen.findByRole("spinbutton", { name: "线程数" }) as HTMLInputElement).value)
      .toBe("12");
    expect(screen.getByRole("switch", { name: "静默模式" }).getAttribute("aria-checked"))
      .toBe("false");
    expect((screen.getByRole("combobox", { name: "画质" }) as HTMLSelectElement).value)
      .toBe("1080p");
    expect(screen.getByRole("textbox", { name: "输出目录" }).textContent).toBe("E:/output");

    await user.type(screen.getByLabelText("访问令牌"), "session-token");
    await user.click(screen.getByRole("button", { name: "运行任务" }));

    await waitFor(() => {
      expect(startRunMock).toHaveBeenCalledWith("task-4", {
        workers: "12",
        quiet: "false",
        quality: "1080p",
        output: "E:/output",
        token: "session-token",
      });
    });
  });

  it("exports and imports workspace data", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("设置");
    await user.click(screen.getByText("设置"));

    await user.click(screen.getByRole("button", { name: "导出工作区 JSON" }));
    expect(writeTextFileMock).toHaveBeenCalled();

    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    await user.click(screen.getByRole("button", { name: "导入工作区 JSON" }));

    expect(readTextFileMock).toHaveBeenCalledWith("E:/import.json");
    expect(saveSettingsMock).toHaveBeenCalled();
  });

  it("clears completed run history while preserving running instances", async () => {
    const user = userEvent.setup();
    const completedRun = {
      id: "run-finished",
      taskId: "task-1",
      taskName: "Completed Task",
      status: "finished",
      commandPreview: "python completed.py",
      workingDirectory: "E:/ScriptWorkbench",
      startedAt: "2026-01-01T00:00:00",
      finishedAt: "2026-01-01T00:00:01",
      durationMs: 1000,
      exitCode: 0,
      stdoutLogPath: "finished-stdout.log",
      stderrLogPath: "finished-stderr.log",
      runtimeValues: {},
      attemptCount: 1,
      terminationReason: null,
    };
    const runningRun = {
      ...completedRun,
      id: "run-active",
      taskName: "Active Task",
      status: "running",
      finishedAt: null,
      durationMs: null,
      exitCode: null,
    };
    listRunsMock
      .mockResolvedValueOnce([completedRun, runningRun])
      .mockResolvedValue([runningRun]);
    clearRunHistoryMock.mockResolvedValue({
      deletedCount: 1,
      deletedLogCount: 2,
      failedLogCount: 0,
    });
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    render(<App />);

    await screen.findByText("UI Selftest Task");
    await user.click(screen.getByRole("button", { name: "运行记录" }));
    await screen.findAllByText("Completed Task");
    expect(screen.getByRole("combobox", { name: "运行状态筛选" }))
      .toHaveProperty("value", "all");
    await user.click(screen.getByRole("button", { name: "一键清除历史" }));

    await waitFor(() => expect(clearRunHistoryMock).toHaveBeenCalledTimes(1));
    expect(screen.queryAllByText("Completed Task")).toHaveLength(0);
    expect((await screen.findAllByText("Active Task")).length).toBeGreaterThan(0);
  });

  it("toggles favorite and settings switches without crashing", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("UI Selftest Task");
    await user.click(
      screen.getByRole("button", {
        name: /UI Selftest Task.*Python.*selftest_python_task\.py/,
      }),
    );

    await user.click(screen.getByRole("switch", { name: "收藏" }));
    await user.click(screen.getByText("设置"));
    await user.click(screen.getByRole("switch", { name: "停止运行前确认" }));
    await user.click(screen.getByRole("button", { name: "保存设置" }));

    expect(saveSettingsMock).toHaveBeenCalled();
  });

  it("keeps the task toolbar in normal document flow so it cannot cover panel headers", async () => {
    const { container } = render(<App />);
    await screen.findByText("UI Selftest Task");

    const workspace = container.querySelector<HTMLElement>(".workspace");
    const topbar = container.querySelector<HTMLElement>(".topbar");
    expect(workspace).not.toBeNull();
    expect(topbar).not.toBeNull();
    expect(workspace!.contains(topbar)).toBe(true);
    expect(workspace).toHaveProperty("dataset.layoutBoundary", "workspace");
    expect(topbar).toHaveProperty("dataset.scrollBehavior", "flow");
  });

  it("keeps long task paths inside the task-list column", async () => {
    const { container } = render(<App />);
    await screen.findByText("UI Selftest Task");

    const taskList = container.querySelector<HTMLElement>(".task-list");
    const details = container.querySelectorAll<HTMLElement>(".task-card-detail");
    expect(taskList).toHaveProperty("dataset.scrollOwner", "column");
    expect(details.length).toBeGreaterThan(0);
  });

  it("gives each task column its own internal scroll region", async () => {
    const { container } = render(<App />);
    await screen.findByText("UI Selftest Task");

    expect(container.querySelector(".task-config-column"))
      .toHaveProperty("dataset.scrollRegion", "task-config");
    expect(container.querySelector(".task-run-column"))
      .toHaveProperty("dataset.scrollRegion", "task-run");
    expect(screen.getByRole("region", { name: "可滚动任务列表" })).toHaveProperty("tabIndex", 0);
    expect(screen.getByRole("region", { name: "可滚动任务配置" })).toHaveProperty("tabIndex", 0);
    expect(screen.getByRole("region", { name: "可滚动任务运行" })).toHaveProperty("tabIndex", 0);
  });
});
