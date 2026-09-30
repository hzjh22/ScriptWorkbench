import { useEffect, useRef } from "react";
import type {
  RuntimeParameterDefinition,
  RuntimeParameterType,
  RuntimeValues,
  TaskRecord,
} from "../types";
import { RuntimeParameterFields } from "./RuntimeParameterFields";

// curl 的进度表默认写入 stderr；在任务输出中会被逐行收集。识别这些行后，
// 用进度条展示，避免把终端控制台的原始刷新内容直接堆到界面上。
const CURL_PROGRESS_PREFIX = /^\s*(\d{1,3})\s+(?=\d+(?:\.\d+)?[KMGk]\s+\d+\s+\d+(?:\.\d+)?[KMGk]\b)/gm;
const CURL_PROGRESS_LINE = /^\s*\d{1,3}\s+\d+(?:\.\d+)?[KMGk]\s+\d+\s+\d+(?:\.\d+)?[KMGk]\b.*$/;

export function extractTransferProgress(text: string): number | null {
  const values = [...text.matchAll(CURL_PROGRESS_PREFIX)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    return null;
  }
  return Math.min(100, Math.max(...values));
}

export function removeTransferProgressLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !CURL_PROGRESS_LINE.test(line))
    .join("\n")
    .trim();
}

export interface TaskRunModalProps {
  task: TaskRecord;
  parameters: RuntimeParameterDefinition[];
  values: RuntimeValues;
  errors: Record<string, string>;
  commandPreview: string;
  onValueChange: (name: string, value: string) => void;
  onPickPath: (
    name: string,
    type: Extract<RuntimeParameterType, "file" | "directory">,
    currentValue: string,
  ) => void;
  onRun: () => void;
  onStop: () => void;
  onEditConfig: () => void;
  onClose: () => void;
  isRunning: boolean;
  runningCount: number;
  allowConcurrentStart: boolean;
  runStatus: string;
  stdout: string;
  stderr: string;
}

export function TaskRunModal(props: TaskRunModalProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const parameters = props.parameters;
  const hasParameters = parameters.length > 0;
  const transferProgress = extractTransferProgress(`${props.stdout}\n${props.stderr}`);
  const displayedStdout = removeTransferProgressLines(props.stdout);
  const displayedStderr = removeTransferProgressLines(props.stderr);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.scrollTop = terminalRef.current.scrollHeight;
    }
  }, [props.stdout, props.stderr]);

  function handleBackdropClick(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      props.onClose();
    }
  }

  return (
    <div className="modal-backdrop" onClick={handleBackdropClick}>
      <div className="modal-card task-run-modal" role="dialog" aria-modal="true">
        <div className="task-run-modal-header">
          <div className="task-run-modal-title">
            <h3>{props.task.name || "未命名任务"}</h3>
            <span className={`task-kind-tag ${props.task.kind === "python_task" ? "python" : "command"}`}>
              {props.task.kind === "python_task" ? "Python" : "命令"}
            </span>
            {props.isRunning && (
              <span className="status-pill running">
                {props.runStatus || "运行中"}{props.runningCount > 1 ? ` ×${props.runningCount}` : ""}
              </span>
            )}
          </div>
          <div className="task-run-modal-header-actions">
            <button className="ghost-button compact-button" onClick={props.onEditConfig}>
              ⚙ 编辑配置
            </button>
            <button className="ghost-button compact-button" onClick={props.onClose} aria-label="关闭">
              ✕
            </button>
          </div>
        </div>

        <div className="task-run-modal-body">
          {hasParameters ? (
            <div className="task-run-section">
              <div className="task-run-section-title">
                <strong>运行参数</strong>
                <span className="muted">填写本次运行参数，不会修改任务配置模板</span>
              </div>
              <RuntimeParameterFields
                parameters={parameters}
                values={props.values}
                errors={props.errors}
                onChange={props.onValueChange}
                onPickPath={props.onPickPath}
              />
            </div>
          ) : (
            <div className="runtime-empty">
              该任务没有定义运行参数，点击下方运行按钮直接执行。
            </div>
          )}

          <div className="task-run-section">
            <div className="task-run-section-title">
              <strong>本次运行命令</strong>
            </div>
            <pre className="command-preview compact-preview">{props.commandPreview || "（命令预览不可用）"}</pre>
          </div>

          {(props.isRunning || props.stdout || props.stderr) && (
            <div className="task-run-section">
              <div className="task-run-section-title">
                <strong>内置终端</strong>
                <span className="muted">任务输出始终在软件内显示，不弹系统终端</span>
              </div>
              {transferProgress !== null && (
                <div
                  className="task-progress-card"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={transferProgress}
                  aria-label="视频下载进度"
                >
                  <div className="task-progress-header">
                    <span>{transferProgress >= 100 ? "视频下载完成" : "视频下载中"}</span>
                    <strong>{transferProgress}%</strong>
                  </div>
                  <div className="task-progress-track">
                    <div className="task-progress-fill" style={{ width: `${transferProgress}%` }} />
                  </div>
                </div>
              )}
              <div className="task-run-terminal-grid">
                <div className="task-run-terminal-block">
                  <div className="task-run-terminal-label">stdout</div>
                  <div ref={terminalRef} className="terminal-output stdout task-run-terminal-output">
                    {displayedStdout || "（暂无标准输出）"}
                  </div>
                </div>
                <div className="task-run-terminal-block">
                  <div className="task-run-terminal-label">stderr</div>
                  <div className="terminal-output stderr task-run-terminal-output">
                    {displayedStderr || "（暂无错误输出）"}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="task-run-modal-footer">
          <div className="task-run-modal-status">
            {props.isRunning ? (
              <span className="status-pill running">● 运行中</span>
            ) : (
              <span className="status-pill finished">● 就绪</span>
            )}
          </div>
          <div className="task-run-modal-actions">
            {props.isRunning ? (
              <>
                <button className="primary-button danger" onClick={props.onStop}>
                  停止运行（当前实例）
                </button>
                {props.allowConcurrentStart && (
                  <button
                    className="primary-button"
                    disabled={Object.keys(props.errors).length > 0}
                    onClick={props.onRun}
                  >
                    ▶ 再开一个实例
                  </button>
                )}
              </>
            ) : (
              <button
                className="primary-button"
                disabled={Object.keys(props.errors).length > 0}
                onClick={props.onRun}
              >
                ▶ 开始运行
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
