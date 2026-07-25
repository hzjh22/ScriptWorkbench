import type {
  RuntimeParameterDefinition,
  RuntimeParameterType,
  RuntimeValues,
} from "../types";
import { SafeMultilineInput, SafeSingleLineInput, SafeToggle } from "./SafeFields";
import { conditionMatches, runtimeValuesWithDerived } from "../lib/runtimeParameters";

interface RuntimeParameterFieldsProps {
  parameters: RuntimeParameterDefinition[];
  values: RuntimeValues;
  errors: Record<string, string>;
  onChange: (name: string, value: string) => void;
  onPickPath: (
    name: string,
    type: Extract<RuntimeParameterType, "file" | "directory">,
    currentValue: string,
  ) => void;
  repeatParameterNames?: string[];
}

export function RuntimeParameterFields({
  parameters,
  values,
  errors,
  onChange,
  onPickPath,
  repeatParameterNames = [],
}: RuntimeParameterFieldsProps) {
  const resolvedValues = runtimeValuesWithDerived(parameters, values);
  const visibleParameters = parameters.filter((parameter) => (
    parameter.enabled !== false && conditionMatches(parameter.condition, resolvedValues)
  ));
  const common = visibleParameters.filter((parameter) => !parameter.advanced);
  const advanced = visibleParameters.filter((parameter) => parameter.advanced);
  const isComicBoxForm = visibleParameters.some((parameter) => parameter.name === "book_id")
    && visibleParameters.some((parameter) => parameter.name === "book_url");
  const isVideoSourceForm = visibleParameters.some((parameter) => parameter.name === "source_mode");

  function choiceOptionLabel(parameter: RuntimeParameterDefinition, option: string): string {
    const labels: Record<string, Record<string, string>> = {
      source_mode: { id: "视频 ID", url: "播放页地址", html: "本地 HTML 文件" },
      network_mode: { system: "使用系统设置", direct: "直接连接", proxy: "指定代理" },
      target_mode: { link: "消息链接", entity: "实体 / 对话" },
      action: { inspect: "仅检查", download: "下载媒体" },
      media: { all: "全部媒体", video: "视频", photo: "图片", document: "文档", audio: "音频" },
      grouped: { auto: "自动识别", single: "仅当前消息", album: "整组相册" },
      login: { qr: "二维码登录", phone: "手机号登录" },
    };
    return labels[parameter.name]?.[option] ?? option;
  }

  function parameterPlaceholder(parameter: RuntimeParameterDefinition): string {
    switch (parameter.name) {
      case "book_id": return "例如 5336";
      case "chapters": return "例如 77-117；留空表示全部下载";
      case "limit": return "留空表示不限制";
      case "video_id": return "输入视频 ID";
      case "watch_url": return "输入完整播放页地址";
      case "links": return "每行输入一个 t.me 消息链接";
      case "entity": return "例如 @channel_or_bot";
      case "message_ids": return "例如 53,54,55；留空读取最近消息";
      case "history_limit": return "例如 20";
      case "proxy": return "例如 http://127.0.0.1:7897";
      default:
        if (parameter.type === "file") return "选择或输入文件路径";
        if (parameter.type === "directory") return "选择或输入目录路径";
        return `输入 ${parameter.label || parameter.name}`;
    }
  }

  function renderParameter(parameter: RuntimeParameterDefinition) {
    const rawValue = values[parameter.name] ?? parameter.defaultValue;
    const value = rawValue || resolvedValues[parameter.name] || "";
    const error = errors[parameter.name];
    const label = parameter.label || parameter.name;
    const readOnlyDerived = Boolean(parameter.derivedTemplate && parameter.allowOverride === false);
    return (
      <div
        className={`field runtime-parameter-field ${isComicBoxForm ? "comicbox-runtime-parameter" : ""} ${error ? "invalid" : ""}`}
        key={parameter.name}
      >
        <span>
          {label}
          {parameter.required && <span className="required-mark" aria-hidden="true"> *</span>}
          {parameter.derivedTemplate && (
            <span className="derived-badge">
              {parameter.allowOverride === false ? "自动生成" : "自动生成，可修改"}
            </span>
          )}
        </span>

        {parameter.type === "number" ? (
          <input
            className="text-input native-input"
            type="number"
            aria-label={label}
            value={value}
            min={parameter.min ?? undefined}
            max={parameter.max ?? undefined}
            placeholder={parameterPlaceholder(parameter)}
            disabled={readOnlyDerived}
            onChange={(event) => onChange(parameter.name, event.currentTarget.value)}
          />
        ) : parameter.type === "boolean" ? (
          <SafeToggle
            checked={value === "true"}
            label={label}
            onChange={(checked) => onChange(parameter.name, checked ? "true" : "false")}
          />
        ) : parameter.type === "choice" ? (
          <select
            className="text-input native-input"
            aria-label={label}
            value={value}
            disabled={readOnlyDerived}
            onChange={(event) => onChange(parameter.name, event.currentTarget.value)}
          >
            <option value="">请选择</option>
            {parameter.options.map((option) => (
              <option value={option} key={option}>
                {choiceOptionLabel(parameter, option)}
              </option>
            ))}
          </select>
        ) : parameter.type === "secret" ? (
          <input
            className="text-input native-input"
            type="password"
            autoComplete="off"
            aria-label={label}
            value={value}
            onChange={(event) => onChange(parameter.name, event.currentTarget.value)}
          />
        ) : parameter.type === "file" || parameter.type === "directory" ? (
          <div className="path-row">
            <SafeSingleLineInput
              value={value}
              ariaLabel={label}
              disabled={readOnlyDerived}
              placeholder={parameterPlaceholder(parameter)}
              onChange={(next) => onChange(parameter.name, next)}
            />
            {!readOnlyDerived && (
              <button
                type="button"
                className="ghost-button"
                onClick={() => onPickPath(
                  parameter.name,
                  parameter.type as "file" | "directory",
                  value,
                )}
              >
                {parameter.type === "file" ? "选择文件" : "选择目录"}
              </button>
            )}
          </div>
        ) : repeatParameterNames.includes(parameter.name) ? (
          <SafeMultilineInput
            value={value}
            ariaLabel={label}
            minHeight={92}
            placeholder="每行输入一个值，运行时重复生成参数"
            onChange={(next) => onChange(parameter.name, next)}
          />
        ) : (
          <SafeSingleLineInput
            value={value}
            ariaLabel={label}
            disabled={readOnlyDerived}
            placeholder={parameterPlaceholder(parameter)}
            onChange={(next) => onChange(parameter.name, next)}
          />
        )}

        {parameter.description && <small className="muted">{parameter.description}</small>}
        {parameter.derivedTemplate && parameter.allowOverride !== false && !rawValue && (
          <small className="muted">当前自动生成：{resolvedValues[parameter.name]}</small>
        )}
        {error && <small className="field-error" role="alert">{error}</small>}
      </div>
    );
  }

  return (
    <div className={`runtime-fields ${isComicBoxForm ? "comicbox-runtime-fields" : ""} ${isVideoSourceForm ? "video-runtime-fields" : ""}`}>
      {common.map(renderParameter)}
      {advanced.length > 0 && (
        <details className="advanced-runtime-group">
          <summary>高级设置（{advanced.length}）</summary>
          <div className="runtime-fields advanced-runtime-fields">
            {advanced.map(renderParameter)}
          </div>
        </details>
      )}
    </div>
  );
}
