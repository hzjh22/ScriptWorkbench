use std::collections::HashMap;

use anyhow::anyhow;

pub(crate) fn normalize_command(command_text: &str) -> String {
    command_text
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.strip_suffix('`').unwrap_or(trimmed).trim_end())
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn tokenize_command_line(command: &str) -> anyhow::Result<Vec<String>> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for character in command.chars() {
        match character {
            '\'' | '"' if quote == Some(character) => quote = None,
            '\'' | '"' if quote.is_none() => quote = Some(character),
            whitespace if whitespace.is_whitespace() && quote.is_none() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            other => current.push(other),
        }
    }
    if quote.is_some() {
        return Err(anyhow!("命令中的引号未闭合"));
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    Ok(tokens)
}

pub(crate) fn quote_arg(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_string();
    }
    if value.chars().any(|ch| ch.is_whitespace() || ch == '"') {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

pub(crate) fn join_command(program: &str, args: &[String]) -> String {
    std::iter::once(quote_arg(program))
        .chain(args.iter().map(|arg| quote_arg(arg)))
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn extract_runtime_variables(template: &str) -> anyhow::Result<Vec<String>> {
    let mut variables = Vec::new();
    let mut remaining = template;
    while let Some(start) = remaining.find("{{") {
        let after_start = &remaining[start + 2..];
        let end = after_start
            .find("}}")
            .ok_or_else(|| anyhow!("参数模板中的占位符未闭合"))?;
        let name = &after_start[..end];
        let mut characters = name.chars();
        let valid_first = characters
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_');
        if !valid_first || !characters.all(|ch| ch.is_ascii_alphanumeric() || ch == '_') {
            return Err(anyhow!("无效的运行参数占位符 {{{{{name}}}}}，变量名只能包含字母、数字和下划线且不能以数字开头"));
        }
        if !variables.iter().any(|variable| variable == name) {
            variables.push(name.to_string());
        }
        remaining = &after_start[end + 2..];
    }
    if remaining.contains("}}") {
        return Err(anyhow!("参数模板中存在没有起始标记的 }}"));
    }
    Ok(variables)
}

pub(crate) fn apply_runtime_values(
    template: &str,
    values: &HashMap<String, String>,
) -> anyhow::Result<String> {
    let mut resolved = template.to_string();
    for variable in extract_runtime_variables(template)? {
        let value = values
            .get(&variable)
            .ok_or_else(|| anyhow!("请填写运行参数: {variable}"))?;
        resolved = resolved.replace(&format!("{{{{{variable}}}}}"), value);
    }
    Ok(resolved)
}

fn quote_cmd_runtime_value(value: &str) -> String {
    if value
        .chars()
        .any(|ch| ch.is_whitespace() || "()".contains(ch))
    {
        format!("\"{value}\"")
    } else {
        value.to_string()
    }
}

pub(crate) fn apply_command_runtime_values(
    template: &str,
    values: &HashMap<String, String>,
) -> anyhow::Result<String> {
    let mut resolved = template.to_string();
    for variable in extract_runtime_variables(template)? {
        let value = values
            .get(&variable)
            .ok_or_else(|| anyhow!("请填写运行参数: {variable}"))?;
        if value
            .chars()
            .any(|character| "&|<>^\"%!\r\n\0".contains(character))
        {
            return Err(anyhow!("命令运行参数 {variable} 包含不安全的 Shell 元字符"));
        }
        let marker = format!("{{{{{variable}}}}}");
        while let Some(start) = resolved.find(&marker) {
            let end = start + marker.len();
            let already_quoted =
                resolved[..start].ends_with('"') && resolved[end..].starts_with('"');
            let replacement = if already_quoted {
                value.to_string()
            } else {
                quote_cmd_runtime_value(value)
            };
            resolved.replace_range(start..end, &replacement);
        }
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_runtime_values_reject_command_separators() {
        let values = HashMap::from([("name".to_string(), "safe & whoami".to_string())]);
        assert!(apply_command_runtime_values("echo {{name}}", &values).is_err());
    }

    #[test]
    fn shell_runtime_values_quote_spaces_without_changing_text() {
        let values = HashMap::from([("name".to_string(), "two words".to_string())]);
        assert_eq!(
            apply_command_runtime_values("echo {{name}}", &values).unwrap(),
            "echo \"two words\""
        );
    }

    #[test]
    fn present_empty_values_can_resolve_optional_placeholders() {
        let values = HashMap::from([("note".to_string(), String::new())]);
        assert_eq!(apply_runtime_values("{{note}}", &values).unwrap(), "");
        assert_eq!(
            apply_command_runtime_values("echo {{note}}", &values).unwrap(),
            "echo "
        );
    }
}
