use std::{
    collections::HashSet,
    convert::Infallible,
    net::SocketAddr,
    path::{Path, PathBuf},
};

use anyhow::Context;
use axum::{
    body::Body,
    extract::{Path as AxumPath, State as AxumState},
    http::{header, HeaderMap, StatusCode},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, SeekFrom},
    sync::oneshot,
};
use tokio_stream::{wrappers::BroadcastStream, Stream, StreamExt};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use crate::{
    list_run_records, list_task_records, mobile_api_pairing_code, open_connection,
    read_run_output_impl, read_run_record, start_run_impl, stop_run_impl, AppState, ApiRunEvent,
    MobileApiSettings, RunRecord,
};

#[derive(Debug)]
pub(crate) struct ApiServerHandle {
    pub(crate) bind_host: String,
    pub(crate) port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

impl ApiServerHandle {
    pub(crate) fn stop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
}

#[derive(Clone)]
struct HttpState {
    app: AppHandle,
    workbench: AppState,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    error: String,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn internal(error: impl ToString) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(ErrorBody { error: self.message })).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    app: &'static str,
    version: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairRequest {
    pairing_code: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairResponse {
    token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRunRequest {
    #[serde(default)]
    runtime_values: std::collections::HashMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiFileInfo {
    file_id: String,
    run_id: String,
    name: String,
    bytes: u64,
    modified_at: String,
    content_type: String,
    local_path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

pub(crate) async fn start(
    app: AppHandle,
    workbench: AppState,
    settings: MobileApiSettings,
) -> anyhow::Result<ApiServerHandle> {
    let addr: SocketAddr = format!("{}:{}", settings.bind_host, settings.port)
        .parse()
        .with_context(|| format!("无效的移动端 API 监听地址: {}:{}", settings.bind_host, settings.port))?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;
    let state = HttpState { app, workbench };
    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/pair", post(pair))
        .route("/api/tasks", get(tasks))
        .route("/api/tasks/:task_id", get(task_detail))
        .route("/api/tasks/:task_id/run", post(start_task_run))
        .route("/api/runs", get(runs))
        .route("/api/runs/:run_id", get(run_detail))
        .route("/api/runs/:run_id/output", get(run_output))
        .route("/api/runs/:run_id/stream", get(run_stream))
        .route("/api/runs/:run_id/stop", post(stop_run))
        .route("/api/runs/:run_id/files", get(run_files))
        .route("/api/files/:file_id/download", get(download_file))
        .with_state(state);

    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, router).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = server.await {
            eprintln!("[Script Workbench] mobile api server stopped with error: {error}");
        }
    });

    Ok(ApiServerHandle {
        bind_host: settings.bind_host,
        port: local_addr.port(),
        shutdown: Some(shutdown_tx),
    })
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        app: "Script Workbench",
        version: env!("CARGO_PKG_VERSION"),
    })
}

