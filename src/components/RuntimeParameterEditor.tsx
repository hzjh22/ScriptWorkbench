import type {
  RuntimeParameterDefinition,
  RuntimeParameterType,
} from "../types";
import { SafeSingleLineInput, SafeToggle } from "./SafeFields";

const TYPE_OPTIONS: Array<{ value: RuntimeParameterType; label: string }> = [
  { value: "text", label: "文本" },
  { value: "number", label: "数字" },
  { value: "boolean", label: "开关" },
  { value: "choice", label: "下拉选项" },
  { value: "file", label: "文件路径" },
  { value: "directory", label: "目录路径" },
  { value: "secret", label: "密码 / Token" },
];

interface RuntimeParameterEditorProps {
  parameters: RuntimeParameterDefinition[];
  onChange: (parameters: RuntimeParameterDefinition[]) => void;
}

function typeLabel(type: RuntimeParameterType): string {
  return TYPE_OPTIONS.find((option) => option.value === type)?.label ?? type;
}

export function RuntimeParameterEditor({ parameters, onChange }: RuntimeParameterEditorProps) {
  function update(index: number, patch: Partial<RuntimeParameterDefinition>) {
    onChange(parameters.map((parameter, current) => (
      current === index ? { ...parameter, ...patch } : parameter
    )));
  }

  if (parameters.length === 0) {
    return (
      <div className="runtime-empty">
        还没有可配置的运行参数。选择 Python 脚本后点击“扫描参数”，或先添加参数模板。
      </div>
    );
  }

  return (
    <div className="runtime-parameter-editor-list">
      {parameters.map((parameter, index) => {
        const label = parameter.label || parameter.name;
        return (
          <section className="runtime-parameter-card" key={parameter.name}>
            <div className="runtime-parameter-card-title">
              <div className="runtime-parameter-identity">
                <strong>{label}</strong>
                <small>{parameter.description || "运行时由用户填写"}</small>
              </div>
              <div className="parameter-toggle-row">
                <span className="parameter-type-badge">{typeLabel(parameter.type)}</span>
                <span className={parameter.required ? "parameter-required-badge" : "parameter-optional-badge"}>
                  {parameter.required ? "必填" : "选填"}
                </span>
                {parameter.derivedTemplate && <span className="derived-badge">自动生成</span>}
                <SafeToggle
                  checked={parameter.enabled !== false}
                  label="使用参数"
                  onChange={(enabled) => update(index, { enabled })}
                />
              </div>
            </div>

            <div className="runtime-parameter-quick-grid">
              <label className="field">
                <span>表单名称</span>
                <SafeSingleLineInput
                  value={label}
                  ariaLabel={`${parameter.name} 表单名称`}
                  onChange={(nextLabel) => update(index, { label: nextLabel })}
                />
              </label>

              <label className="field">
                <span>输入方式</span>
                <select
                  className="text-input native-input"
                  aria-label={`${parameter.name} 输入方式`}
                  value={parameter.type}
                  onChange={(event) => {
                    const type = event.currentTarget.value as RuntimeParameterType;
                    update(index, {
                      type,
                      defaultValue: type === "secret" ? "" : parameter.defaultValue,
                      min: type === "number" ? parameter.min : null,
                      max: type === "number" ? parameter.max : null,
                    });
                  }}
                >
                  {TYPE_OPTIONS.map((option) => (
                    <option value={option.value} key={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>

              <div className="field runtime-parameter-required-control">
                <span>填写要求</span>
                <SafeToggle
                  checked={parameter.required}
                  label="运行前必填"
                  onChange={(required) => update(index, { required })}
                />
              </div>

              {parameter.type !== "secret" ? (
                <label className="field">
                  <span>默认值</span>
                  <SafeSingleLineInput
                    value={parameter.defaultValue}
                    ariaLabel={`${parameter.name} 默认值`}
                    placeholder={parameter.required ? "可在运行时填写" : "留空表示不预设"}
                    onChange={(defaultValue) => update(index, { defaultValue })}
                  />
                </label>
              ) : (
                <div className="field runtime-secret-note">
                  <span>敏感参数</span>
                  <small className="muted">仅进入当前子进程，不写入历史和命令预览。</small>
                </div>
              )}
            </div>

            <details className="runtime-parameter-advanced">
              <summary>高级规则</summary>
              <div className="runtime-parameter-editor-grid">
                <label className="field">
                  <span>参数分组</span>
                  <SafeSingleLineInput
                    value={parameter.group || (parameter.advanced ? "高级设置" : "常用参数")}
                    ariaLabel={`${parameter.name} 参数分组`}
                    onChange={(group) => update(index, { group })}
                  />
                </label>

                <label className="field runtime-parameter-wide">
                  <span>辅助说明</span>
                  <SafeSingleLineInput
                    value={parameter.description}
                    ariaLabel={`${parameter.name} 参数说明`}
                    placeholder="显示在运行表单下方"
                    onChange={(description) => update(index, { description })}
                  />
                </label>

                <div className="field inline runtime-parameter-wide">
                  <SafeToggle
                    checked={Boolean(parameter.advanced)}
                    label="放入高级设置"
                    onChange={(advanced) => update(index, {
                      advanced,
                      group: advanced ? "高级设置" : "常用参数",
                    })}
                  />
                  <SafeToggle
                    checked={Boolean(parameter.locked)}
                    label="保留人工设置"
                    onChange={(locked) => update(index, { locked })}
                  />
                  {parameter.derivedTemplate && (
                    <SafeToggle
                      checked={parameter.allowOverride !== false}
                      label="允许修改自动生成值"
                      onChange={(allowOverride) => update(index, { allowOverride })}
                    />
                  )}
                </div>

                {parameter.type !== "secret" && (
                  <label className="field runtime-parameter-wide">
                    <span>自动生成规则</span>
                    <SafeSingleLineInput
                      value={parameter.derivedTemplate || ""}
                      ariaLabel={`${parameter.name} 自动生成规则`}
                      placeholder="例如：runs/视频ID"
                      onChange={(derivedTemplate) => update(index, {
                        derivedTemplate: derivedTemplate || null,
                      })}
                    />
                  </label>
                )}

                {parameter.type === "choice" && (
                  <label className="field runtime-parameter-wide">
                    <span>可选项（逗号分隔）</span>
                    <SafeSingleLineInput
                      value={parameter.options.join(", ")}
                      ariaLabel={`${parameter.name} 可选项`}
                      placeholder="例如：720p, 1080p, 4k"
                      onChange={(value) => update(index, {
                        options: value.split(",").map((item) => item.trim()).filter(Boolean),
                      })}
                    />
                  </label>
                )}

                {parameter.type === "number" && (
                  <>
                    <label className="field">
                      <span>最小值</span>
                      <input
                        className="text-input native-input"
                        type="number"
                        aria-label={`${parameter.name} 最小值`}
                        value={parameter.min ?? ""}
                        onChange={(event) => update(index, {
                          min: event.currentTarget.value === "" ? null : Number(event.currentTarget.value),
                        })}
                      />
                    </label>
                    <label className="field">
                      <span>最大值</span>
                      <input
                        className="text-input native-input"
                        type="number"
                        aria-label={`${parameter.name} 最大值`}
                        value={parameter.max ?? ""}
                        onChange={(event) => update(index, {
                          max: event.currentTarget.value === "" ? null : Number(event.currentTarget.value),
                        })}
                      />
                    </label>
                  </>
                )}
              </div>
            </details>
          </section>
        );
      })}
    </div>
  );
}

