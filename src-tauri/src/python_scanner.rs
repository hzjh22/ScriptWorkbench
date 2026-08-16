use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{anyhow, Context};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::process::Command;

use crate::{
    command_template::{extract_runtime_variables, tokenize_command_line},
    process_control::ProcessTree,
    runtime_parameters::{default_parameter, RuntimeParameterDefinition, RuntimeParameterType},
    structured_arguments::{
        ArgumentCondition, ArgumentEmission, ConditionOperator, TaskArgumentRule, ValidationKind,
        ValidationRule,
    },
    CREATE_NO_WINDOW,
};

const STATIC_HELPER: &str = include_str!("python_scan_helper.py");

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScanGroup {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) advanced: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelationshipCandidate {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) description: String,
    pub(crate) confidence: String,
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) from_fields: Vec<String>,
    #[serde(default)]
    pub(crate) to_fields: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScriptScanPreview {
    #[serde(default)]
    pub(crate) task_name: String,
    #[serde(default)]
    pub(crate) description: String,
    #[serde(default)]
    pub(crate) framework: String,
    #[serde(default)]
    pub(crate) source: String,
    #[serde(default)]
    pub(crate) confidence: String,
    #[serde(default)]
    pub(crate) groups: Vec<ScanGroup>,
    #[serde(default)]
    pub(crate) parameters: Vec<RuntimeParameterDefinition>,
    #[serde(default)]
    pub(crate) argument_rules: Vec<TaskArgumentRule>,
    #[serde(default)]
    pub(crate) validation_rules: Vec<ValidationRule>,
    #[serde(default)]
    pub(crate) relationship_candidates: Vec<RelationshipCandidate>,
    #[serde(default)]
    pub(crate) diagnostics: Vec<String>,
    #[serde(default)]
    pub(crate) script_hash: String,
    #[serde(default)]
    pub(crate) generated_arguments: Vec<String>,
    #[serde(default)]
    pub(crate) help_recommended: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScriptScanDiff {
    pub(crate) added: Vec<String>,
    pub(crate) removed: Vec<String>,
    pub(crate) type_changed: Vec<String>,
    pub(crate) default_changed: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScriptScanStatus {
    pub(crate) status: String,
    pub(crate) current_hash: Option<String>,
    pub(crate) diff: ScriptScanDiff,
    pub(crate) preview: Option<ScriptScanPreview>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RawScanResult {
    framework: String,
    name: String,
    description: String,
    #[serde(default)]
    parameters: Vec<RawScanParameter>,
    #[serde(default)]
    mutually_exclusive: Vec<Vec<String>>,
    #[serde(default)]
    diagnostics: Vec<String>,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct RawScanParameter {
    name: String,
    label: String,
    description: String,
    #[serde(rename = "type")]
    parameter_type: String,
    required: bool,
    default_value: String,
    #[serde(default)]
    options: Vec<String>,
    min: Option<f64>,
    max: Option<f64>,
    flag: Option<String>,
    position: bool,
    action: String,
    repeat: bool,
    group: String,
}

pub(crate) fn script_hash(path: &Path) -> anyhow::Result<String> {
    let bytes =
        std::fs::read(path).with_context(|| format!("读取脚本失败: {}", path.to_string_lossy()))?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("sha256:{:x}", hasher.finalize()))
}

async fn run_python_capture(
    interpreter: &str,
    args: &[String],
    timeout: Duration,
) -> anyhow::Result<(String, String, bool)> {
    let mut command = Command::new(interpreter);
    command
        .args(args)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.creation_flags(CREATE_NO_WINDOW);
    let child = command
        .spawn()
        .with_context(|| format!("启动扫描解释器失败: {interpreter}"))?;
    let tree = ProcessTree::attach(&child)?;
    match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(output) => {
            let output = output?;
            Ok((
                String::from_utf8_lossy(&output.stdout).into_owned(),
                String::from_utf8_lossy(&output.stderr).into_owned(),
                output.status.success(),
            ))
        }
        Err(_) => {
            tree.terminate()?;
            Err(anyhow!("脚本扫描超过 3 秒，已终止扫描进程树"))
        }
    }
}

async fn static_scan(interpreter: &str, script_path: &Path) -> anyhow::Result<RawScanResult> {
    let args = vec![
        "-X".to_string(),
        "utf8".to_string(),
        "-I".to_string(),
        "-S".to_string(),
        "-c".to_string(),
        STATIC_HELPER.to_string(),
        script_path.to_string_lossy().into_owned(),
    ];
    let (stdout, stderr, success) =
        run_python_capture(interpreter, &args, Duration::from_secs(3)).await?;
    if !success {
        return Err(anyhow!("静态 AST 扫描失败: {}", stderr.trim()));
    }
    serde_json::from_str(stdout.trim()).context("解析静态 AST 扫描结果失败")
}

async fn help_scan(interpreter: &str, script_path: &Path) -> anyhow::Result<Vec<RawScanParameter>> {
    let args = vec![
        "-u".to_string(),
        script_path.to_string_lossy().into_owned(),
        "--help".to_string(),
    ];
    let (stdout, stderr, _) =
        run_python_capture(interpreter, &args, Duration::from_secs(3)).await?;
    let text = if stdout.trim().is_empty() {
        stderr
    } else {
        stdout
    };
    Ok(parse_help_parameters(&text))
}

fn parse_help_parameters(text: &str) -> Vec<RawScanParameter> {
    let mut parameters = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('-') {
            continue;
        }
        let (signature, description) = trimmed
            .split_once("  ")
            .map(|(left, right)| (left.trim(), right.trim()))
            .unwrap_or((trimmed, ""));
        let flag = signature
            .split([',', ' '])
            .find(|part| part.starts_with("--"))
            .or_else(|| {
                signature
                    .split_whitespace()
                    .find(|part| part.starts_with('-'))
            });
        let Some(flag) = flag else {
            continue;
        };
        let name = flag.trim_start_matches('-').replace('-', "_");
        let has_value = signature
            .split_whitespace()
            .skip_while(|part| !part.contains(flag))
            .skip(1)
            .next()
            .is_some_and(|part| !part.starts_with('-'));
        parameters.push(RawScanParameter {
            name: name.clone(),
            label: human_label(&name),
            description: description.to_string(),
            parameter_type: if has_value { "text" } else { "boolean" }.to_string(),
            required: false,
            default_value: if has_value { "" } else { "false" }.to_string(),
            flag: Some(flag.to_string()),
            action: if has_value { "value" } else { "store_true" }.to_string(),
            ..RawScanParameter::default()
        });
    }
    parameters
}

fn human_label(name: &str) -> String {
    name.split('_')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn map_parameter_type(value: &str, name: &str, description: &str) -> RuntimeParameterType {
    let lower_name = name.to_ascii_lowercase();
    let lower_description = description.to_lowercase();
    if ["token", "cookie", "password", "secret", "authorization"]
        .iter()
        .any(|needle| lower_name.contains(needle))
    {
        return RuntimeParameterType::Secret;
    }
    match value {
        "number" => RuntimeParameterType::Number,
        "boolean" => RuntimeParameterType::Boolean,
        "choice" => RuntimeParameterType::Choice,
        "file" => {
            if ["output_dir", "output_root", "directory", "dir"]
                .iter()
                .any(|item| lower_name == *item || lower_name.ends_with(&format!("_{item}")))
                || ["directory", "folder", "目录"]
                    .iter()
                    .any(|hint| lower_description.contains(hint))
            {
                RuntimeParameterType::Directory
            } else {
                RuntimeParameterType::File
            }
        }
        "directory" => RuntimeParameterType::Directory,
        "secret" => RuntimeParameterType::Secret,
        _ => RuntimeParameterType::Text,
    }
}

fn convert_raw(raw: RawScanResult, source: &str, confidence: &str) -> ScriptScanPreview {
    let mut parameters = Vec::new();
    let mut argument_rules = Vec::new();
    let mut validation_rules = Vec::new();
    for item in raw.parameters {
        let mut parameter = default_parameter(&item.name);
        parameter.label = if item.label.trim().is_empty() {
            human_label(&item.name)
        } else {
            item.label
        };
        parameter.parameter_type =
            map_parameter_type(&item.parameter_type, &item.name, &item.description);
        parameter.description = item.description;
        parameter.required = item.required || item.position;
        parameter.default_value = if parameter.parameter_type == RuntimeParameterType::Secret {
            String::new()
        } else {
            item.default_value
        };
        parameter.options = item.options;
        parameter.min = item.min;
        parameter.max = item.max;
        parameter.group = if item.group.trim().is_empty() {
            "常用参数".to_string()
        } else {
            item.group
        };
        parameter.advanced = false;
        parameter.source = source.to_string();
        parameter.confidence = confidence.to_string();
        parameter.locked = false;
        parameter.allow_override = true;
        parameter.enabled = true;

        let emission = if item.repeat || item.action == "repeat" {
            ArgumentEmission::Repeat
        } else if item.action == "store_true" {
            ArgumentEmission::WhenTrue
        } else if item.action == "store_false" {
            ArgumentEmission::WhenFalse
        } else if parameter.required || item.position {
            ArgumentEmission::Always
        } else {
            ArgumentEmission::WhenNonEmpty
        };
        argument_rules.push(TaskArgumentRule {
            id: item.name.clone(),
            input_name: item.name.clone(),
            flag: item.flag,
            emission,
            value_template: if matches!(parameter.parameter_type, RuntimeParameterType::Boolean) {
                String::new()
            } else {
                format!("{{{{{}}}}}", item.name)
            },
            condition: None,
            enabled: true,
        });
        if parameter.parameter_type == RuntimeParameterType::Choice {
            validation_rules.push(ValidationRule {
                kind: ValidationKind::Enum,
                fields: vec![parameter.name.clone()],
                options: parameter.options.clone(),
                ..empty_validation_rule()
            });
        }
        parameters.push(parameter);
    }
    for fields in raw.mutually_exclusive {
        validation_rules.push(ValidationRule {
            kind: ValidationKind::MutuallyExclusive,
            fields,
            message: "这些参数只能选择一个".to_string(),
            ..empty_validation_rule()
        });
    }
    ScriptScanPreview {
        task_name: raw.name,
        description: raw.description,
        framework: raw.framework,
        source: source.to_string(),
        confidence: confidence.to_string(),
        parameters,
        argument_rules,
        validation_rules,
        diagnostics: raw.diagnostics,
        ..ScriptScanPreview::default()
    }
}

fn empty_validation_rule() -> ValidationRule {
    ValidationRule {
        kind: ValidationKind::AtLeastOne,
        fields: Vec::new(),
        condition: None,
        min: None,
        max: None,
        options: Vec::new(),
        message: String::new(),
    }
}

fn template_flag_values(template: &str) -> HashMap<String, Option<String>> {
    let Ok(tokens) = tokenize_command_line(template) else {
        return HashMap::new();
    };
    let mut result = HashMap::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if token.starts_with('-') {
            let value = tokens
                .get(index + 1)
                .filter(|next| !next.starts_with('-'))
                .cloned();
            result.insert(token.clone(), value.clone());
            index += if value.is_some() { 2 } else { 1 };
        } else {
            index += 1;
        }
    }
    result
}

fn ensure_parameter(preview: &mut ScriptScanPreview, name: &str, source: &str) -> usize {
    if let Some(index) = preview
        .parameters
        .iter()
        .position(|parameter| parameter.name == name)
    {
        return index;
    }
    let mut parameter = default_parameter(name);
    parameter.label = human_label(name);
    parameter.source = source.to_string();
    parameter.confidence = "medium".to_string();
    parameter.required = true;
    preview.parameters.push(parameter);
    preview.parameters.len() - 1
}

fn apply_template(preview: &mut ScriptScanPreview, template: &str) {
    let fixed = template_flag_values(template);
    for rule in &mut preview.argument_rules {
        let Some(flag) = rule.flag.as_ref() else {
            continue;
        };
        let Some(value) = fixed.get(flag) else {
            continue;
        };
        if let Some(value) = value {
            let variables = extract_runtime_variables(value).unwrap_or_default();
            if variables.is_empty() {
                if let Some(parameter) = preview
                    .parameters
                    .iter_mut()
                    .find(|parameter| parameter.name == rule.input_name)
                {
                    parameter.default_value = value.clone();
                }
            } else if variables.len() == 1 {
                rule.input_name = variables[0].clone();
                rule.value_template = value.clone();
                preview.relationship_candidates.push(RelationshipCandidate {
                    id: format!("template-{}", rule.id),
                    label: format!("{} 派生 {}", variables[0], rule.id),
                    description: format!("模板值 {value} 使用了运行输入 {}", variables[0]),
                    confidence: "high".to_string(),
                    enabled: true,
                    from_fields: variables.clone(),
                    to_fields: vec![rule.id.clone()],
                });
            }
        } else if let Some(parameter) = preview
            .parameters
            .iter_mut()
            .find(|parameter| parameter.name == rule.input_name)
        {
            if parameter.parameter_type == RuntimeParameterType::Boolean {
                parameter.default_value = match rule.emission {
                    ArgumentEmission::WhenFalse => "false".to_string(),
                    _ => "true".to_string(),
                };
            }
        }
    }
    let variables = extract_runtime_variables(template).unwrap_or_default();
    for variable in variables {
        ensure_parameter(preview, &variable, "template");
    }
}

fn set_condition(field: &str, value: &str) -> Option<ArgumentCondition> {
    Some(ArgumentCondition {
        field: field.to_string(),
        operator: ConditionOperator::Equals,
        value: Some(value.to_string()),
    })
}

fn validation_required(field: &str, mode: &str, message: &str) -> ValidationRule {
    ValidationRule {
        kind: ValidationKind::ConditionalRequired,
        fields: vec![field.to_string()],
        condition: set_condition("source_mode", mode),
        message: message.to_string(),
        ..empty_validation_rule()
    }
}

fn specialize_comicbox(preview: &mut ScriptScanPreview, script_path: &Path, template: &str) {
    if !script_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .contains("comicbox")
    {
        return;
    }
    let names = preview
        .parameters
        .iter()
        .map(|parameter| parameter.name.as_str())
        .collect::<HashSet<_>>();
    if !(names.contains("book_url") && names.contains("output") && names.contains("chapters")) {
        return;
    }
    ensure_parameter(preview, "book_id", "derived");
    if let Some(book_id) = preview
        .parameters
        .iter_mut()
        .find(|item| item.name == "book_id")
    {
        book_id.label = "漫画 ID".to_string();
        book_id.description = "输入 ComicBox 漫画编号".to_string();
        book_id.parameter_type = RuntimeParameterType::Text;
        book_id.group = "常用参数".to_string();
        book_id.required = true;
        book_id.source = "derived".to_string();
        book_id.confidence = "high".to_string();
    }
    if let Some(book_url) = preview
        .parameters
        .iter_mut()
        .find(|item| item.name == "book_url")
    {
        book_url.label = "漫画地址".to_string();
        book_url.description = "根据漫画 ID 自动生成".to_string();
        book_url.derived_template = Some("https://www.comicbox.xyz/book/{{book_id}}".to_string());
        book_url.allow_override = false;
        book_url.group = "常用参数".to_string();
    }
    let template_values = template_flag_values(template);
    let output_template = template_values
        .get("--output")
        .and_then(Clone::clone)
        .filter(|value| value.contains("{{book_id}}"))
        .unwrap_or_else(|| {
            let parent = script_path.parent().unwrap_or_else(|| Path::new("."));
            parent
                .join("comicbox_{{book_id}}_backup")
                .to_string_lossy()
                .into_owned()
        });
    if let Some(output) = preview
        .parameters
        .iter_mut()
        .find(|item| item.name == "output")
    {
        output.label = "输出目录".to_string();
        output.parameter_type = RuntimeParameterType::Directory;
        output.derived_template = Some(output_template);
        output.allow_override = true;
        output.description = "根据漫画 ID 自动生成，也可以选择其他目录".to_string();
        output.group = "常用参数".to_string();
    }
    if let Some(chapters) = preview
        .parameters
        .iter_mut()
        .find(|item| item.name == "chapters")
    {
        chapters.label = "章节范围".to_string();
        chapters.description = "留空下载全部章节，例如 77-117".to_string();
        chapters.required = false;
        chapters.group = "常用参数".to_string();
        chapters.default_value = template_values
            .get("--chapters")
            .and_then(Clone::clone)
            .filter(|value| !value.contains("{{"))
            .unwrap_or_default();
    }
    if let Some(limit) = preview
        .parameters
        .iter_mut()
        .find(|item| item.name == "limit")
    {
        limit.label = "最多处理章节数".to_string();
        limit.description = "留空表示不限制".to_string();
        limit.required = false;
        limit.group = "常用参数".to_string();
        limit.advanced = false;
    }
    for rule in &mut preview.argument_rules {
        if rule.id == "book_url" {
            rule.input_name = "book_url".to_string();
            rule.value_template = "{{book_url}}".to_string();
        } else if rule.id == "output" {
            rule.input_name = "output".to_string();
            rule.value_template = "{{output}}".to_string();
        } else if rule.id == "chapters" {
            rule.emission = ArgumentEmission::WhenNonEmpty;
        }
    }
    if let Some(index) = preview
        .parameters
        .iter()
        .position(|item| item.name == "quiet_pages")
    {
        let mut page_output = preview.parameters.remove(index);
        page_output.name = "page_output".to_string();
        page_output.label = "逐页输出".to_string();
        page_output.default_value = if template_values.contains_key("--quiet-pages") {
            "false"
        } else {
            "true"
        }
        .to_string();
        page_output.advanced = true;
        page_output.group = "高级设置".to_string();
        preview.parameters.push(page_output);
        if let Some(rule) = preview
            .argument_rules
            .iter_mut()
            .find(|rule| rule.id == "quiet_pages")
        {
            rule.input_name = "page_output".to_string();
            rule.emission = ArgumentEmission::WhenFalse;
            rule.value_template.clear();
        }
    }
    let has_no_proxy = preview
        .parameters
        .iter()
        .any(|item| item.name == "no_proxy");
    let has_proxy = preview.parameters.iter().any(|item| item.name == "proxy");
    if has_no_proxy && has_proxy {
        ensure_parameter(preview, "proxy_mode", "derived");
        if let Some(mode) = preview
            .parameters
            .iter_mut()
            .find(|item| item.name == "proxy_mode")
        {
            mode.label = "代理模式".to_string();
            mode.parameter_type = RuntimeParameterType::Choice;
            mode.options = vec![
                "system".to_string(),
                "direct".to_string(),
                "proxy".to_string(),
            ];
            mode.default_value = if template_values.contains_key("--no-proxy") {
                "direct"
            } else if template_values.contains_key("--proxy") {
                "proxy"
            } else {
                "system"
            }
            .to_string();
            mode.advanced = true;
            mode.group = "高级设置".to_string();
        }
        if let Some(no_proxy) = preview
            .parameters
            .iter_mut()
            .find(|item| item.name == "no_proxy")
        {
            no_proxy.enabled = false;
        }
        if let Some(proxy) = preview
            .parameters
            .iter_mut()
            .find(|item| item.name == "proxy")
        {
            proxy.condition = set_condition("proxy_mode", "proxy");
        }
        if let Some(rule) = preview
            .argument_rules
            .iter_mut()
            .find(|item| item.id == "no_proxy")
        {
            rule.input_name = "proxy_mode".to_string();
            rule.emission = ArgumentEmission::Always;
            rule.condition = set_condition("proxy_mode", "direct");
            rule.value_template.clear();
        }
        if let Some(rule) = preview
            .argument_rules
            .iter_mut()
            .find(|item| item.id == "proxy")
        {
            rule.condition = set_condition("proxy_mode", "proxy");
        }
    }
    for parameter in &mut preview.parameters {
        match parameter.name.as_str() {
            "delay" => parameter.label = "请求间隔（秒）".to_string(),
            "workers" => parameter.label = "并发下载数".to_string(),
            "http_pool_size" => parameter.label = "HTTP 连接池大小".to_string(),
            "proxy" => parameter.label = "指定代理".to_string(),
            "image_quality" => parameter.label = "图片质量".to_string(),
            "image_optimize" => parameter.label = "图片优化".to_string(),
            "pdf_backend" => parameter.label = "PDF 生成后端".to_string(),
            "force_pdf" => parameter.label = "强制重新生成 PDF".to_string(),
            "fail_missing" => parameter.label = "缺页时终止".to_string(),
            _ => {}
        }
        if !matches!(
            parameter.name.as_str(),
            "book_id" | "book_url" | "output" | "chapters" | "limit"
        ) {
            parameter.advanced = true;
            parameter.group = "高级设置".to_string();
        }
    }
    preview.relationship_candidates.retain(|candidate| {
        !candidate
            .to_fields
            .iter()
            .any(|field| matches!(field.as_str(), "book_url" | "output"))
    });
    preview.relationship_candidates.push(RelationshipCandidate {
        id: "comicbox-book-id".to_string(),
        label: "漫画 ID 派生 URL 与输出目录".to_string(),
        description: "一个漫画 ID 同步生成 --book-url 和默认输出目录".to_string(),
        confidence: "high".to_string(),
        enabled: true,
        from_fields: vec!["book_id".to_string()],
        to_fields: vec!["book_url".to_string(), "output".to_string()],
    });
    let order = ["book_id", "book_url", "output", "chapters", "limit"];
    preview.parameters.sort_by_key(|parameter| {
        order
            .iter()
            .position(|name| *name == parameter.name.as_str())
            .unwrap_or(order.len() + usize::from(parameter.advanced))
    });
}

fn rename_inverse_boolean(
    preview: &mut ScriptScanPreview,
    old_name: &str,
    new_name: &str,
    label: &str,
) {
    if let Some(parameter) = preview
        .parameters
        .iter_mut()
        .find(|item| item.name == old_name)
    {
        parameter.name = new_name.to_string();
        parameter.label = label.to_string();
        parameter.parameter_type = RuntimeParameterType::Boolean;
        parameter.default_value = if parameter.default_value == "true" {
            "false"
        } else {
            "true"
        }
        .to_string();
    }
    if let Some(rule) = preview
        .argument_rules
        .iter_mut()
        .find(|item| item.id == old_name)
    {
        rule.input_name = new_name.to_string();
        rule.emission = ArgumentEmission::WhenFalse;
        rule.value_template.clear();
    }
}

fn specialize_video(preview: &mut ScriptScanPreview, script_path: &Path) {
    let names = preview
        .parameters
        .iter()
        .map(|parameter| parameter.name.as_str())
        .collect::<HashSet<_>>();
    if !(names.contains("watch_url") && names.contains("input_html") && names.contains("video_id"))
    {
        return;
    }
    ensure_parameter(preview, "source_mode", "derived");
    if let Some(mode) = preview
        .parameters
        .iter_mut()
        .find(|item| item.name == "source_mode")
    {
        mode.label = "来源模式".to_string();
        mode.parameter_type = RuntimeParameterType::Choice;
        mode.default_value = "id".to_string();
        mode.options = vec!["id".to_string(), "url".to_string(), "html".to_string()];
        mode.required = true;
        mode.group = "常用参数".to_string();
        mode.confidence = "high".to_string();
    }
    for parameter in &mut preview.parameters {
        match parameter.name.as_str() {
            "video_id" => {
                parameter.label = "视频 ID".to_string();
                parameter.description = "ID 模式直接填写；URL 模式会从地址中提取".to_string();
                parameter.parameter_type = RuntimeParameterType::Text;
                parameter.group = "常用参数".to_string();
                parameter.required = false;
                parameter.condition = Some(ArgumentCondition {
                    field: "source_mode".to_string(),
                    operator: ConditionOperator::NotEquals,
                    value: Some("url".to_string()),
                });
            }
            "watch_url" => {
                parameter.label = "播放页地址".to_string();
                parameter.description = "粘贴完整播放页地址后自动提取视频 ID".to_string();
                parameter.group = "常用参数".to_string();
                parameter.required = false;
                parameter.condition = set_condition("source_mode", "url");
            }
            "input_html" => {
                parameter.label = "本地 HTML 文件".to_string();
                parameter.parameter_type = RuntimeParameterType::File;
                parameter.group = "常用参数".to_string();
                parameter.required = false;
                parameter.condition = set_condition("source_mode", "html");
            }
            "cookie_header" => {
                parameter.label = "Cookie Header".to_string();
                parameter.description = "仅用于本次运行，不写入历史和命令预览".to_string();
                parameter.parameter_type = RuntimeParameterType::Secret;
                parameter.default_value.clear();
            }
            "output_root" => {
                parameter.label = "输出根目录".to_string();
                parameter.description = "每个视频会在此目录下建立独立文件夹".to_string();
                parameter.parameter_type = RuntimeParameterType::Directory;
                parameter.group = "常用参数".to_string();
                parameter.advanced = false;
                if parameter.default_value.is_empty() {
                    parameter.default_value = script_path
                        .parent()
                        .unwrap_or_else(|| Path::new("."))
                        .parent()
                        .unwrap_or_else(|| script_path.parent().unwrap_or_else(|| Path::new(".")))
                        .join("runs")
                        .to_string_lossy()
                        .into_owned();
                }
            }
            "timeout" => {
                parameter.label = "HTTP 超时（秒）".to_string();
                parameter.parameter_type = RuntimeParameterType::Number;
                if parameter.default_value.is_empty() {
                    parameter.default_value = "30".to_string();
                }
            }
            _ => {}
        }
    }
    preview
        .argument_rules
        .retain(|rule| !matches!(rule.id.as_str(), "watch_url" | "input_html" | "video_id"));
    preview.argument_rules.splice(
        0..0,
        [
            TaskArgumentRule {
                id: "watch-url-from-id".to_string(),
                input_name: "video_id".to_string(),
                flag: Some("--watch-url".to_string()),
                emission: ArgumentEmission::Always,
                value_template: "https://hanime1.me/watch?v={{video_id}}".to_string(),
                condition: set_condition("source_mode", "id"),
                enabled: true,
            },
            TaskArgumentRule {
                id: "watch-url".to_string(),
                input_name: "watch_url".to_string(),
                flag: Some("--watch-url".to_string()),
                emission: ArgumentEmission::WhenNonEmpty,
                value_template: "{{watch_url}}".to_string(),
                condition: set_condition("source_mode", "url"),
                enabled: true,
            },
            TaskArgumentRule {
                id: "input-html".to_string(),
                input_name: "input_html".to_string(),
                flag: Some("--input-html".to_string()),
                emission: ArgumentEmission::WhenNonEmpty,
                value_template: "{{input_html}}".to_string(),
                condition: set_condition("source_mode", "html"),
                enabled: true,
            },
            TaskArgumentRule {
                id: "video-id".to_string(),
                input_name: "video_id".to_string(),
                flag: Some("--video-id".to_string()),
                emission: ArgumentEmission::WhenNonEmpty,
                value_template: "{{video_id}}".to_string(),
                condition: None,
                enabled: true,
            },
        ],
    );
    preview.validation_rules.extend([
        validation_required("video_id", "id", "ID 模式需要填写视频 ID"),
        validation_required("watch_url", "url", "URL 模式需要填写播放页 URL"),
        validation_required("input_html", "html", "HTML 模式需要选择本地文件"),
    ]);

    ensure_parameter(preview, "generated_watch_url", "derived");
    if let Some(generated_url) = preview
        .parameters
        .iter_mut()
        .find(|item| item.name == "generated_watch_url")
    {
        generated_url.label = "自动生成的播放页地址".to_string();
        generated_url.description = "根据视频 ID 自动生成，仅用于预览".to_string();
        generated_url.parameter_type = RuntimeParameterType::Text;
        generated_url.derived_template = Some("https://hanime1.me/watch?v={{video_id}}".to_string());
        generated_url.allow_override = false;
        generated_url.required = false;
        generated_url.condition = set_condition("source_mode", "id");
        generated_url.group = "常用参数".to_string();
        generated_url.advanced = false;
    }

    ensure_parameter(preview, "run_output", "derived");
    if let Some(output) = preview
        .parameters
        .iter_mut()
        .find(|item| item.name == "run_output")
    {
        output.label = "本次输出目录".to_string();
        output.description = "由输出根目录和视频 ID 生成，仅用于预览".to_string();
        output.parameter_type = RuntimeParameterType::Directory;
        output.derived_template = Some("{{output_root}}\\{{video_id}}".to_string());
        output.allow_override = false;
        output.required = false;
        output.group = "常用参数".to_string();
        output.advanced = false;
    }

    let has_direct = preview.parameters.iter().any(|item| item.name == "direct");
    let has_proxy = preview.parameters.iter().any(|item| item.name == "proxy");
    if has_direct && has_proxy {
        ensure_parameter(preview, "network_mode", "derived");
        if let Some(mode) = preview
            .parameters
            .iter_mut()
            .find(|item| item.name == "network_mode")
        {
            mode.label = "网络模式".to_string();
            mode.parameter_type = RuntimeParameterType::Choice;
            mode.options = vec![
                "system".to_string(),
                "direct".to_string(),
                "proxy".to_string(),
            ];
            mode.default_value = "system".to_string();
            mode.group = "高级设置".to_string();
            mode.advanced = true;
        }
        if let Some(direct) = preview
            .parameters
            .iter_mut()
            .find(|item| item.name == "direct")
        {
            direct.enabled = false;
        }
        if let Some(proxy) = preview
            .parameters
            .iter_mut()
            .find(|item| item.name == "proxy")
        {
            proxy.condition = set_condition("network_mode", "proxy");
        }
        if let Some(rule) = preview
            .argument_rules
            .iter_mut()
            .find(|item| item.id == "direct")
        {
            rule.input_name = "network_mode".to_string();
            rule.emission = ArgumentEmission::Always;
            rule.condition = set_condition("network_mode", "direct");
            rule.value_template.clear();
        }
        if let Some(rule) = preview
            .argument_rules
            .iter_mut()
            .find(|item| item.id == "proxy")
        {
            rule.condition = set_condition("network_mode", "proxy");
        }
    }
    rename_inverse_boolean(
        preview,
        "no_backup",
        "download_backup",
        "下载最高分辨率 MP4",
    );
    rename_inverse_boolean(
        preview,
        "no_browser_fallback",
        "browser_fallback",
        "浏览器解析回退",
    );
    for parameter in &mut preview.parameters {
        if parameter.name == "proxy" {
            parameter.label = "指定代理".to_string();
        }
        if !matches!(
            parameter.name.as_str(),
            "source_mode" | "video_id" | "generated_watch_url" | "watch_url" | "input_html" | "output_root" | "run_output"
        ) {
            parameter.advanced = true;
            parameter.group = "高级设置".to_string();
        }
    }
    preview.relationship_candidates.push(RelationshipCandidate {
        id: "video-source-mode".to_string(),
        label: "视频来源模式联动".to_string(),
        description: "ID 生成播放页 URL；URL 可回填 ID；HTML 使用文件选择器".to_string(),
        confidence: "high".to_string(),
        enabled: true,
        from_fields: vec!["source_mode".to_string(), "video_id".to_string()],
        to_fields: vec![
            "generated_watch_url".to_string(),
            "watch_url".to_string(),
            "input_html".to_string(),
        ],
    });
    preview.relationship_candidates.push(RelationshipCandidate {
        id: "video-output-directory".to_string(),
        label: "视频 ID 派生输出目录".to_string(),
        description: "预览 {output_root}\\{video_id}，输出根目录仍可调整".to_string(),
        confidence: "high".to_string(),
        enabled: true,
        from_fields: vec!["output_root".to_string(), "video_id".to_string()],
        to_fields: vec!["run_output".to_string()],
    });
    let order = [
        "source_mode",
        "video_id",
        "generated_watch_url",
        "watch_url",
        "input_html",
        "output_root",
        "run_output",
    ];
    preview.parameters.sort_by_key(|parameter| {
        order
            .iter()
            .position(|name| *name == parameter.name.as_str())
            .unwrap_or(order.len() + usize::from(parameter.advanced))
    });
}

fn rebuild_groups(preview: &mut ScriptScanPreview) {
    let mut labels = Vec::new();
    for parameter in &preview.parameters {
        if parameter.enabled && !labels.iter().any(|label| label == &parameter.group) {
            labels.push(parameter.group.clone());
        }
    }
    preview.groups = labels
        .into_iter()
        .map(|label| ScanGroup {
            id: label.to_ascii_lowercase().replace(' ', "-"),
            advanced: label == "高级设置"
                || preview
                    .parameters
                    .iter()
                    .filter(|item| item.group == label)
                    .all(|item| item.advanced),
            label,
        })
        .collect();
}

fn generated_arguments(preview: &ScriptScanPreview) -> Vec<String> {
    let values = preview
        .parameters
        .iter()
        .map(|parameter| {
            let value = if parameter.default_value.is_empty() {
                format!("<{}>", parameter.name)
            } else {
                parameter.default_value.clone()
            };
            (parameter.name.clone(), value)
        })
        .collect::<HashMap<_, _>>();
    crate::structured_arguments::build_structured_arguments(&preview.argument_rules, &values)
        .unwrap_or_default()
}

fn fallback_from_template(script_path: &Path, template: &str) -> ScriptScanPreview {
    let mut preview = ScriptScanPreview {
        task_name: script_path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("Python Task")
            .replace('_', " "),
        framework: "template".to_string(),
        source: "template".to_string(),
        confidence: "low".to_string(),
        diagnostics: vec!["使用参数模板占位符生成结构化控件，请在预览中确认。".to_string()],
        help_recommended: true,
        ..ScriptScanPreview::default()
    };
    let tokens = tokenize_command_line(template).unwrap_or_default();
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        let next = tokens.get(index + 1);
        if token.starts_with('-') {
            if let Some(value) = next.filter(|value| !value.starts_with('-')) {
                let variables = extract_runtime_variables(value).unwrap_or_default();
                let input = variables
                    .first()
                    .cloned()
                    .unwrap_or_else(|| token.trim_start_matches('-').replace('-', "_"));
                ensure_parameter(&mut preview, &input, "template");
                preview.argument_rules.push(TaskArgumentRule {
                    id: token.trim_start_matches('-').replace('-', "_"),
                    input_name: input,
                    flag: Some(token.clone()),
                    emission: if value.trim().is_empty() {
                        ArgumentEmission::WhenNonEmpty
                    } else {
                        ArgumentEmission::Always
                    },
                    value_template: value.clone(),
                    condition: None,
                    enabled: true,
                });
                index += 2;
            } else {
                index += 1;
            }
        } else {
            let variables = extract_runtime_variables(token).unwrap_or_default();
            if let Some(input) = variables.first() {
                ensure_parameter(&mut preview, input, "template");
                preview.argument_rules.push(TaskArgumentRule {
                    id: format!("position-{}", preview.argument_rules.len()),
                    input_name: input.clone(),
                    flag: None,
                    emission: ArgumentEmission::Always,
                    value_template: token.clone(),
                    condition: None,
                    enabled: true,
                });
            }
            index += 1;
        }
    }
    preview
}

