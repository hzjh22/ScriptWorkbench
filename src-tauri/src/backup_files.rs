use std::{
    fs,
    path::{Path, PathBuf},
};

const MAX_BACKUP_BYTES: u64 = 5 * 1024 * 1024;

fn validate_backup_path(path: &Path) -> Result<(), String> {
    let is_json = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("json"));
    if !is_json {
        return Err("工作区备份只允许使用 .json 文件".to_string());
    }
    Ok(())
}

pub(crate) fn read(path: String) -> Result<String, String> {
    let path = PathBuf::from(path);
    validate_backup_path(&path)?;
    let metadata = fs::metadata(&path).map_err(|err| err.to_string())?;
    if metadata.len() > MAX_BACKUP_BYTES {
        return Err("工作区备份不能超过 5 MB".to_string());
    }
    fs::read_to_string(path).map_err(|err| err.to_string())
}

pub(crate) fn write(path: String, content: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    validate_backup_path(&path)?;
    if content.len() as u64 > MAX_BACKUP_BYTES {
        return Err("工作区备份不能超过 5 MB".to_string());
    }
    let parent = path.parent().ok_or_else(|| "无效的备份路径".to_string())?;
    if !parent.is_dir() {
        return Err("备份目录不存在".to_string());
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, content.as_bytes()).map_err(|err| err.to_string())?;
    if path.exists() {
        fs::remove_file(&path).map_err(|err| err.to_string())?;
    }
    fs::rename(temporary, path).map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_json_paths() {
        assert!(validate_backup_path(Path::new("settings.txt")).is_err());
        assert!(validate_backup_path(Path::new("settings.JSON")).is_ok());
    }
}
