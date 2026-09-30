import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

type Ue = ReturnType<typeof userEvent.setup>;

async function findCard(taskName: string): Promise<HTMLElement> {
  const title = await screen.findByText(taskName);
  const card = title.closest(".gallery-card") as HTMLElement | null;
  if (!card) throw new Error(`gallery card not found for ${taskName}`);
  return card;
}

function cardIconButton(card: HTMLElement, title: string): HTMLElement {
  const button = card.querySelector<HTMLElement>(`button[title="${title}"]`);
  if (!button) throw new Error(`card button not found: ${title}`);
  return button;
}

async function openEditModal(user: Ue, taskName: string): Promise<void> {
  const card = await findCard(taskName);
  await user.click(cardIconButton(card, "编辑任务配置"));
  await screen.findByRole("button", { name: "保存任务" });
}

async function openRunModal(user: Ue, taskName: string): Promise<void> {
  const card = await findCard(taskName);
  await user.click(within(card).getByRole("button", { name: /运行/ }));
  await screen.findByRole("button", { name: /开始运行/ });
}

const { saveTaskMock } = vi.hoisted(() => ({
  saveTaskMock: vi.fn(),
}));
const {
  startRunMock,
  stopRunMock,
  deleteTaskMock,
  writeTextFileMock,
  readTextFileMock,
  saveInterpreterProfileMock,
  saveSettingsMock,
  saveMobileApiSettingsMock,
  regenerateMobilePairingCodeMock,
  getTaskRuntimeValuesMock,
  dialogOpenMock,
  dialogSaveMock,
  dialogConfirmMock,
  scanPythonScriptMock,
  checkScriptScanStatusMock,
  pickFileMock,
  listRunsMock,
  clearRunHistoryMock,
  importPythonScriptMock,
} = vi.hoisted(() => ({
  startRunMock: vi.fn(),
  stopRunMock: vi.fn(),
  deleteTaskMock: vi.fn(),
  writeTextFileMock: vi.fn(),
  readTextFileMock: vi.fn(),
  saveInterpreterProfileMock: vi.fn(),
  saveSettingsMock: vi.fn(),
  saveMobileApiSettingsMock: vi.fn(),
  regenerateMobilePairingCodeMock: vi.fn(),
  getTaskRuntimeValuesMock: vi.fn(),
  dialogOpenMock: vi.fn(),
  dialogSaveMock: vi.fn(),
  dialogConfirmMock: vi.fn(),
  scanPythonScriptMock: vi.fn(),
  checkScriptScanStatusMock: vi.fn(),
  pickFileMock: vi.fn(),
  listRunsMock: vi.fn(),
  clearRunHistoryMock: vi.fn(),
  importPythonScriptMock: vi.fn(async (sourcePath: string) => ({
    scriptPath: sourcePath,
    copied: false,
    managedDirectory: sourcePath.replace(/[\\/]([^\\/]+)$/, ""),
  })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpenMock,
  save: dialogSaveMock,
  confirm: dialogConfirmMock,
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
    listSharedFolders: vi.fn(async () => []),
    addSharedFolder: vi.fn(async () => []),
    removeSharedFolder: vi.fn(async () => []),
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
    getMobileApiStatus: vi.fn(async () => ({
      enabled: false,
      bindHost: "0.0.0.0",
      port: 17631,
      pairingCode: "123456",
      tokenConfigured: false,
      serverRunning: false,
      baseUrls: ["http://127.0.0.1:17631", "http://192.168.43.10:17631"],
      message: "移动端 API 未启用",
    })),
    previewTaskCommand: vi.fn(async () => ""),
    scanPythonScript: scanPythonScriptMock,
    checkScriptScanStatus: checkScriptScanStatusMock,
    saveTask: saveTaskMock,
    importPythonScript: importPythonScriptMock,
    deleteTask: deleteTaskMock,
    importCommand: vi.fn(),
    getRunOutput: vi.fn(async () => ({ stdout: "", stderr: "" })),
    getTaskRuntimeValues: getTaskRuntimeValuesMock,
    startRun: startRunMock,
    stopRun: stopRunMock,
    deleteInterpreterProfile: vi.fn(),
    checkInterpreterHealth: vi.fn(),
    saveInterpreterProfile: saveInterpreterProfileMock,
    saveSettings: saveSettingsMock,
    saveMobileApiSettings: saveMobileApiSettingsMock,
    regenerateMobilePairingCode: regenerateMobilePairingCodeMock,
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
    saveMobileApiSettingsMock.mockReset();
    saveMobileApiSettingsMock.mockImplementation(async (settings) => ({
      ...settings,
      pairingCode: "123456",
      tokenConfigured: false,
      serverRunning: settings.enabled,
      baseUrls: [`http://127.0.0.1:${settings.port}`],
      message: settings.enabled ? "移动端 API 已运行" : "移动端 API 未启用",
    }));
    regenerateMobilePairingCodeMock.mockReset();
    regenerateMobilePairingCodeMock.mockImplementation(async () => ({
      enabled: false,
      bindHost: "0.0.0.0",
      port: 17631,
      pairingCode: "654321",
      tokenConfigured: false,
      serverRunning: false,
      baseUrls: ["http://127.0.0.1:17631"],
      message: "移动端 API 未启用",
    }));
    getTaskRuntimeValuesMock.mockReset();
    getTaskRuntimeValuesMock.mockImplementation(async () => ({}));
    dialogOpenMock.mockReset();
    dialogOpenMock.mockImplementation(async () => "E:/import.json");
    dialogSaveMock.mockReset();
    dialogSaveMock.mockImplementation(async () => "E:/export.json");
    dialogConfirmMock.mockReset();
    dialogConfirmMock.mockImplementation(async () => true);
    stopRunMock.mockReset();
    stopRunMock.mockImplementation(async () => undefined);
    deleteTaskMock.mockReset();
    deleteTaskMock.mockImplementation(async () => undefined);
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

    await openEditModal(user, "UI Selftest Task");

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

    await openEditModal(user, "UI Selftest Task");
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

  it("starts a run from the run modal with the task id and runtime values", async () => {
    const user = userEvent.setup();
    render(<App />);

    await openRunModal(user, "UI Selftest Task");
    await user.click(screen.getByRole("button", { name: /开始运行/ }));

    await waitFor(() => {
      expect(startRunMock).toHaveBeenCalledWith("task-1", {});
    });
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

    await openRunModal(user, "UI Selftest Task");
    await user.click(screen.getByRole("button", { name: /开始运行/ }));
    await waitFor(() => {
      expect(startRunMock).toHaveBeenCalledWith("task-1", {});
    });
    await user.click(screen.getByRole("button", { name: "关闭" }));

    await openRunModal(user, "UI Command Task");
    await user.click(screen.getByRole("button", { name: /开始运行/ }));
    await waitFor(() => {
      expect(startRunMock).toHaveBeenCalledWith("task-2", {});
    });

    const taskIds = startRunMock.mock.calls.map((call) => call[0]);
    expect(taskIds).toContain("task-1");
    expect(taskIds).toContain("task-2");
  });

  it("starts a second instance when an allow-policy task is already running", async () => {
    listRunsMock.mockImplementation(async () => [
      {
        id: "run-existing",
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
        attemptCount: 1,
        terminationReason: null,
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    const card = await findCard("UI Selftest Task");
    await user.click(within(card).getByRole("button", { name: /查看运行/ }));
    await user.click(await screen.findByRole("button", { name: /再开一个实例/ }));

    await waitFor(() => {
      expect(startRunMock).toHaveBeenCalledWith("task-1", {});
    });
  });

  it("saves task reliability policies", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openEditModal(user, "UI Selftest Task");
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

    await openEditModal(user, "ComicBox Dynamic Task");
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
    render(<App />);

    await openRunModal(user, "ComicBox Dynamic Task");

    const runtimeInput = await screen.findByRole("textbox", { name: "漫画 ID" });
    await user.type(runtimeInput, "5101");
    expect(runtimeInput.textContent).toBe("5101");
    await user.click(screen.getByRole("button", { name: /开始运行/ }));

    await waitFor(() => {
      expect(startRunMock).toHaveBeenCalledWith("task-3", { book_id: "5101" });
    });
  });

  it("generates typed runtime controls and submits their resolved values", async () => {
    const user = userEvent.setup();
    render(<App />);

    await openRunModal(user, "Typed Dynamic Task");

    expect((await screen.findByRole("spinbutton", { name: "线程数" }) as HTMLInputElement).value)
      .toBe("12");
    expect(screen.getByRole("switch", { name: "静默模式" }).getAttribute("aria-checked"))
      .toBe("false");
    expect((screen.getByRole("combobox", { name: "画质" }) as HTMLSelectElement).value)
      .toBe("1080p");
    expect(screen.getByRole("textbox", { name: "输出目录" }).textContent).toBe("E:/output");

    await user.type(screen.getByLabelText("访问令牌"), "session-token");
    await user.click(screen.getByRole("button", { name: /开始运行/ }));

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

  it("starts LAN sharing from the gallery topbar", async () => {
    const user = userEvent.setup();
    render(<App />);

    await screen.findByText("UI Selftest Task");
    await user.click(screen.getByRole("button", { name: /局域网共享/ }));

    await user.click(screen.getByRole("button", { name: /开启局域网共享/ }));

    expect(saveMobileApiSettingsMock).toHaveBeenCalledWith({
      enabled: true,
      bindHost: "0.0.0.0",
      port: 17631,
    });
    expect(await screen.findByRole("button", { name: /停止局域网共享/ })).toBeTruthy();
  });

  it("toggles favorite from a gallery card without crashing", async () => {
    const user = userEvent.setup();
    render(<App />);

    const card = await findCard("UI Command Task");
    await user.click(cardIconButton(card, "收藏"));

    await waitFor(() => expect(saveTaskMock).toHaveBeenCalled());
    const payload = saveTaskMock.mock.calls[saveTaskMock.mock.calls.length - 1]?.[0];
    expect(payload.id).toBe("task-2");
    expect(payload.favorite).toBe(true);
  });

  it("shows start again when the latest run of a task has ended", async () => {
    listRunsMock.mockImplementation(async () => [
      {
        id: "run-ended",
        taskId: "task-1",
        taskName: "UI Selftest Task",
        status: "finished",
        commandPreview: "python fixture.py",
        workingDirectory: "E:/ScriptWorkbench/fixtures",
        startedAt: "2026-01-01T00:00:00",
        finishedAt: "2026-01-01T00:00:05",
        durationMs: 5000,
        exitCode: 0,
        stdoutLogPath: "stdout.log",
        stderrLogPath: "stderr.log",
        runtimeValues: {},
        attemptCount: 1,
        terminationReason: null,
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    await openRunModal(user, "UI Selftest Task");

    expect(screen.queryByRole("button", { name: /停止运行/ })).toBeNull();
    expect(await screen.findByRole("button", { name: /开始运行/ })).toBeTruthy();
  });

  it("stops a live run from the run modal after confirmation", async () => {
    listRunsMock.mockImplementation(async () => [
      {
        id: "run-live",
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
        attemptCount: 1,
        terminationReason: null,
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    const card = await findCard("UI Selftest Task");
    await user.click(within(card).getByRole("button", { name: /查看运行/ }));

    const stopButton = await screen.findByRole("button", { name: /停止运行/ });
    await user.click(stopButton);

    await waitFor(() => {
      expect(dialogConfirmMock).toHaveBeenCalled();
      expect(stopRunMock).toHaveBeenCalledWith("run-live");
    });
  });

  it("deletes a task after confirmation", async () => {
    const user = userEvent.setup();
    render(<App />);

    await openEditModal(user, "UI Command Task");
    await user.click(screen.getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(dialogConfirmMock).toHaveBeenCalled();
      expect(deleteTaskMock).toHaveBeenCalledWith("task-2");
    });
  });

  it("renders the gallery as the single primary surface", async () => {
    const { container } = render(<App />);
    await screen.findByText("UI Selftest Task");

    expect(container.querySelector(".gallery-shell")).not.toBeNull();
    expect(container.querySelector(".gallery-grid")).not.toBeNull();
    expect(container.querySelectorAll(".gallery-card").length).toBeGreaterThan(0);
    expect(container.querySelector(".task-list")).toBeNull();
    expect(container.querySelector(".gallery-view-nav")).toBeNull();
  });

  it("shows a visible status toast after sending a stop signal", async () => {
    listRunsMock.mockImplementation(async () => [
      {
        id: "run-live",
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
        attemptCount: 1,
        terminationReason: null,
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    const card = await findCard("UI Selftest Task");
    await user.click(within(card).getByRole("button", { name: /查看运行/ }));

    const stopButton = await screen.findByRole("button", { name: /停止运行/ });
    await user.click(stopButton);

    expect(await screen.findByRole("status")).toBeTruthy();
    expect(
      await screen.findByText(/已向「UI Selftest Task」实例 run-live 发送停止信号/),
    ).toBeTruthy();
  });

  it("returns the run modal to the start button immediately after stop succeeds", async () => {
    listRunsMock.mockImplementation(async () => [
      {
        id: "run-live",
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
        attemptCount: 1,
        terminationReason: null,
      },
    ]);
    const user = userEvent.setup();
    render(<App />);

    const card = await findCard("UI Selftest Task");
    await user.click(within(card).getByRole("button", { name: /查看运行/ }));

    const stopButton = await screen.findByRole("button", { name: /停止运行/ });
    await user.click(stopButton);

    // The optimistic local state update must flip the modal back to the start
    // button without waiting for any run://status event to arrive.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /停止运行/ })).toBeNull();
    });
    expect(await screen.findByRole("button", { name: /开始运行/ })).toBeTruthy();
  });
});