fn sidecar_path(script_path: &Path) -> PathBuf {
    let stem = script_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    script_path.with_file_name(format!("{stem}.workbench.json"))
}

fn load_sidecar(script_path: &Path) -> anyhow::Result<Option<ScriptScanPreview>> {
    let path = sidecar_path(script_path);
    if !path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("读取 sidecar manifest 失败: {}", path.to_string_lossy()))?;
    let mut preview: ScriptScanPreview =
        serde_json::from_str(&text).context("解析 sidecar manifest 失败")?;
    preview.source = "sidecar".to_string();
    preview.confidence = "high".to_string();
    for parameter in &mut preview.parameters {
        parameter.source = "sidecar".to_string();
        parameter.confidence = "high".to_string();
    }
    Ok(Some(preview))
}

pub(crate) async fn scan_python_script_impl(
    interpreter: &str,
    script_path: &Path,
    args_template: &str,
    allow_help: bool,
) -> anyhow::Result<ScriptScanPreview> {
    if !script_path.is_file() {
        return Err(anyhow!("脚本文件不存在: {}", script_path.to_string_lossy()));
    }
    let hash = script_hash(script_path)?;
    let mut preview = if let Some(sidecar) = load_sidecar(script_path)? {
        sidecar
    } else {
        match static_scan(interpreter, script_path).await {
            Ok(raw) => convert_raw(raw, "ast", "high"),
            Err(error) => {
                let mut fallback = fallback_from_template(script_path, args_template);
                fallback.diagnostics.insert(0, error.to_string());
                fallback
            }
        }
    };
    if preview.source != "sidecar" {
        apply_template(&mut preview, args_template);
        if allow_help {
            match help_scan(interpreter, script_path).await {
                Ok(help_parameters) => {
                    let existing = preview
                        .parameters
                        .iter()
                        .map(|parameter| parameter.name.clone())
                        .collect::<HashSet<_>>();
                    let missing = help_parameters
                        .into_iter()
                        .filter(|parameter| !existing.contains(&parameter.name))
                        .collect::<Vec<_>>();
                    if !missing.is_empty() {
                        let help_preview = convert_raw(
                            RawScanResult {
                                framework: "help".to_string(),
                                parameters: missing,
                                ..RawScanResult::default()
                            },
                            "help",
                            "medium",
                        );
                        preview.parameters.extend(help_preview.parameters);
                        preview.argument_rules.extend(help_preview.argument_rules);
                    }
                    preview
                        .diagnostics
                        .push("已使用 --help 补扫，补扫进程已在 3 秒内退出。".to_string());
                }
                Err(error) => preview
                    .diagnostics
                    .push(format!("--help 补扫失败: {error}")),
            }
        }
        specialize_comicbox(&mut preview, script_path, args_template);
        specialize_video(&mut preview, script_path);
    }
    preview.help_recommended = preview.source != "sidecar"
        && (preview.parameters.is_empty()
            || preview.framework == "unknown"
            || preview.confidence != "high");
    preview.script_hash = hash;
    rebuild_groups(&mut preview);
    preview.generated_arguments = generated_arguments(&preview);
    Ok(preview)
}

