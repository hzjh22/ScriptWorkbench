import type { MobileApiSettings, MobileApiStatus, SharedFolder } from "../types";

export interface LanShareModalProps {
  status: MobileApiStatus | null;
  draft: MobileApiSettings;
  busy: boolean;
  sharedFolders: SharedFolder[];
  sharedFolderBusy: boolean;
  onDraftChange: (updater: (current: MobileApiSettings) => MobileApiSettings) => void;
  onSave: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onRegeneratePairingCode: () => void;
  onAddSharedFolder: () => void;
  onRemoveSharedFolder: (id: string) => void;
  onCopy: (label: string, text: string) => void;
  onClose: () => void;
}

export function LanShareModal(props: LanShareModalProps) {
  const {
    status,
    draft,
    busy,
    sharedFolders,
    sharedFolderBusy,
    onDraftChange,
    onSave,
    onToggleEnabled,
    onRegeneratePairingCode,
    onAddSharedFolder,
    onRemoveSharedFolder,
    onCopy,
    onClose,
  } = props;

  const running = Boolean(status?.serverRunning);
  const baseUrls = status?.baseUrls ?? [];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card lan-share-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="panel-header">
          <div>
            <h3>局域网共享</h3>
            <p className="muted">
              一键开启后，手机可在同一局域网内查看任务、运行日志并下载共享文件。
            </p>
          </div>
          <div className="panel-actions">
            <span className={`status-pill ${running ? "running" : "stopped"}`}>
              {running ? "共享中" : "未开启"}
            </span>
            <button className="ghost-button" onClick={onClose}>
              ✕
            </button>
          </div>
        </div>

        <div className="lan-share-primary">
          <button
            className={running ? "secondary-button" : "primary-button"}
            disabled={busy}
            onClick={() => onToggleEnabled(!running)}
          >
            {busy
              ? "处理中..."
              : running
                ? "停止局域网共享"
                : "▶ 开启局域网共享"}
          </button>
          <span className="muted">{status?.message ?? "局域网共享尚未初始化"}</span>
        </div>

        <div className="detail-grid">
          <div>
            <span>服务状态</span>
            <strong>{running ? "运行中" : "未运行"}</strong>
          </div>
          <div>
            <span>配对鉴权</span>
            <strong>{status?.tokenConfigured ? "已配对" : "未配对"}</strong>
          </div>
          <div>
            <span>监听</span>
            <strong>
              {(status?.bindHost ?? draft.bindHost)}:{status?.port ?? draft.port}
            </strong>
          </div>
        </div>

        <div className="filter-grid">
          <label className="field">
            <span>监听地址</span>
            <input
              className="text-input"
              value={draft.bindHost}
              onChange={(event) =>
                onDraftChange((current) => ({
                  ...current,
                  bindHost: event.currentTarget.value,
                }))
              }
            />
          </label>
          <label className="field">
            <span>端口</span>
            <input
              className="text-input"
              type="number"
              min={1024}
              max={65535}
              value={draft.port}
              onChange={(event) =>
                onDraftChange((current) => ({
                  ...current,
                  port: Number(event.currentTarget.value) || 17631,
                }))
              }
            />
          </label>
        </div>

        <div className="panel-actions">
          <button className="ghost-button" disabled={busy} onClick={onSave}>
            {busy ? "保存中..." : "保存监听设置"}
          </button>
          <span className="muted">
            绑定 0.0.0.0 会向整个局域网暴露服务，请务必让手机使用下方配对码完成配对。
          </span>
        </div>

        <label className="field">
          <span>手机访问地址</span>
          <pre className="command-preview">
            {baseUrls.length ? baseUrls.join("\n") : "开启后显示局域网访问地址"}
          </pre>
          {baseUrls.length > 0 && (
            <div className="panel-actions">
              <button
                className="ghost-button"
                onClick={() => onCopy("访问地址", baseUrls.join("\n"))}
              >
                复制地址
              </button>
            </div>
          )}
        </label>

        <label className="field">
          <span>配对码</span>
          <pre className="command-preview mobile-pairing-code">
            {status?.pairingCode || "------"}
          </pre>
          <div className="panel-actions">
            <button
              className="ghost-button"
              disabled={busy || !status?.pairingCode}
              onClick={() => status?.pairingCode && onCopy("配对码", status.pairingCode)}
            >
              复制配对码
            </button>
            <button
              className="ghost-button"
              disabled={busy}
              onClick={onRegeneratePairingCode}
            >
              重置配对码
            </button>
          </div>
        </label>

        <div className="field">
          <span>共享文件夹</span>
          <p className="muted">
            配置后，手机 App 的「共享」页可逐级浏览这些文件夹并按原目录结构拉取文件。
          </p>
          {sharedFolders.length === 0 ? (
            <p className="muted">尚未配置共享文件夹。</p>
          ) : (
            <ul className="shared-folder-list">
              {sharedFolders.map((folder) => (
                <li key={folder.id} className="shared-folder-item">
                  <div className="shared-folder-meta">
                    <strong>{folder.label}</strong>
                    <span className="muted">{folder.path}</span>
                  </div>
                  <button
                    className="ghost-button"
                    disabled={sharedFolderBusy}
                    onClick={() => onRemoveSharedFolder(folder.id)}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="panel-actions">
            <button
              className="ghost-button"
              disabled={sharedFolderBusy}
              onClick={onAddSharedFolder}
            >
              添加共享文件夹
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
