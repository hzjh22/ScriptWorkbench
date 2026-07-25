# Selftest Report

生成时间：`2026-07-11`

## 通过项

- 前端生产构建通过：`cmd /c npm run build`
- 前端交互测试通过：`cmd /c npm run test`
- 后端/运行时自测通过：`python scripts/selftest_backend.py`
- Tauri 调试构建通过：`cmd /c npm run tauri build -- --debug --no-bundle`
- Tauri Windows 安装包构建通过：`cmd /c npm run tauri build -- --bundles nsis`

## 前端交互测试覆盖

测试文件：[src/App.selftest.test.tsx](E:\ScriptWorkbench\src\App.selftest.test.tsx)

已验证：

- 任务列表加载
- 任务详情加载
- 解释器选择弹层
- 选择 `Bundled Python`
- 参数模板编辑弹层
- 应用参数模板
- 保存任务时 payload 正确落到 `saveTask`
- 点击“运行任务”会触发 `startRun`
- 顶部粘性“开始运行”按钮会触发 `startRun`
- 同一任务连续点击“开始运行”会创建两个运行请求，不再因已有实例禁用
- 并发实例通过 Run ID 独立停止和记录日志
- 一个 `book_id` 输入可驱动 ComicBox URL 与输出路径中的重复占位符
- 动态值通过 `runtimeValues` 发送，不修改原任务模板
- 视频 ID 同时生成必需的 `--watch-url` 和 `--video-id`
- `contentEditable` 输入使用 `textContent` 保证 WebView 状态同步
- 最近参数异步加载完成前不显示输入框，避免覆盖用户刚输入的 `book_id`
- 工作区导出会调用 `writeTextFile`
- 工作区导入会调用 `readTextFile` 和 `saveSettings`

## 后端/运行时自测覆盖

测试脚本：[scripts/selftest_backend.py](E:\ScriptWorkbench\scripts\selftest_backend.py)
输出报告：[artifacts/backend_selftest_report.json](E:\ScriptWorkbench\artifacts\backend_selftest_report.json)

自测使用 `SCRIPT_WORKBENCH_DATA_DIR` 指向 `artifacts/selftest_appdata`，不会删除或覆盖真实用户数据库。

已验证：

- 应用首次启动后自动创建 `workbench.sqlite`
- 自动写入 3 个示例任务：
  - `ComicBox 备份`
  - `共模脚本`
  - `视频源摘要`
- 自动写入 2 个解释器：
  - `Bundled Python`
  - `System Python`
- 默认解释器为 `System Python`
- 发布资源目录中的 bundled Python 可直接运行 fixture 脚本
- 系统 Python 可直接运行 fixture 脚本
- 命令执行 smoke 成功
- release exe 与 NSIS 安装包产物存在

Rust 单元测试覆盖：

- 重复 `book_id` 占位符同步替换
- 重复变量只生成一个变量定义
- 缺失值和非法变量名拒绝运行
- 普通命令中的空格路径自动加引号
- Python 命令固定使用 `-u`，确保管道模式下及时输出
- 结果：`24 passed`

## MCP 结构化探测

调试服务：[scripts/script_workbench_mcp.py](E:\ScriptWorkbench\scripts\script_workbench_mcp.py)

已验证：

- MCP `initialize` 协议握手成功
- `list_tasks` 可读取真实用户数据库中的 4 个任务
- `inspect_task` 可读取视频任务的解释器、脚本和动态模板
- `preview_task` 使用 `video_id=407103` 生成完整播放页 URL
- `probe_task` 实际运行后不再出现 `one of --watch-url or --input-html is required`
- 当前业务层错误为目标页面未解析到 MP4 源，需要 Cookie 或本地 HTML，不再属于应用参数传递错误

视频 `407103` 后续正式运行验证结果：状态 `finished`、退出码 `0`，生成 `407103-1080p.mp4`，报告记录 `backup_status: downloaded`。curl 成功进度位于 stderr，界面已改称“进程信息（stderr）”。

