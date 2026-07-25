use std::collections::HashMap;

use anyhow::anyhow;
use serde::{Deserialize, Serialize};

use crate::command_template::apply_runtime_values;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ArgumentEmission {
    Always,
    WhenNonEmpty,
    WhenTrue,
    WhenFalse,
    Repeat,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ConditionOperator {
    Equals,
    NotEquals,
    Truthy,
    Falsy,
    NonEmpty,
    Empty,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArgumentCondition {
    pub(crate) field: String,
    pub(crate) operator: ConditionOperator,
    #[serde(default)]
    pub(crate) value: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskArgumentRule {
    pub(crate) id: String,
    pub(crate) input_name: String,
    pub(crate) flag: Option<String>,
    pub(crate) emission: ArgumentEmission,
    pub(crate) value_template: String,
    #[serde(default)]
    pub(crate) condition: Option<ArgumentCondition>,
    #[serde(default = "default_true")]
    pub(crate) enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ValidationKind {
    ConditionalRequired,
    AtLeastOne,
    MutuallyExclusive,
    Range,
    Enum,
    Repeat,
}

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ValidationRule {
    pub(crate) kind: ValidationKind,
    #[serde(default)]
    pub(crate) fields: Vec<String>,
    #[serde(default)]
    pub(crate) condition: Option<ArgumentCondition>,
    #[serde(default)]
    pub(crate) min: Option<f64>,
    #[serde(default)]
    pub(crate) max: Option<f64>,
    #[serde(default)]
    pub(crate) options: Vec<String>,
    #[serde(default)]
    pub(crate) message: String,
}

fn default_true() -> bool {
    true
}

pub(crate) fn build_structured_arguments(
    rules: &[TaskArgumentRule],
    values: &HashMap<String, String>,
) -> anyhow::Result<Vec<String>> {
    let mut arguments = Vec::new();
    for rule in rules.iter().filter(|rule| rule.enabled) {
        if !condition_matches(rule.condition.as_ref(), values) {
            continue;
        }
        let input = values
            .get(&rule.input_name)
            .map(String::as_str)
            .unwrap_or_default();
        let should_emit = match rule.emission {
            ArgumentEmission::Always => true,
            ArgumentEmission::WhenNonEmpty => !input.trim().is_empty(),
            ArgumentEmission::WhenTrue => input == "true",
            ArgumentEmission::WhenFalse => input == "false",
            ArgumentEmission::Repeat => !input.trim().is_empty(),
        };
        if !should_emit {
            continue;
        }
        if rule.emission == ArgumentEmission::Repeat {
            for item in input.lines().map(str::trim).filter(|item| !item.is_empty()) {
                if let Some(flag) = &rule.flag {
                    arguments.push(flag.clone());
                }
                let mut item_values = values.clone();
                item_values.insert(rule.input_name.clone(), item.to_string());
                let rendered = apply_runtime_values(&rule.value_template, &item_values)?;
                if !rendered.is_empty() {
                    arguments.push(rendered);
                }
            }
            continue;
        }
        if let Some(flag) = &rule.flag {
            arguments.push(flag.clone());
        }
        let rendered = apply_runtime_values(&rule.value_template, values)?;
        if !rendered.is_empty() {
            arguments.push(rendered);
        }
    }
    Ok(arguments)
}

pub(crate) fn condition_matches(
    condition: Option<&ArgumentCondition>,
    values: &HashMap<String, String>,
) -> bool {
    let Some(condition) = condition else {
        return true;
    };
    let actual = values
        .get(&condition.field)
        .map(String::as_str)
        .unwrap_or_default();
    match condition.operator {
        ConditionOperator::Equals => actual == condition.value.as_deref().unwrap_or_default(),
        ConditionOperator::NotEquals => actual != condition.value.as_deref().unwrap_or_default(),
        ConditionOperator::Truthy => actual == "true",
        ConditionOperator::Falsy => actual == "false",
        ConditionOperator::NonEmpty => !actual.trim().is_empty(),
        ConditionOperator::Empty => actual.trim().is_empty(),
    }
}

pub(crate) fn validate_joint_rules(
    rules: &[ValidationRule],
    values: &HashMap<String, String>,
) -> anyhow::Result<()> {
    let non_empty = |name: &str| {
        values
            .get(name)
            .is_some_and(|value| !value.trim().is_empty())
    };
    for rule in rules {
        if !condition_matches(rule.condition.as_ref(), values) {
            continue;
        }
        let invalid = match rule.kind {
            ValidationKind::ConditionalRequired => {
                rule.fields.iter().any(|field| !non_empty(field))
            }
            ValidationKind::AtLeastOne => !rule.fields.iter().any(|field| non_empty(field)),
            ValidationKind::MutuallyExclusive => {
                rule.fields.iter().filter(|field| non_empty(field)).count() > 1
            }
            ValidationKind::Range => rule.fields.iter().any(|field| {
                let Some(value) = values.get(field).filter(|value| !value.trim().is_empty()) else {
                    return false;
                };
                let Ok(number) = value.parse::<f64>() else {
                    return true;
                };
                !number.is_finite()
                    || rule.min.is_some_and(|min| number < min)
                    || rule.max.is_some_and(|max| number > max)
            }),
            ValidationKind::Enum => rule.fields.iter().any(|field| {
                values.get(field).is_some_and(|value| {
                    !value.trim().is_empty() && !rule.options.iter().any(|item| item == value)
                })
            }),
            ValidationKind::Repeat => rule.fields.iter().any(|field| {
                let count = values
                    .get(field)
                    .map(|value| value.lines().filter(|line| !line.trim().is_empty()).count())
                    .unwrap_or_default() as f64;
                rule.min.is_some_and(|min| count < min) || rule.max.is_some_and(|max| count > max)
            }),
        };
        if invalid {
            let message = if rule.message.trim().is_empty() {
                format!("运行参数联合校验失败：{}", rule.fields.join("、"))
            } else {
                rule.message.clone()
            };
            return Err(anyhow!(message));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_input_can_emit_multiple_derived_arguments_and_omit_an_empty_optional_value() {
        let rules = vec![
            TaskArgumentRule {
                id: "book-url".to_string(),
                input_name: "book_id".to_string(),
                flag: Some("--book-url".to_string()),
                emission: ArgumentEmission::Always,
                value_template: "https://www.comicbox.xyz/book/{{book_id}}".to_string(),
                condition: None,
                enabled: true,
            },
            TaskArgumentRule {
                id: "output".to_string(),
                input_name: "book_id".to_string(),
                flag: Some("--output".to_string()),
                emission: ArgumentEmission::Always,
                value_template: "F:\\CIL\\comicbox_{{book_id}}_backup".to_string(),
                condition: None,
                enabled: true,
            },
            TaskArgumentRule {
                id: "chapters".to_string(),
                input_name: "chapters".to_string(),
                flag: Some("--chapters".to_string()),
                emission: ArgumentEmission::WhenNonEmpty,
                value_template: "{{chapters}}".to_string(),
                condition: None,
                enabled: true,
            },
        ];
        let values = HashMap::from([
            ("book_id".to_string(), "5101".to_string()),
            ("chapters".to_string(), String::new()),
        ]);

        let arguments = build_structured_arguments(&rules, &values).unwrap();

        assert_eq!(
            arguments,
            vec![
                "--book-url",
                "https://www.comicbox.xyz/book/5101",
                "--output",
                "F:\\CIL\\comicbox_5101_backup",
            ]
        );
        assert!(!arguments.iter().any(|value| value == "--chapters"));
    }

    #[test]
    fn conditions_select_the_active_source_mode() {
        let rules = vec![
            TaskArgumentRule {
                id: "watch-url-from-id".to_string(),
                input_name: "video_id".to_string(),
                flag: Some("--watch-url".to_string()),
                emission: ArgumentEmission::Always,
                value_template: "https://hanime1.me/watch?v={{video_id}}".to_string(),
                condition: Some(ArgumentCondition {
                    field: "source_mode".to_string(),
                    operator: ConditionOperator::Equals,
                    value: Some("id".to_string()),
                }),
                enabled: true,
            },
            TaskArgumentRule {
                id: "input-html".to_string(),
                input_name: "input_html".to_string(),
                flag: Some("--input-html".to_string()),
                emission: ArgumentEmission::WhenNonEmpty,
                value_template: "{{input_html}}".to_string(),
                condition: Some(ArgumentCondition {
                    field: "source_mode".to_string(),
                    operator: ConditionOperator::Equals,
                    value: Some("html".to_string()),
                }),
                enabled: true,
            },
        ];
        let values = HashMap::from([
            ("source_mode".to_string(), "html".to_string()),
            ("video_id".to_string(), "406871".to_string()),
            ("input_html".to_string(), "F:\\case\\page.html".to_string()),
        ]);

        assert_eq!(
            build_structured_arguments(&rules, &values).unwrap(),
            vec!["--input-html", "F:\\case\\page.html"]
        );
    }

    #[test]
    fn inverse_booleans_emit_flags_and_repeat_emits_one_flag_per_line() {
        let rules = vec![
            TaskArgumentRule {
                id: "no-backup".to_string(),
                input_name: "download_backup".to_string(),
                flag: Some("--no-backup".to_string()),
                emission: ArgumentEmission::WhenFalse,
                value_template: String::new(),
                condition: None,
                enabled: true,
            },
            TaskArgumentRule {
                id: "header".to_string(),
                input_name: "header".to_string(),
                flag: Some("--header".to_string()),
                emission: ArgumentEmission::Repeat,
                value_template: "{{header}}".to_string(),
                condition: None,
                enabled: true,
            },
        ];
        let values = HashMap::from([
            ("download_backup".to_string(), "false".to_string()),
            ("header".to_string(), "A: 1\nB: 2".to_string()),
        ]);

        assert_eq!(
            build_structured_arguments(&rules, &values).unwrap(),
            vec!["--no-backup", "--header", "A: 1", "--header", "B: 2"]
        );
    }

    #[test]
    fn joint_validation_enforces_conditional_required_at_least_one_and_exclusion() {
        let rules = vec![
            ValidationRule {
                kind: ValidationKind::ConditionalRequired,
                fields: vec!["input_html".to_string()],
                condition: Some(ArgumentCondition {
                    field: "source_mode".to_string(),
                    operator: ConditionOperator::Equals,
                    value: Some("html".to_string()),
                }),
                min: None,
                max: None,
                options: Vec::new(),
                message: "HTML 模式需要选择文件".to_string(),
            },
            ValidationRule {
                kind: ValidationKind::AtLeastOne,
                fields: vec!["watch_url".to_string(), "input_html".to_string()],
                condition: None,
                min: None,
                max: None,
                options: Vec::new(),
                message: String::new(),
            },
            ValidationRule {
                kind: ValidationKind::MutuallyExclusive,
                fields: vec!["watch_url".to_string(), "input_html".to_string()],
                condition: None,
                min: None,
                max: None,
                options: Vec::new(),
                message: String::new(),
            },
        ];
        let missing = HashMap::from([("source_mode".to_string(), "html".to_string())]);
        assert!(validate_joint_rules(&rules, &missing).is_err());

        let mutually_exclusive = HashMap::from([
            ("source_mode".to_string(), "html".to_string()),
            ("watch_url".to_string(), "https://example.test".to_string()),
            ("input_html".to_string(), "page.html".to_string()),
        ]);
        assert!(validate_joint_rules(&rules, &mutually_exclusive).is_err());

        let valid = HashMap::from([
            ("source_mode".to_string(), "html".to_string()),
            ("input_html".to_string(), "page.html".to_string()),
        ]);
        validate_joint_rules(&rules, &valid).unwrap();
    }
}
