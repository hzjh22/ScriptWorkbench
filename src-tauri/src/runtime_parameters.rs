use std::collections::{HashMap, HashSet};

use anyhow::anyhow;
use serde::{Deserialize, Serialize};

use crate::{
    command_template::apply_runtime_values,
    structured_arguments::{condition_matches, ArgumentCondition},
};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RuntimeParameterType {
    Text,
    Number,
    Boolean,
    Choice,
    File,
    Directory,
    Secret,
}

impl RuntimeParameterType {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Choice => "choice",
            Self::File => "file",
            Self::Directory => "directory",
            Self::Secret => "secret",
        }
    }

    pub(crate) fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "text" => Ok(Self::Text),
            "number" => Ok(Self::Number),
            "boolean" => Ok(Self::Boolean),
            "choice" => Ok(Self::Choice),
            "file" => Ok(Self::File),
            "directory" => Ok(Self::Directory),
            "secret" => Ok(Self::Secret),
            _ => Err(anyhow!("未知的动态参数类型: {value}")),
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeParameterDefinition {
    pub(crate) name: String,
    pub(crate) label: String,
    pub(crate) description: String,
    #[serde(rename = "type")]
    pub(crate) parameter_type: RuntimeParameterType,
    pub(crate) required: bool,
    pub(crate) default_value: String,
    pub(crate) options: Vec<String>,
    pub(crate) min: Option<f64>,
    pub(crate) max: Option<f64>,
    #[serde(default = "default_group")]
    pub(crate) group: String,
    #[serde(default)]
    pub(crate) advanced: bool,
    #[serde(default = "default_source")]
    pub(crate) source: String,
    #[serde(default = "default_confidence")]
    pub(crate) confidence: String,
    #[serde(default)]
    pub(crate) locked: bool,
    #[serde(default)]
    pub(crate) condition: Option<ArgumentCondition>,
    #[serde(default)]
    pub(crate) derived_template: Option<String>,
    #[serde(default = "default_true")]
    pub(crate) allow_override: bool,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
}

fn default_group() -> String {
    "常用参数".to_string()
}

fn default_source() -> String {
    "template".to_string()
}

fn default_confidence() -> String {
    "low".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, PartialEq)]
pub(crate) struct ResolvedRuntimeValues {
    pub(crate) actual: HashMap<String, String>,
    pub(crate) persisted: HashMap<String, String>,
    pub(crate) redacted: HashMap<String, String>,
}

pub(crate) fn default_parameter(name: &str) -> RuntimeParameterDefinition {
    RuntimeParameterDefinition {
        name: name.to_string(),
        label: name.to_string(),
        description: String::new(),
        parameter_type: RuntimeParameterType::Text,
        required: true,
        default_value: String::new(),
        options: Vec::new(),
        min: None,
        max: None,
        group: default_group(),
        advanced: false,
        source: default_source(),
        confidence: default_confidence(),
        locked: false,
        condition: None,
        derived_template: None,
        allow_override: true,
        enabled: true,
    }
}

pub(crate) fn synchronize_definitions(
    variables: &[String],
    configured: &[RuntimeParameterDefinition],
) -> anyhow::Result<Vec<RuntimeParameterDefinition>> {
    let mut synchronized = Vec::with_capacity(variables.len());
    for name in variables {
        let mut parameter = configured
            .iter()
            .find(|parameter| parameter.name == *name)
            .cloned()
            .unwrap_or_else(|| default_parameter(name));
        if parameter.label.trim().is_empty() {
            parameter.label = name.clone();
        }
        if parameter.min.is_some_and(|value| !value.is_finite())
            || parameter.max.is_some_and(|value| !value.is_finite())
        {
            return Err(anyhow!("运行参数 {name} 的数值范围无效"));
        }
        if let (Some(min), Some(max)) = (parameter.min, parameter.max) {
            if min > max {
                return Err(anyhow!("运行参数 {name} 的最小值不能大于最大值"));
            }
        }
        if parameter.parameter_type == RuntimeParameterType::Choice && parameter.options.is_empty()
        {
            return Err(anyhow!("运行参数 {name} 至少需要一个可选项"));
        }
        if parameter.parameter_type == RuntimeParameterType::Secret
            && !parameter.default_value.is_empty()
        {
            return Err(anyhow!("敏感参数 {name} 不能配置默认值"));
        }
        synchronized.push(parameter);
    }
    Ok(synchronized)
}

pub(crate) fn resolve_runtime_values(
    variables: &[String],
    configured: &[RuntimeParameterDefinition],
    provided: &HashMap<String, String>,
) -> anyhow::Result<ResolvedRuntimeValues> {
    resolve_runtime_values_allowing_multiline(variables, configured, provided, &HashSet::new())
}

