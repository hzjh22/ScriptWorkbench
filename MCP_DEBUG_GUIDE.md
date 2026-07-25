# Script Workbench MCP 调试指南

## 1. 用途

`scripts/script_workbench_mcp.py` 是 Script Workbench 的本地 stdio MCP 调试桥。它不读取屏幕、不识别截图、不执行坐标点击，而是直接连接应用数据库与日志，并使用任务保存的解释器、脚本路径和参数模板进行结构化分析。

默认数据源：

```text
%APPDATA%\com.lmoon.scriptworkbench\workbench.sqlite
%APPDATA%\com.lmoon.scriptworkbench\logs
```

可使用环境变量 `SCRIPT_WORKBENCH_DB` 指向其他测试数据库。

## 2. Codex 注册

当前机器已经注册：

```powershell
codex mcp add script-workbench -- python E:\ScriptWorkbench\scripts\script_workbench_mcp.py
codex mcp get script-workbench
```

修改 MCP 服务脚本后，重新启动 Codex 会话即可加载新版本。

Schema v4 修改 MCP 服务脚本后同样需要重新打开 Codex 任务，以重建 stdio 连接。

## 3. MCP 工具

- `health`：检查数据库、日志目录和桌面进程状态。
- `list_tasks`：列出任务 ID、名称、类型和更新时间。
- `inspect_task`：读取解释器、脚本、环境、可靠性策略，并返回 `argument_mode`、参数分组、扫描来源、argv 规则、联合校验和脚本哈希状态。
- `preview_task`：模板模式替换占位符；结构化模式与桌面端使用同一套 emission、condition、派生、校验和脱敏规则，不执行任务。
- `probe_task`：按真实任务配置执行短时探测，收集 stdout/stderr，超时后终止进程树。
- `list_runs`：读取应用产生的运行记录与命令快照。
- `read_run_output`：读取指定 Run ID 的 stdout/stderr 日志。

## 4. 执行安全

`probe_task` 会真实执行任务，因此必须显式传入：

```json
{
  "confirm": true,
  "timeout_seconds": 8
}
```

超时范围限制为 `1-60` 秒。超时后 MCP 使用 `taskkill /T /F` 终止探测进程及子进程。探测不会写入应用的 `run_records`，避免污染正式运行历史。

对于下载、备份、删除或外部写入型脚本，应先调用 `preview_task` 核对命令，再使用尽可能短的 `probe_task`。

类型为 `secret` 的密码或 Token 不会出现在 `preview_task` / `probe_task` 的命令预览中，MCP 会用 `••••••••` 替代；实际探测进程仍会收到真实值。

## 5. 视频源摘要故障结论

旧任务模板：

```text
--video-id {{video_id}}
```

脚本要求 `--watch-url` 或 `--input-html` 至少存在一个，所以旧模板必然触发：

```text
error: one of --watch-url or --input-html is required
```

修复后的模板：

```text
--watch-url https://hanime1.me/watch?v={{video_id}} --video-id {{video_id}}
```

MCP 使用 `video_id=407103` 得到的真实命令：

```text
D:\python\Python311\python.exe -u F:\CIL\cases\hanime1-video-406871\scripts\summarize_video_sources.py --watch-url https://hanime1.me/watch?v=407103 --video-id 407103
```

真实探测结果：

- argparse 参数校验已通过。
- 脚本执行约 `2.06s` 后退出码为 `1`。
- 脚本成功生成 blocked report 路径。
- stderr 为 `no MP4 sources were found; saved a blocked report. Try --input-html or --cookie-header.`。

这表示软件命令模板问题已经修复，但目标站页面没有向当前请求返回可解析的 MP4 源。下一步应提供有效 `--cookie-header`、保存后的 `--input-html`，或调整脚本的浏览器登录态获取方式。
