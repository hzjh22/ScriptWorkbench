import type {
  ArgumentCondition,
  ArgumentMode,
  RuntimeParameterDefinition,
  RuntimeValues,
  ValidationRule,
} from "../types";
import { extractRuntimeVariableNames } from "./taskUtils";

const FRIENDLY_PARAMETER_LABELS: Record<string, string> = {
  book_id: "漫画 ID",
  book_url: "漫画地址",
  video_id: "视频 ID",
  output: "输出目录",
  output_dir: "输出目录",
  output_root: "输出根目录",
  chapters: "章节范围",
  limit: "最多处理章节数",
  workers: "并发下载数",
  http_pool_size: "HTTP 连接池大小",
};

function friendlyParameterLabel(name: string, currentLabel: string): string {
  if (currentLabel.trim() && currentLabel !== name) return currentLabel;
  return FRIENDLY_PARAMETER_LABELS[name] ?? (currentLabel || name);
}

export function createDefaultRuntimeParameter(name: string): RuntimeParameterDefinition {
  return {
    name,
    label: name,
    description: "",
    type: "text",
    required: true,
    defaultValue: "",
    options: [],
    min: null,
    max: null,
    group: "常用参数",
    advanced: false,
    source: "template",
    confidence: "low",
    locked: false,
    condition: null,
    derivedTemplate: null,
    allowOverride: true,
    enabled: true,
  };
}

export function normalizeRuntimeParameter(
  parameter: RuntimeParameterDefinition,
): RuntimeParameterDefinition {
  const normalized = {
    ...createDefaultRuntimeParameter(parameter.name),
    ...parameter,
    label: friendlyParameterLabel(parameter.name, parameter.label),
    options: parameter.options ?? [],
    group: parameter.group || (parameter.advanced ? "高级设置" : "常用参数"),
    confidence: parameter.confidence ?? "low",
    condition: parameter.condition ?? null,
    derivedTemplate: parameter.derivedTemplate ?? null,
    allowOverride: parameter.allowOverride ?? true,
    enabled: parameter.enabled ?? true,
  };
  // 业务 ID 使用文本控件，保留可能存在的前导零，也避免数字输入框的步进器干扰。
  if (parameter.name === "book_id" || parameter.name === "video_id") {
    normalized.type = "text";
  }
  return normalized;
}

export function syncRuntimeParameters(
  template: string,
  existing: RuntimeParameterDefinition[] = [],
  argumentMode: ArgumentMode = "template",
): RuntimeParameterDefinition[] {
  if (argumentMode === "structured") {
    return existing.map(normalizeRuntimeParameter);
  }
  const byName = new Map(existing.map((parameter) => [
    parameter.name,
    normalizeRuntimeParameter(parameter),
  ]));
  return extractRuntimeVariableNames(template).map(
    (name) => byName.get(name) ?? createDefaultRuntimeParameter(name),
  );
}

function interpolate(template: string, values: RuntimeValues): string {
  return template.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name: string) => (
    values[name] ?? ""
  ));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesDerivedTemplateShape(template: string, value: string): boolean {
  if (!/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/.test(template)) return false;
  const pattern = `^${template
    .split(/\{\{[A-Za-z_][A-Za-z0-9_]*\}\}/)
    .map(escapeRegExp)
    .join(".+")}$`;
  return new RegExp(pattern).test(value);
}

export function conditionMatches(
  condition: ArgumentCondition | null | undefined,
  values: RuntimeValues,
): boolean {
  if (!condition) return true;
  const actual = values[condition.field] ?? "";
  switch (condition.operator) {
    case "equals": return actual === (condition.value ?? "");
    case "not_equals": return actual !== (condition.value ?? "");
    case "truthy": return actual === "true";
    case "falsy": return actual === "false";
    case "non_empty": return Boolean(actual.trim());
    case "empty": return !actual.trim();
  }
}