pub(crate) fn resolve_runtime_values_allowing_multiline(
    variables: &[String],
    configured: &[RuntimeParameterDefinition],
    provided: &HashMap<String, String>,
    multiline_parameters: &HashSet<String>,
) -> anyhow::Result<ResolvedRuntimeValues> {
    let definitions = synchronize_definitions(variables, configured)?;
    let mut actual = HashMap::new();
    let mut persisted = HashMap::new();
    let mut redacted = HashMap::new();
    for name in variables {
        let parameter = definitions
            .iter()
            .find(|parameter| parameter.name == *name)
            .expect("synchronized definitions contain every variable")
            .clone();
        let value = provided
            .get(name)
            .cloned()
            .unwrap_or_else(|| parameter.default_value.clone());
        actual.insert(name.clone(), value);
    }

    for _ in 0..definitions.len().max(1) {
        let previous = actual.clone();
        for parameter in &definitions {
            let Some(template) = parameter.derived_template.as_ref() else {
                continue;
            };
            let current = actual
                .get(&parameter.name)
                .map(String::as_str)
                .unwrap_or_default();
            if parameter.allow_override && !current.trim().is_empty() {
                continue;
            }
            let derived = apply_runtime_values(template, &actual)?;
            actual.insert(parameter.name.clone(), derived);
        }
        if actual == previous {
            break;
        }
    }

    for name in variables {
        let parameter = definitions
            .iter()
            .find(|parameter| parameter.name == *name)
            .expect("synchronized definitions contain every variable")
            .clone();
        let value = actual.get(name).cloned().unwrap_or_default();
        let active = parameter.enabled && condition_matches(parameter.condition.as_ref(), &actual);
        if value.trim().is_empty() && parameter.required && active {
            return Err(anyhow!("请填写运行参数: {name}"));
        }
        if value.chars().any(|character| {
            matches!(character, '\0' | '\r')
                || (character == '\n' && !multiline_parameters.contains(name))
        }) {
            return Err(anyhow!("运行参数 {name} 不能包含换行或空字符"));
        }
        if parameter.parameter_type == RuntimeParameterType::Number && !value.trim().is_empty() {
            let number = value
                .parse::<f64>()
                .map_err(|_| anyhow!("运行参数 {name} 必须是有效数字"))?;
            if !number.is_finite() {
                return Err(anyhow!("运行参数 {name} 必须是有限数字"));
            }
            if parameter.min.is_some_and(|min| number < min) {
                return Err(anyhow!(
                    "运行参数 {name} 不能小于 {}",
                    parameter.min.unwrap()
                ));
            }
            if parameter.max.is_some_and(|max| number > max) {
                return Err(anyhow!(
                    "运行参数 {name} 不能大于 {}",
                    parameter.max.unwrap()
                ));
            }
        } else if parameter.parameter_type == RuntimeParameterType::Boolean
            && !value.trim().is_empty()
            && !matches!(value.as_str(), "true" | "false")
        {
            return Err(anyhow!("运行参数 {name} 必须是 true 或 false"));
        } else if parameter.parameter_type == RuntimeParameterType::Choice
            && !value.trim().is_empty()
            && !parameter.options.iter().any(|option| option == &value)
        {
            return Err(anyhow!("运行参数 {name} 不是有效选项"));
        }
        if parameter.parameter_type == RuntimeParameterType::Secret {
            redacted.insert(name.clone(), "••••••••".to_string());
        } else {
            persisted.insert(name.clone(), value.clone());
            redacted.insert(name.clone(), value);
        }
    }
    Ok(ResolvedRuntimeValues {
        persisted,
        redacted,
        actual,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn number_parameter() -> RuntimeParameterDefinition {
        RuntimeParameterDefinition {
            name: "workers".to_string(),
            label: "并发数".to_string(),
            description: String::new(),
            parameter_type: RuntimeParameterType::Number,
            required: true,
            default_value: "12".to_string(),
            options: Vec::new(),
            min: Some(1.0),
            max: Some(32.0),
            group: default_group(),
            advanced: false,
            source: default_source(),
            confidence: default_confidence(),
            locked: false,
            condition: None,
            derived_template: None,
            allow_override: true,
            enabled: true,
        }
    }

    #[test]
    fn applies_defaults_and_rejects_numbers_outside_the_configured_range() {
        let variables = vec!["workers".to_string()];
        let resolved =
            resolve_runtime_values(&variables, &[number_parameter()], &HashMap::new()).unwrap();
        assert_eq!(resolved.actual["workers"], "12");

        let invalid = HashMap::from([("workers".to_string(), "64".to_string())]);
        assert!(
            resolve_runtime_values(&variables, &[number_parameter()], &invalid)
                .unwrap_err()
                .to_string()
                .contains("32")
        );

        let non_finite = HashMap::from([("workers".to_string(), "NaN".to_string())]);
        assert!(resolve_runtime_values(&variables, &[number_parameter()], &non_finite).is_err());
    }

    #[test]
    fn redacts_secret_values_and_excludes_them_from_persistence() {
        let secret = RuntimeParameterDefinition {
            name: "token".to_string(),
            label: "访问令牌".to_string(),
            description: String::new(),
            parameter_type: RuntimeParameterType::Secret,
            required: true,
            default_value: String::new(),
            options: Vec::new(),
            min: None,
            max: None,
            group: default_group(),
            advanced: false,
            source: default_source(),
            confidence: default_confidence(),
            locked: false,
            condition: None,
            derived_template: None,
            allow_override: true,
            enabled: true,
        };
        let variables = vec!["token".to_string()];
        let provided = HashMap::from([("token".to_string(), "top-secret".to_string())]);

        let resolved = resolve_runtime_values(&variables, &[secret], &provided).unwrap();

        assert_eq!(resolved.actual["token"], "top-secret");
        assert_eq!(resolved.redacted["token"], "••••••••");
        assert!(!resolved.persisted.contains_key("token"));
    }

    #[test]
    fn rejects_values_that_do_not_match_boolean_or_choice_definitions() {
        let mut enabled = default_parameter("enabled");
        enabled.parameter_type = RuntimeParameterType::Boolean;
        let mut quality = default_parameter("quality");
        quality.parameter_type = RuntimeParameterType::Choice;
        quality.options = vec!["720p".to_string(), "1080p".to_string()];
        let variables = vec!["enabled".to_string(), "quality".to_string()];

        let invalid_boolean = HashMap::from([
            ("enabled".to_string(), "yes".to_string()),
            ("quality".to_string(), "1080p".to_string()),
        ]);
        assert!(resolve_runtime_values(
            &variables,
            &[enabled.clone(), quality.clone()],
            &invalid_boolean
        )
        .unwrap_err()
        .to_string()
        .contains("enabled"));

        let invalid_choice = HashMap::from([
            ("enabled".to_string(), "true".to_string()),
            ("quality".to_string(), "4k".to_string()),
        ]);
        assert!(
            resolve_runtime_values(&variables, &[enabled, quality], &invalid_choice)
                .unwrap_err()
                .to_string()
                .contains("quality")
        );
    }

    #[test]
    fn synchronizes_parameter_metadata_to_the_template_variable_order() {
        let mut quality = default_parameter("quality");
        quality.label = "画质".to_string();
        quality.parameter_type = RuntimeParameterType::Choice;
        quality.options = vec!["720p".to_string(), "1080p".to_string()];
        let removed = default_parameter("removed");
        let variables = vec!["book_id".to_string(), "quality".to_string()];

        let synchronized =
            synchronize_definitions(&variables, &[quality.clone(), removed]).unwrap();

        assert_eq!(synchronized[0], default_parameter("book_id"));
        assert_eq!(synchronized[1], quality);
        assert_eq!(synchronized.len(), 2);
    }

    #[test]
    fn derives_a_read_only_output_from_an_identifier_but_preserves_overridable_values() {
        let mut book_id = default_parameter("book_id");
        book_id.default_value = "5101".to_string();
        let mut output = default_parameter("output");
        output.derived_template = Some("F:\\CIL\\comicbox_{{book_id}}_backup".to_string());
        output.allow_override = false;
        let mut optional_output = default_parameter("optional_output");
        optional_output.derived_template = Some("runs\\{{book_id}}".to_string());
        optional_output.allow_override = true;
        let variables = vec![
            "book_id".to_string(),
            "output".to_string(),
            "optional_output".to_string(),
        ];
        let provided = HashMap::from([
            ("output".to_string(), "ignored".to_string()),
            ("optional_output".to_string(), "custom".to_string()),
        ]);

        let resolved =
            resolve_runtime_values(&variables, &[book_id, output, optional_output], &provided)
                .unwrap();

        assert_eq!(resolved.actual["output"], "F:\\CIL\\comicbox_5101_backup");
        assert_eq!(resolved.actual["optional_output"], "custom");
    }

    #[test]
    fn an_explicit_empty_optional_value_overrides_its_configured_default() {
        let mut chapters = default_parameter("chapters");
        chapters.required = false;
        chapters.default_value = "77-117".to_string();
        let provided = HashMap::from([("chapters".to_string(), String::new())]);

        let resolved =
            resolve_runtime_values(&["chapters".to_string()], &[chapters], &provided).unwrap();

        assert_eq!(resolved.actual["chapters"], "");
    }
}