async fn pair(
    AxumState(state): AxumState<HttpState>,
    Json(payload): Json<PairRequest>,
) -> ApiResult<Json<PairResponse>> {
    let expected = mobile_api_pairing_code(&state.workbench).map_err(ApiError::internal)?;
    if expected.trim().is_empty() || payload.pairing_code.trim() != expected {
        return Err(ApiError::new(StatusCode::UNAUTHORIZED, "配对码不正确"));
    }

    let token = format!("swb_{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let token_hash = hash_secret(&token);
    let conn = open_connection(&state.workbench).map_err(ApiError::internal)?;
    conn.execute(
        "UPDATE mobile_api_settings SET token_hash = ?1, updated_at = ?2 WHERE id = 1",
        params![token_hash, crate::now_iso()],
    )
    .map_err(ApiError::internal)?;

    Ok(Json(PairResponse { token }))
}

async fn tasks(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<crate::TaskRecord>>> {
    authorize(&state.workbench, &headers)?;
    list_task_records(&state.workbench)
        .map(Json)
        .map_err(ApiError::internal)
}

async fn task_detail(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    AxumPath(task_id): AxumPath<String>,
) -> ApiResult<Json<crate::TaskRecord>> {
    authorize(&state.workbench, &headers)?;
    let conn = open_connection(&state.workbench).map_err(ApiError::internal)?;
    crate::get_task(&conn, &task_id)
        .map(Json)
        .map_err(ApiError::internal)
}

async fn start_task_run(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    AxumPath(task_id): AxumPath<String>,
    Json(payload): Json<StartRunRequest>,
) -> ApiResult<Json<RunRecord>> {
    authorize(&state.workbench, &headers)?;
    start_run_impl(
        state.app,
        state.workbench,
        task_id,
        payload.runtime_values,
    )
    .await
    .map(Json)
    .map_err(ApiError::internal)
}

async fn runs(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<RunRecord>>> {
    authorize(&state.workbench, &headers)?;
    list_run_records(&state.workbench)
        .map(Json)
        .map_err(ApiError::internal)
}

async fn run_detail(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<Json<RunRecord>> {
    authorize(&state.workbench, &headers)?;
    let conn = open_connection(&state.workbench).map_err(ApiError::internal)?;
    read_run_record(&conn, &run_id)
        .map(Json)
        .map_err(ApiError::internal)
}

async fn run_output(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<Json<crate::RunOutput>> {
    authorize(&state.workbench, &headers)?;
    read_run_output_impl(&state.workbench, &run_id)
        .map(Json)
        .map_err(ApiError::internal)
}

async fn stop_run(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<StatusCode> {
    authorize(&state.workbench, &headers)?;
    stop_run_impl(&state.workbench, &run_id)
        .map(|_| StatusCode::NO_CONTENT)
        .map_err(ApiError::internal)
}

async fn run_stream(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    authorize(&state.workbench, &headers)?;
    let receiver = state.workbench.api_events.subscribe();
    let stream = BroadcastStream::new(receiver).filter_map(move |message| {
        let expected_run_id = run_id.clone();
        match message {
            Ok(event) if event.run_id == expected_run_id => {
                Some(Ok(Event::default().event(event.kind.clone()).data(
                    serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string()),
                )))
            }
            _ => None,
        }
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn run_files(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    AxumPath(run_id): AxumPath<String>,
) -> ApiResult<Json<Vec<ApiFileInfo>>> {
    authorize(&state.workbench, &headers)?;
    let conn = open_connection(&state.workbench).map_err(ApiError::internal)?;
    let run = read_run_record(&conn, &run_id).map_err(ApiError::internal)?;
    index_run_files(&state.workbench, &run)
        .map(Json)
        .map_err(ApiError::internal)
}

async fn download_file(
    AxumState(state): AxumState<HttpState>,
    headers: HeaderMap,
    AxumPath(file_id): AxumPath<String>,
) -> ApiResult<Response> {
    authorize(&state.workbench, &headers)?;
    let range_header = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let conn = open_connection(&state.workbench).map_err(ApiError::internal)?;
    let row = conn
        .query_row(
            "SELECT path, name, content_type FROM mobile_file_index WHERE file_id = ?1",
            [file_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(ApiError::internal)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "文件不存在或尚未索引"))?;

    let path = PathBuf::from(row.0);
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|_| ApiError::new(StatusCode::NOT_FOUND, "文件已不存在"))?;
    if !metadata.is_file() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "目标不是文件"));
    }
    let size = metadata.len();
    let selected_range = parse_range_header(range_header.as_deref(), size)?;
    let (status, start, end) = match selected_range {
        Some(range) => (StatusCode::PARTIAL_CONTENT, range.start, range.end),
        None => (StatusCode::OK, 0, size.saturating_sub(1)),
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    let mut file = File::open(&path).await.map_err(ApiError::internal)?;
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await.map_err(ApiError::internal)?;
    }
    let stream = ReaderStream::new(file.take(length));
    let mut response = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_TYPE, row.2)
        .header(header::CONTENT_LENGTH, length.to_string())
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", row.1.replace('"', "")),
        );
    if status == StatusCode::PARTIAL_CONTENT {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{size}"),
        );
    }
    response
        .body(Body::from_stream(stream))
        .map_err(ApiError::internal)
}

fn authorize(state: &AppState, headers: &HeaderMap) -> ApiResult<()> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "缺少访问 Token"))?;
    let conn = open_connection(state).map_err(ApiError::internal)?;
    let expected_hash: Option<String> = conn
        .query_row(
            "SELECT token_hash FROM mobile_api_settings WHERE id = 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(ApiError::internal)?
        .flatten();
    if expected_hash.as_deref() == Some(hash_secret(token).as_str()) {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::UNAUTHORIZED, "访问 Token 不正确"))
    }
}

fn hash_secret(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn index_run_files(state: &AppState, run: &RunRecord) -> anyhow::Result<Vec<ApiFileInfo>> {
    let mut roots = candidate_roots(run);
    roots.sort();
    roots.dedup();

    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for root in roots {
        collect_files(&root, 0, &mut seen, &mut files)?;
        if files.len() >= 300 {
            break;
        }
    }

    for file in &mut files {
        file.run_id = run.id.clone();
    }
    files.sort_by(|left, right| right.modified_at.cmp(&left.modified_at));
    let conn = open_connection(state)?;
    for file in &files {
        conn.execute(
            "INSERT INTO mobile_file_index (
                file_id, run_id, path, name, bytes, modified_at, content_type, indexed_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(file_id) DO UPDATE SET
                run_id=excluded.run_id,
                path=excluded.path,
                name=excluded.name,
                bytes=excluded.bytes,
                modified_at=excluded.modified_at,
                content_type=excluded.content_type,
                indexed_at=excluded.indexed_at",
            params![
                file.file_id,
                file.run_id,
                file.local_path,
                file.name,
                file.bytes as i64,
                file.modified_at,
                file.content_type,
                crate::now_iso(),
            ],
        )?;
    }
    Ok(files)
}

fn candidate_roots(run: &RunRecord) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    push_existing_root(&mut roots, PathBuf::from(&run.working_directory));
    for value in run.runtime_values.values() {
        if value.trim().is_empty() {
            continue;
        }
        let path = PathBuf::from(value.trim().trim_matches('"'));
        push_existing_root(&mut roots, path);
    }
    roots
}