## 关键产物

- 调试版：[src-tauri/target/debug/script-workbench.exe](E:\ScriptWorkbench\src-tauri\target\debug\script-workbench.exe)
- 发布版：[src-tauri/target/release/script-workbench.exe](E:\ScriptWorkbench\src-tauri\target\release\script-workbench.exe)
- 安装包：[src-tauri/target/release/bundle/nsis/Script Workbench_0.1.0_x64-setup.exe](E:\ScriptWorkbench\src-tauri\target\release\bundle\nsis\Script%20Workbench_0.1.0_x64-setup.exe)

## 说明

- 内置主脚本编辑器及 Monaco 依赖已删除，脚本通过路径配置并由外部编辑器维护。
- 解释器选择与参数模板编辑已改为弹层交互，以降低主页面焦点与滚动干扰。
- 任务配置和任务运行已拆分，动态参数在运行区填写并记住最近值。

## 动态参数 2.0 自测（2026-07-14）

- 前端测试：`13 passed`，覆盖参数同步、数字范围、枚举、布尔、路径、密码控件和提交 payload
- Rust 测试：`24 passed`，覆盖默认值、非有限数字、选项校验、可选空值和敏感参数脱敏
- 数据库隔离迁移：schema version `3`，`task_runtime_parameters` 创建成功
- MCP stdio 自测：schema `3`、数字元数据、Token 元数据、默认值和预览脱敏均通过
- 桌面 E2E：动态默认值实际解析为 `workers=12 quality=1080p enabled=false`
- 桌面 E2E 同时复核成功运行、重试、超时、并发拒绝、异常恢复和替换旧实例
- 正式用户数据库在后端与桌面测试前后保持不变
- 最大化窗口视觉检查通过：任务列表、配置列、运行列和动态参数弹窗均使用内部滚动，无穿模或字体遮挡

本轮先在隔离目录完成发布验证；旧窗口关闭后，已经重新生成默认发布产物：

- [新版 Release](E:\ScriptWorkbench\src-tauri\target\release\script-workbench.exe)
- [新版 NSIS 安装包](E:\ScriptWorkbench\src-tauri\target\release\bundle\nsis\Script%20Workbench_0.1.0_x64-setup.exe)
- [动态参数页面截图](E:\ScriptWorkbench\artifacts\dynamic_params_build\dynamic-parameters-ui-fixed.png)
- [动态参数配置弹窗截图](E:\ScriptWorkbench\artifacts\dynamic_params_build\dynamic-parameters-modal.png)

## Schema v4 结构化参数自测（2026-07-14）

- 前端测试：`16 passed`；Rust 测试：`38 passed`
- 前端测试覆盖扫描预览、参数启停、常用/高级分组、条件字段、派生字段与结构化草稿确认
- Rust 测试覆盖 argparse、Click、Typer、sidecar、`--help` 补扫及对应 golden fixture
- 结构化 argv 测试覆盖空值整项省略、正向/反向布尔、重复参数、互斥组、条件显示和联合校验
- 数据库迁移验证 schema `3 → 4`，旧 Python 配置保持 `template`，正式 4 个任务及 15 条运行记录均保留
- MCP 隔离自测验证 schema `4`、扫描来源、结构化 argv、默认值和 Token 脱敏
- 桌面 E2E 验证 ComicBox 章节为空时省略 `--chapters`，ID 同步生成 URL 与输出目录
- 桌面 E2E 验证视频 ID、播放页 URL、本地 HTML 三种模式，以及正向开关不生成两个反向 flag
- 视觉截图：[Schema v4 扫描预览](E:\ScriptWorkbench\artifacts\schema_v4_visual\03_scan_modal_final.png)
- 正式迁移前备份：`C:\Users\Lmoon\AppData\Roaming\com.lmoon.scriptworkbench\workbench.sqlite.pre-schema-v4-20260714.bak`
