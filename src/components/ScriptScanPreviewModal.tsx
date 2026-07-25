import type { ScriptScanPreview } from "../types";
import { RuntimeParameterEditor } from "./RuntimeParameterEditor";

interface ScriptScanPreviewModalProps {
  preview: ScriptScanPreview;
  busy: boolean;
  onChange: (preview: ScriptScanPreview) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onHelpScan: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  sidecar: "脚本配套配置",
  ast: "静态源码扫描",
  help: "帮助信息补扫",
  template: "参数模板识别",
};

const CONFIDENCE_LABELS: Record<string, string> = {
  high: "结果可靠",
  medium: "建议确认",
  low: "需要确认",
};

export function ScriptScanPreviewModal({
  preview,
  busy,
  onChange,
  onConfirm,
  onCancel,
  onHelpScan,
}: ScriptScanPreviewModalProps) {
  const enabledParameters = preview.parameters.filter((parameter) => parameter.enabled !== false);
  const enabledCount = enabledParameters.length;
  const commonCount = enabledParameters.filter((parameter) => !parameter.advanced).length;
  const advancedCount = enabledParameters.filter((parameter) => parameter.advanced).length;

  return (
    <div className="modal-backdrop scan-preview-backdrop" onClick={onCancel}>
      <div className="modal-card scan-preview-modal" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header scan-preview-header">
          <div>
            <h3>确认运行表单</h3>
            <p className="muted">
              {preview.taskName || "Python 脚本"} · {preview.framework || "未知框架"}
            </p>
          </div>
          <div className="scan-badge-row">
            <span className="scan-source-badge">
              {SOURCE_LABELS[preview.source] ?? "自动识别"}
            </span>
            <span className={`scan-confidence ${preview.confidence}`}>
              {CONFIDENCE_LABELS[preview.confidence] ?? "建议确认"}
            </span>
          </div>
        </div>

        {preview.description && <p className="scan-description">{preview.description}</p>}

        <div className="scan-summary-grid">
          <div><span>识别参数</span><strong>{enabledCount}</strong></div>
          <div><span>常用参数</span><strong>{commonCount}</strong></div>
          <div><span>高级设置</span><strong>{advancedCount}</strong></div>
          <div><span>自动联动</span><strong>{preview.relationshipCandidates.length}</strong></div>
        </div>

        {preview.relationshipCandidates.length > 0 && (
          <section className="scan-preview-section">
            <h4>自动联动</h4>
            <p className="muted">选中的联动会直接体现在最终运行表单中。</p>
            <div className="relationship-list">
              {preview.relationshipCandidates.map((candidate, index) => (
                <label className="relationship-card" key={candidate.id}>
                  <input
                    type="checkbox"
                    checked={candidate.enabled}
                    onChange={(event) => onChange({
                      ...preview,
                      relationshipCandidates: preview.relationshipCandidates.map((item, current) => (
                        current === index ? { ...item, enabled: event.currentTarget.checked } : item
                      )),
                    })}
                  />
                  <span>
                    <strong>{candidate.label}</strong>
                    <small>
                      {candidate.description} · {CONFIDENCE_LABELS[candidate.confidence] ?? "建议确认"}
                    </small>
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}

        <section className="scan-preview-section scan-parameter-section">
          <div className="section-heading-row">
            <div>
              <h4>运行表单字段</h4>
              <p className="muted">默认只显示业务字段；派生、分组等配置收在每项的“高级规则”中。</p>
            </div>
          </div>
          <RuntimeParameterEditor
            parameters={preview.parameters}
            onChange={(parameters) => onChange({ ...preview, parameters })}
          />
        </section>

        <details className="scan-preview-section scan-technical-details">
          <summary>查看生成命令</summary>
          <pre className="command-preview scan-command-preview">
            {preview.generatedArguments.join(" ") || "确认后将按表单值生成运行命令"}
          </pre>
        </details>

        {preview.diagnostics.length > 0 && (
          <details className="scan-preview-section scan-technical-details">
            <summary>查看扫描说明</summary>
            <ul className="scan-diagnostics">
              {preview.diagnostics.map((diagnostic, index) => (
                <li key={`${diagnostic}-${index}`}>{diagnostic}</li>
              ))}
            </ul>
          </details>
        )}

        <div className="panel-actions scan-preview-actions">
          <button type="button" className="ghost-button" disabled={busy} onClick={onCancel}>
            取消
          </button>
          {preview.source !== "sidecar" && (
            <button type="button" className="secondary-button" disabled={busy} onClick={onHelpScan}>
              {busy ? "补扫中..." : "补充识别"}
            </button>
          )}
          <button type="button" className="primary-button" disabled={busy || enabledCount === 0} onClick={onConfirm}>
            使用此运行表单
          </button>
        </div>
      </div>
    </div>
  );
}