pub(crate) fn compare_scan_snapshots(
    old_snapshot: Option<&serde_json::Value>,
    new_preview: &ScriptScanPreview,
) -> ScriptScanDiff {
    let old_parameters = old_snapshot
        .and_then(|snapshot| snapshot.get("parameters"))
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let old = old_parameters
        .into_iter()
        .filter_map(|value| {
            let name = value.get("name")?.as_str()?.to_string();
            Some((name, value))
        })
        .collect::<HashMap<_, _>>();
    let new = new_preview
        .parameters
        .iter()
        .map(|parameter| (parameter.name.clone(), parameter))
        .collect::<HashMap<_, _>>();
    let mut diff = ScriptScanDiff::default();
    for (name, parameter) in &new {
        let Some(previous) = old.get(name) else {
            diff.added.push(name.clone());
            continue;
        };
        let old_type = previous.get("type").and_then(serde_json::Value::as_str);
        if old_type != Some(parameter.parameter_type.as_str()) {
            diff.type_changed.push(name.clone());
        }
        let old_default = previous
            .get("defaultValue")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if old_default != parameter.default_value {
            diff.default_changed.push(name.clone());
        }
    }
    for name in old.keys() {
        if !new.contains_key(name) {
            diff.removed.push(name.clone());
        }
    }
    diff.added.sort();
    diff.removed.sort();
    diff.type_changed.sort();
    diff.default_changed.sort();
    diff
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("fixtures")
            .join(name)
    }

    fn test_python() -> String {
        if let Ok(path) = std::env::var("SCRIPT_WORKBENCH_TEST_PYTHON") {
            return path;
        }
        let common = Path::new(r"D:\python\Python311\python.exe");
        if common.is_file() {
            return common.to_string_lossy().into_owned();
        }
        "python".to_string()
    }

    #[tokio::test]
    async fn scans_argparse_without_importing_the_target_module() {
        let interpreter = test_python();
        let preview = scan_python_script_impl(
            &interpreter,
            &fixture("scanner_argparse.py"),
            "--chapters 77-117 --quiet-pages",
            false,
        )
        .await
        .unwrap();

        assert_eq!(preview.framework, "argparse");
        assert!(preview.parameters.iter().any(|parameter| {
            parameter.name == "chapters" && parameter.default_value == "77-117"
        }));
        assert!(preview.validation_rules.iter().any(|rule| {
            rule.kind == ValidationKind::MutuallyExclusive && rule.fields == vec!["direct", "proxy"]
        }));
    }

    #[test]
    fn distinguishes_output_files_from_output_directories() {
        assert_eq!(
            map_parameter_type("file", "output", "输出 PDF 路径"),
            RuntimeParameterType::File
        );
        assert_eq!(
            map_parameter_type("file", "output", "Backup directory"),
            RuntimeParameterType::Directory
        );
    }

    #[tokio::test]
    async fn scans_click_typer_and_sidecar_sources() {
        let interpreter = test_python();
        let click = scan_python_script_impl(&interpreter, &fixture("scanner_click.py"), "", false)
            .await
            .unwrap();
        assert!(click.parameters.iter().any(|parameter| {
            parameter.name == "token" && parameter.parameter_type == RuntimeParameterType::Secret
        }));

        let typer = scan_python_script_impl(&interpreter, &fixture("scanner_typer.py"), "", false)
            .await
            .unwrap();
        assert!(typer.parameters.iter().any(|parameter| {
            parameter.name == "timeout"
                && parameter.parameter_type == RuntimeParameterType::Number
                && parameter.default_value == "30"
        }));

        let sidecar = scan_python_script_impl(&interpreter, &fixture("scanner_sidecar.py"), "", false)
            .await
            .unwrap();
        assert_eq!(sidecar.source, "sidecar");
        assert_eq!(sidecar.parameters[0].name, "serial");
    }

    #[tokio::test]
    async fn confirmed_help_scan_supplements_static_results() {
        let interpreter = test_python();
        let preview = scan_python_script_impl(&interpreter, &fixture("scanner_help.py"), "", true)
            .await
            .unwrap();
        assert!(preview
            .parameters
            .iter()
            .any(|parameter| parameter.name == "from_help"));
        assert!(preview
            .parameters
            .iter()
            .any(|parameter| parameter.name == "switch"));
    }

    #[tokio::test]
    async fn scanner_fixtures_match_their_golden_parameter_types() {
        let interpreter = test_python();
        for (fixture_name, allow_help) in [
            ("scanner_argparse.py", false),
            ("scanner_click.py", false),
            ("scanner_typer.py", false),
            ("scanner_help.py", true),
            ("scanner_sidecar.py", false),
        ] {
            let preview = scan_python_script_impl(&interpreter, &fixture(fixture_name), "", allow_help)
                .await
                .unwrap();
            let golden_path = fixture(&fixture_name.replace(".py", ".golden.json"));
            let golden: serde_json::Value =
                serde_json::from_str(&std::fs::read_to_string(golden_path).unwrap()).unwrap();
            assert_eq!(preview.framework, golden["framework"].as_str().unwrap());
            assert_eq!(preview.source, golden["source"].as_str().unwrap());
            for (name, parameter_type) in golden["parameters"].as_object().unwrap() {
                let parameter = preview
                    .parameters
                    .iter()
                    .find(|parameter| &parameter.name == name)
                    .unwrap_or_else(|| panic!("{fixture_name} missing {name}"));
                assert_eq!(
                    parameter.parameter_type.as_str(),
                    parameter_type.as_str().unwrap(),
                    "{fixture_name} type mismatch for {name}"
                );
            }
        }
    }

    #[tokio::test]
    async fn comicbox_fixture_derives_url_and_output_and_can_omit_chapters() {
        let interpreter = test_python();
        let preview = scan_python_script_impl(
            &interpreter,
            &fixture("backup_comicbox_fixture.py"),
            "--book-url https://www.comicbox.xyz/book/{{book_id}} --output F:\\CIL\\comicbox_{{book_id}}_backup --chapters 77-117 --delay 0 --workers 12 --quiet-pages",
            false,
        )
        .await
        .unwrap();
        let variables = preview
            .parameters
            .iter()
            .map(|parameter| parameter.name.clone())
            .collect::<Vec<_>>();
        let provided = HashMap::from([
            ("book_id".to_string(), "5101".to_string()),
            ("chapters".to_string(), String::new()),
        ]);
        let resolved = crate::runtime_parameters::resolve_runtime_values(
            &variables,
            &preview.parameters,
            &provided,
        )
        .unwrap();
        let argv = crate::structured_arguments::build_structured_arguments(
            &preview.argument_rules,
            &resolved.actual,
        )
        .unwrap();

        assert!(argv
            .windows(2)
            .any(|pair| { pair == ["--book-url", "https://www.comicbox.xyz/book/5101"] }));
        assert!(argv
            .windows(2)
            .any(|pair| { pair == ["--output", "F:\\CIL\\comicbox_5101_backup"] }));
        assert!(!argv.iter().any(|argument| argument == "--chapters"));
        assert!(preview.parameters.iter().any(|parameter| {
            parameter.name == "page_output" && parameter.default_value == "false"
        }));
        assert!(preview.parameters.iter().any(|parameter| {
            parameter.name == "book_id"
                && parameter.label == "漫画 ID"
                && parameter.parameter_type == RuntimeParameterType::Text
        }));
        assert!(preview.parameters.iter().any(|parameter| {
            parameter.name == "book_url"
                && parameter.label == "漫画地址"
                && !parameter.allow_override
        }));
        assert!(preview.parameters.iter().any(|parameter| {
            parameter.name == "limit"
                && parameter.label == "最多处理章节数"
                && parameter.group == "常用参数"
                && !parameter.advanced
        }));
        assert!(preview.parameters.iter().any(|parameter| {
            parameter.name == "chapters" && parameter.description.contains("留空下载全部章节")
        }));
        assert!(preview.parameters.iter().any(|parameter| {
            parameter.name == "http_pool_size" && parameter.description == "HTTP 连接池大小"
        }));
    }

    #[tokio::test]
    async fn video_fixture_builds_three_source_modes_and_inverse_flags() {
        let interpreter = test_python();
        let preview = scan_python_script_impl(
            &interpreter,
            &fixture("summarize_video_sources_fixture.py"),
            "--watch-url https://hanime1.me/watch?v={{video_id}} --video-id {{video_id}}",
            false,
        )
        .await
        .unwrap();
        assert!(preview.parameters.iter().any(|parameter| {
            parameter.name == "source_mode" && parameter.options == vec!["id", "url", "html"]
        }));
        assert!(preview.parameters.iter().any(|parameter| {
            parameter.name == "cookie_header"
                && parameter.parameter_type == RuntimeParameterType::Secret
        }));
        assert!(preview.argument_rules.iter().any(|rule| {
            rule.input_name == "download_backup"
                && rule.emission == ArgumentEmission::WhenFalse
                && rule.flag.as_deref() == Some("--no-backup")
        }));
        assert!(preview.parameters.iter().any(|parameter| {
            parameter.name == "generated_watch_url"
                && parameter.label == "自动生成的播放页地址"
                && !parameter.allow_override
                && parameter.derived_template.as_deref()
                    == Some("https://hanime1.me/watch?v={{video_id}}")
        }));

        let values = HashMap::from([
            ("source_mode".to_string(), "id".to_string()),
            ("video_id".to_string(), "406871".to_string()),
            ("download_backup".to_string(), "true".to_string()),
            ("browser_fallback".to_string(), "true".to_string()),
        ]);
        let argv = crate::structured_arguments::build_structured_arguments(
            &preview.argument_rules,
            &values,
        )
        .unwrap();
        assert!(argv
            .windows(2)
            .any(|pair| { pair == ["--watch-url", "https://hanime1.me/watch?v=406871"] }));
        assert!(!argv.iter().any(|argument| argument == "--no-backup"));
        assert!(!argv
            .iter()
            .any(|argument| argument == "--no-browser-fallback"));
    }


}