export function runtimeValuesWithDerived(
  parameters: RuntimeParameterDefinition[],
  suppliedValues: RuntimeValues,
): RuntimeValues {
  const values = Object.fromEntries(parameters.map((parameter) => [
    parameter.name,
    suppliedValues[parameter.name] ?? parameter.defaultValue,
  ]));
  for (let pass = 0; pass < Math.max(parameters.length, 1); pass += 1) {
    let changed = false;
    for (const parameter of parameters) {
      if (!parameter.derivedTemplate) continue;
      const current = values[parameter.name] ?? "";
      if (parameter.allowOverride && current.trim()) continue;
      const derived = interpolate(parameter.derivedTemplate, values);
      if (derived !== current) {
        values[parameter.name] = derived;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return values;
}

function shouldRefreshDerivedValue(
  parameters: RuntimeParameterDefinition[],
  currentValues: RuntimeValues,
  parameter: RuntimeParameterDefinition,
): boolean {
  const template = parameter.derivedTemplate;
  if (!template) return false;
  if (parameter.allowOverride === false) return true;

  const currentValue = currentValues[parameter.name] ?? "";
  if (!currentValue.trim()) return true;

  const previousAutoValues = runtimeValuesWithDerived(parameters, {
    ...currentValues,
    [parameter.name]: "",
  });
  if (currentValue === (previousAutoValues[parameter.name] ?? "")) return true;

  return matchesDerivedTemplateShape(template, currentValue);
}

function syncAutoDerivedValues(
  parameters: RuntimeParameterDefinition[],
  values: RuntimeValues,
  skippedName?: string,
): RuntimeValues {
  const autoDerivedNames = parameters
    .filter((parameter) => parameter.name !== skippedName)
    .filter((parameter) => shouldRefreshDerivedValue(parameters, values, parameter))
    .map((parameter) => parameter.name);
  if (autoDerivedNames.length === 0) return values;

  const valuesForDerivation = { ...values };
  for (const name of autoDerivedNames) {
    valuesForDerivation[name] = "";
  }
  const nextResolvedValues = runtimeValuesWithDerived(parameters, valuesForDerivation);
  const nextValues = { ...values };
  for (const name of autoDerivedNames) {
    nextValues[name] = nextResolvedValues[name] ?? "";
  }
  return nextValues;
}

export function runtimeValuesAfterChange(
  parameters: RuntimeParameterDefinition[],
  currentValues: RuntimeValues,
  changedName: string,
  changedValue: string,
): RuntimeValues {
  return syncAutoDerivedValues(
    parameters,
    { ...currentValues, [changedName]: changedValue },
    changedName,
  );
}

export function runtimeValuesWithDefaults(
  parameters: RuntimeParameterDefinition[],
  savedValues: RuntimeValues,
): RuntimeValues {
  const values = Object.fromEntries(
    parameters.map((parameter) => [
      parameter.name,
      savedValues[parameter.name] ?? parameter.defaultValue,
    ]),
  );
  return syncAutoDerivedValues(parameters, values);
}

export function validateRuntimeValues(
  parameters: RuntimeParameterDefinition[],
  values: RuntimeValues,
  validationRules: ValidationRule[] = [],
  multilineParameters: string[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const resolvedValues = runtimeValuesWithDerived(parameters, values);
  for (const parameter of parameters) {
    if (!parameter.enabled || !conditionMatches(parameter.condition, resolvedValues)) continue;
    const value = resolvedValues[parameter.name] ?? parameter.defaultValue;
    if (!value.trim()) {
      if (parameter.required) errors[parameter.name] = "此参数为必填项";
      continue;
    }
    if (/\0|\r/.test(value) || (value.includes("\n") && !multilineParameters.includes(parameter.name))) {
      errors[parameter.name] = "不能包含换行或空字符";
      continue;
    }
    if (parameter.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        errors[parameter.name] = "请输入有效数字";
      } else if (parameter.min !== null && number < parameter.min) {
        errors[parameter.name] = `不能小于 ${parameter.min}`;
      } else if (parameter.max !== null && number > parameter.max) {
        errors[parameter.name] = `不能大于 ${parameter.max}`;
      }
    } else if (parameter.type === "boolean" && !["true", "false"].includes(value)) {
      errors[parameter.name] = "请选择开启或关闭";
    } else if (parameter.type === "choice" && !parameter.options.includes(value)) {
      errors[parameter.name] = "请选择有效选项";
    }
  }
  const nonEmpty = (name: string) => Boolean((resolvedValues[name] ?? "").trim());
  for (const rule of validationRules) {
    if (!conditionMatches(rule.condition, resolvedValues)) continue;
    let invalid = false;
    if (rule.kind === "conditional_required") {
      invalid = rule.fields.some((field) => !nonEmpty(field));
    } else if (rule.kind === "at_least_one") {
      invalid = !rule.fields.some(nonEmpty);
    } else if (rule.kind === "mutually_exclusive") {
      invalid = rule.fields.filter(nonEmpty).length > 1;
    } else if (rule.kind === "range") {
      invalid = rule.fields.some((field) => {
        if (!nonEmpty(field)) return false;
        const value = Number(resolvedValues[field]);
        return !Number.isFinite(value) || (rule.min !== null && value < rule.min)
          || (rule.max !== null && value > rule.max);
      });
    } else if (rule.kind === "enum") {
      invalid = rule.fields.some((field) => (
        nonEmpty(field) && !rule.options.includes(resolvedValues[field])
      ));
    } else if (rule.kind === "repeat") {
      invalid = rule.fields.some((field) => {
        const count = (resolvedValues[field] ?? "").split(/\r?\n/).filter((item) => item.trim()).length;
        return (rule.min !== null && count < rule.min) || (rule.max !== null && count > rule.max);
      });
    }
    if (invalid) {
      for (const field of rule.fields) {
        errors[field] ??= rule.message || `请检查联合参数：${rule.fields.join("、")}`;
      }
    }
  }
  return errors;
}