fn push_existing_root(roots: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() {
        roots.push(path);
    } else if path.is_file() {
        if let Some(parent) = path.parent() {
            roots.push(parent.to_path_buf());
        }
    }
}

fn collect_files(
    root: &Path,
    depth: usize,
    seen: &mut HashSet<PathBuf>,
    files: &mut Vec<ApiFileInfo>,
) -> anyhow::Result<()> {
    if depth > 3 || files.len() >= 300 {
        return Ok(());
    }
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return Ok(()),
    };
    for entry in entries.flatten() {
        if files.len() >= 300 {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if !matches!(name.as_str(), "临时" | "tmp" | "temp" | "__pycache__") {
                collect_files(&path, depth + 1, seen, files)?;
            }
            continue;
        }
        if !path.is_file() || is_ignored_output_file(&name) {
            continue;
        }
        let canonical = match path.canonicalize() {
            Ok(path) => path,
            Err(_) => continue,
        };
        if !seen.insert(canonical.clone()) {
            continue;
        }
        let metadata = match std::fs::metadata(&canonical) {
            Ok(metadata) => metadata,
            Err(_) => continue,
        };
        let modified_at = metadata
            .modified()
            .ok()
            .map(DateTime::<Utc>::from)
            .unwrap_or_else(Utc::now)
            .to_rfc3339();
        let local_path = canonical.to_string_lossy().into_owned();
        let file_id = hash_secret(&local_path);
        let content_type = mime_guess::from_path(&canonical)
            .first_or_octet_stream()
            .essence_str()
            .to_string();
        files.push(ApiFileInfo {
            file_id,
            run_id: String::new(),
            name,
            bytes: metadata.len(),
            modified_at,
            content_type,
            local_path,
        });
    }
    Ok(())
}

fn is_ignored_output_file(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.ends_with(".log")
        || lower.ends_with(".part")
        || lower.ends_with(".tmp")
        || lower.ends_with(".crdownload")
        || lower.ends_with(".sqlite")
        || lower.ends_with(".db")
}

fn parse_range_header(header_value: Option<&str>, size: u64) -> ApiResult<Option<ByteRange>> {
    let Some(header_value) = header_value else {
        return Ok(None);
    };
    if size == 0 {
        return Ok(None);
    }
    let value = header_value.trim();
    let Some(range_text) = value.strip_prefix("bytes=") else {
        return Err(ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "Range 格式不正确"));
    };
    let Some((start_text, end_text)) = range_text.split_once('-') else {
        return Err(ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "Range 格式不正确"));
    };
    let range = if start_text.is_empty() {
        let suffix = end_text
            .parse::<u64>()
            .map_err(|_| ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "Range 格式不正确"))?;
        if suffix == 0 {
            return Err(ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "Range 长度不正确"));
        }
        let start = size.saturating_sub(suffix);
        ByteRange {
            start,
            end: size - 1,
        }
    } else {
        let start = start_text
            .parse::<u64>()
            .map_err(|_| ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "Range 起点不正确"))?;
        let end = if end_text.is_empty() {
            size - 1
        } else {
            end_text
                .parse::<u64>()
                .map_err(|_| ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "Range 终点不正确"))?
        };
        if start >= size || end < start {
            return Err(ApiError::new(StatusCode::RANGE_NOT_SATISFIABLE, "Range 越界"));
        }
        ByteRange {
            start,
            end: end.min(size - 1),
        }
    };
    Ok(Some(range))
}

pub(crate) fn run_event_stream(
    kind: &str,
    run_id: String,
    chunk: Option<String>,
    status: Option<String>,
    exit_code: Option<i32>,
    finished_at: Option<String>,
    duration_ms: Option<i64>,
) -> ApiRunEvent {
    ApiRunEvent {
        kind: kind.to_string(),
        run_id,
        chunk,
        status,
        exit_code,
        finished_at,
        duration_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_http_ranges() {
        assert_eq!(
            parse_range_header(Some("bytes=10-19"), 100).unwrap(),
            Some(ByteRange { start: 10, end: 19 })
        );
        assert_eq!(
            parse_range_header(Some("bytes=95-"), 100).unwrap(),
            Some(ByteRange { start: 95, end: 99 })
        );
        assert_eq!(
            parse_range_header(Some("bytes=-5"), 100).unwrap(),
            Some(ByteRange { start: 95, end: 99 })
        );
        assert!(parse_range_header(Some("bytes=100-101"), 100).is_err());
    }
}
