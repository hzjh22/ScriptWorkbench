# Script Workbench 项目书

## 1. 项目概述

### 1.1 项目名称

`Script Workbench`

### 1.2 项目定位

`Script Workbench` 是一款面向高级用户 / 开发者的 Windows 桌面脚本工作台，用来管理、编辑、预览并运行：

- Python 脚本任务
- 原始命令任务

它不是传统“快捷方式启动器”，而是一个具备产品化界面的本地任务管理器，重点解决：

- 大量脚本的集中管理
- 参数可视化编辑
- 最终命令预览
- 应用内运行与日志回流
- 解释器管理
- 工作区备份与恢复

### 1.3 当前交付形态

当前项目已经具备以下交付物：

- 调试版可执行文件：
  [src-tauri/target/debug/script-workbench.exe](E:\ScriptWorkbench\src-tauri\target\debug\script-workbench.exe)
- 发布版可执行文件：
  [src-tauri/target/release/script-workbench.exe](E:\ScriptWorkbench\src-tauri\target\release\script-workbench.exe)
- Windows 安装包：
  [src-tauri/target/release/bundle/nsis/Script Workbench_0.1.0_x64-setup.exe](E:\ScriptWorkbench\src-tauri\target\release\bundle\nsis\Script%20Workbench_0.1.0_x64-setup.exe)

---

## 2. 目标与原则

### 2.1 目标

项目的直接目标是把命令行启动的 Python 脚本和命令任务提升为可视化产品：

- 支持保存和切换任务
- 支持修改参数、路径、解释器、环境变量
- 支持预览最终命令
- 支持在软件内部运行并查看输出
- 支持后续扩展为正式上架软件

### 2.2 设计原则

- Windows 优先
- 本地优先，不依赖云端
- 内置终端优先，不弹外部终端
- 解释器与脚本解耦
- UI 可产品化，不走工具脚本界面
- 避免复杂桌面原生控件崩溃风险，优先使用可控的 React 组件

---

## 3. 技术选型

### 3.1 前端

- `React 19`
- `TypeScript`
- `Vite 7`

前端负责：

- 页面结构
- 任务编辑
- 运行记录展示
- 解释器与 bundled Python 管理界面
- 工作区导入导出

### 3.2 桌面容器

- `Tauri 2`

Tauri 负责：

- 桌面窗口
- 前后端桥接
- 文件/目录选择
- 本地资源打包
- NSIS 安装包构建

### 3.3 后端

- `Rust`
- `Tokio`
- `Serde`
- `Rusqlite`
- `Chrono`
- `Uuid`

Rust 后端负责：

- SQLite 数据读写
- 进程启动 / 停止
- stdout / stderr 收集
- 任务日志落盘
- bundled Python 检测与安装

### 3.4 数据存储

- `SQLite`：任务、解释器、设置、运行记录索引
- 文本日志文件：stdout / stderr
- JSON：工作区备份与恢复

### 3.5 测试

- `Vitest`
- `@testing-library/react`
- `@testing-library/user-event`
- Python 自测脚本

---

## 4. 目录结构

### 4.1 顶层结构

```text
E:\ScriptWorkbench
├─ .cargo/                     Rust 工具链与 linker 配置
├─ artifacts/                  自测截图、报告、临时证据
├─ android-client/             Android 手机端客户端工程
├─ fixtures/                   自测用脚本与测试素材
├─ public/                     前端静态资源
├─ scripts/                    构建辅助、自测脚本
├─ src/                        React 前端
├─ src-tauri/                  Tauri/Rust 后端
├─ toolchains/                 llvm-mingw 工具链
├─ README.md                   项目基础说明
├─ SELFTEST_REPORT.md          自测报告摘要
└─ PROJECT_BOOK.md             本项目书
```

### 4.2 关键文件

- 前端主界面：
  [src/App.tsx](E:\ScriptWorkbench\src\App.tsx)
- 前端类型定义：
  [src/types.ts](E:\ScriptWorkbench\src\types.ts)
- 前端 API 封装：
  [src/lib/api.ts](E:\ScriptWorkbench\src\lib\api.ts)
- 前端样式：
  [src/styles.css](E:\ScriptWorkbench\src\styles.css)
- 前端交互自测：
  [src/App.selftest.test.tsx](E:\ScriptWorkbench\src\App.selftest.test.tsx)
- Rust 后端：
  [src-tauri/src/lib.rs](E:\ScriptWorkbench\src-tauri\src\lib.rs)
- Tauri 入口：
  [src-tauri/src/main.rs](E:\ScriptWorkbench\src-tauri\src\main.rs)
- Tauri 配置：
  [src-tauri/tauri.conf.json](E:\ScriptWorkbench\src-tauri\tauri.conf.json)
- 打包环境脚本：
  [scripts/tauri-env.cmd](E:\ScriptWorkbench\scripts\tauri-env.cmd)
- 后端自测：
  [scripts/selftest_backend.py](E:\ScriptWorkbench\scripts\selftest_backend.py)
- 历史 smoke 自测：
  [scripts/selftest_smoke.py](E:\ScriptWorkbench\scripts\selftest_smoke.py)
- Python fixture：
  [fixtures/selftest_python_task.py](E:\ScriptWorkbench\fixtures\selftest_python_task.py)

---

## 5. 架构设计

### 5.1 总体结构

```text
React UI
  ↓
Tauri invoke / event
  ↓
Rust backend
  ├─ SQLite
  ├─ log files
  ├─ process runner
  └─ bundled python manager
```

### 5.2 页面结构

应用分为 4 个主区：

- `概览`
- `任务库`
- `运行记录`
- `设置`

### 5.3 数据模型

核心模型包括：

- `Task`
- `PythonTaskConfig`
- `CommandTaskConfig`
- `InterpreterProfile`
- `RunRecord`
- `RuntimeValues`
- `AppSettings`

### 5.4 运行模型

Python 任务：

```text
解释器 + 脚本路径 + 参数模板 + 本次运行参数 + 工作目录 + 环境变量
```

命令任务：

```text
完整命令模板 + 本次运行参数 + 工作目录 + 环境变量
```

所有运行都在应用内完成，不额外弹出系统终端。

---

## 6. 已实现功能

### 6.1 任务管理

- 新建 Python 任务
- 新建命令任务
- 编辑任务名称
- 编辑标签
- 编辑工作目录
- 编辑环境变量
- 收藏任务
- 删除任务
- 任务搜索、类型筛选、收藏筛选

### 6.2 Python 任务功能

- 选择解释器
- 选择脚本路径
- 编辑参数模板
- 预览最终命令
- 定位脚本文件

### 6.3 命令任务功能

- 编辑完整命令
- 预览最终命令

### 6.4 运行与日志

- 一键运行任务
- 内置终端显示输出
- stdout/stderr 分流
- 停止运行
- 清空终端视图
- 运行记录列表
- 运行详情展示
- 从运行记录重跑
- 定位 stdout / stderr 日志
- 打开运行工作目录

### 6.5 解释器管理

- 系统 Python 检测
- Bundled Python 检测
- 默认解释器管理
- 外部解释器添加与删除
- 健康检查

### 6.6 Bundled Python

- 项目资源目录内置精简基础 Python
- 应用首次启动可识别 bundled runtime
- 支持从本机 `python.exe` 安装到应用自管目录
- 当前默认策略：
  `System Python` 为默认解释器，`Bundled Python` 作为备用或分发运行时

### 6.7 脚本维护

- 应用负责选择入口脚本、配置解释器与运行参数
- 源码维护交给用户已有的外部编辑器
- 内置 Monaco 主脚本编辑器已删除，减少包体、焦点冲突和文件覆盖风险

### 6.8 导入导出

- 支持导入命令为任务
- 支持工作区 JSON 导出
- 支持工作区 JSON 导入

### 6.9 动态运行参数与任务分栏

- 任务页保留任务列表，并将“任务配置”和“任务运行”拆成独立区域
- 任务页顶部提供粘性的“开始运行”按钮，深度滚动后仍可操作
- 切换任务时工作区自动返回顶部
- 同一任务允许创建多个并发运行实例，每个实例拥有独立 Run ID 和 stdout/stderr 日志
- 运行记录可按 Run ID 单独停止某个实例
- 并发运行使用相同动态参数时，脚本业务输出路径可能相同；应用不擅自改写用户脚本的输出目录
- Python 参数模板与普通命令支持 `{{变量名}}` 占位符
- 同名变量可在 URL、Windows 路径和文件名中重复使用
- 运行区自动生成输入框，缺少必填值时禁止启动
- 本次输入不会覆盖通用任务模板
- 每个任务记住最近一次运行输入
- 运行记录保存实际参数快照，历史重跑使用原参数
- 旧数据库启动时自动增加运行参数表和快照字段

ComicBox 通用模板示例：

```text
--book-url https://www.comicbox.xyz/book/{{book_id}} --output F:\CIL\conmic\comicbox_{{book_id}}_backup --delay 0 --workers 12 --quiet-pages
```

运行时只需输入一次 `book_id`，URL 和输出目录中的编号会同步替换。

---

## 7. 自测体系

### 7.1 自测目标

当前自测目标不是“只要能编译”，而是要求至少覆盖：

- 前端交互主链
- 后端 / 运行时主链
- 调试构建
- 发布构建
- 安装包产物

### 7.2 已通过的自测命令

```powershell
cmd /c npm run build
cmd /c npm run test
python scripts/selftest_backend.py
cmd /c npm run tauri build -- --debug --no-bundle
cmd /c npm run tauri build -- --bundles nsis
```

### 7.3 前端交互测试覆盖

测试文件：
[src/App.selftest.test.tsx](E:\ScriptWorkbench\src\App.selftest.test.tsx)

已验证：

- 任务列表加载
- 任务详情加载
- 解释器选择弹层
- 选择 `Bundled Python`
- 参数模板编辑弹层
- 应用参数模板
- 保存任务 payload 正确
- 点击运行任务会触发 `startRun`
- ComicBox 的 `book_id` 可同时替换 URL 与输出路径
- 动态输入值会作为 `runtimeValues` 发送到运行接口
- 安全文本输入统一通过 `textContent` 同步状态
- 导出工作区会调用 `writeTextFile`
- 导入工作区会调用 `readTextFile` 和 `saveSettings`
- 收藏切换不会导致页面异常
- 设置页 `停止运行前确认` 切换不会导致页面异常

### 7.4 后端 / 运行时自测覆盖

脚本：
[scripts/selftest_backend.py](E:\ScriptWorkbench\scripts\selftest_backend.py)

报告：
[artifacts/backend_selftest_report.json](E:\ScriptWorkbench\artifacts\backend_selftest_report.json)

已验证：

- 首次启动创建 `workbench.sqlite`
- 自动种子数据写入
- 系统解释器可用
- bundled 资源解释器可用
- 命令执行 smoke 可用
- release exe 存在
- installer 存在

---

## 8. 已修复的关键问题

### 8.1 参数模板误填整条命令

问题：

用户把整条 PowerShell 命令连同：

- `python`
- 脚本路径
- 反引号续行符 `` ` ``

一起填进“参数模板”，导致 `argparse` 报：

```text
unrecognized arguments: python F:\...
```

修复 / 结论：

- 明确区分“解释器 / 脚本路径 / 参数模板”
- 参数模板只接受 `--xxx` 参数部分

### 8.2 解释器选择和参数模板编辑白屏

问题：

- 原生 `select`
- 原生 `textarea`
- 当时常驻挂载的 `Monaco`
- 页面整体滚动

共同导致任务编辑区在某些输入场景下出现白屏或焦点错乱。

修复：

- 原生 `select` 改为自定义交互
- 解释器改成弹层选择
- 参数模板改成弹层编辑
- 后续版本彻底删除内置 Monaco 编辑器
- 滚动从整页切换为应用内部滚动
- 单行输入字段改成安全单行编辑组件

### 8.3 原生 checkbox 导致的白屏

问题：

- 点击“收藏”
- 点击“仅收藏”
- 点击设置页中的 `停止运行前确认`

时，页面仍可能出现白屏。

根因：

- 这些位置仍残留原生 `checkbox`
- 与当前 Tauri/WebView 的焦点和滚动链组合后表现不稳定

修复：

- 统一改为 `SafeToggle`
- 不再依赖原生 `checkbox`
- 同时补充前端交互测试覆盖

### 8.4 主脚本编辑器影响任务表单输入

问题：

`Monaco` 在任务编辑页同层常驻时，会干扰普通表单输入。

最终修复：

- 删除主脚本编辑器组件和自动保存逻辑
- 删除脚本读写与文件修改检测 Tauri 命令
- 移除 Monaco 前端依赖
- 应用继续保存脚本路径并正常运行脚本，源码改用外部编辑器维护

### 8.5 状态更新不安全

问题：

任务编辑时，曾存在在 `setDraftTask` 更新器内部又调用 `setTaskDirty` 的写法。

风险：

- React 状态更新顺序异常
- 不稳定重渲染

修复：

- 把脏状态更新移到更新器外部

### 8.6 自测脚本会误触旧窗口 / 被遮挡窗口

问题：

桌面坐标自动化容易被：

- 旧进程
- 被遮挡窗口
- 桌面焦点切换

影响，导致结果不可靠。

修复：

- 每轮测试前杀掉旧进程
- 固定窗口尺寸与位置
- 把关键交互迁移到前端组件测试

### 8.7 Bundled Python 包过大导致打包卡顿

问题：

把完整 `Python311` 目录直接打进安装包会极大拖慢 NSIS 打包。

修复：

- 发布资源中只保留精简基础运行时
- 完整环境如有需要，通过应用内“安装 bundled Python”再写入 `app_data_dir`

### 8.8 构建工具链问题

踩过的问题包括：

- Rust 未安装
- GNU / gnullvm 工具链差异
- `dlltool` / `clang` / `windres` 缺失
- 绝对路径迁移到 `E:` 盘后 linker 路径失效

修复：

- 引入 `llvm-mingw`
- 固定 `.cargo/config.toml`
- 使用 `scripts/tauri-env.cmd` 包装 PATH

### 8.9 动态参数输入后不回显

现象：

- 切换到带 `{{book_id}}` 的任务后立即输入 `5101`
- 输入内容短暂出现后被清空，运行按钮仍提示参数未填写

原因：

- 运行参数表单先于“最近一次运行值”的异步查询完成而显示
- 用户输入后，稍晚返回的空查询结果执行 `setRuntimeValues({})`，覆盖刚输入的状态

修复：

- 增加运行参数加载状态
- 查询完成前只显示“正在读取上次运行参数”，不渲染可编辑输入框
- 查询完成后再开放输入和运行按钮
- 增加延迟查询回归测试，验证 `5101` 保持回显并发送到 `startRun`

---

## 9. 踩坑记录

### 9.1 Windows PowerShell 输出乱码

现象：

PowerShell 某些 `Get-Content` 输出里，中文会显示为乱码。

说明：

- 这是终端编码层问题
- 不等于源码文件本身损坏
- 实际源文件仍然是 UTF-8 可用内容

### 9.2 前端测试与生产构建共用 TypeScript

现象：

测试文件中使用 `Array.prototype.at`，会导致生产 `tsc` 失败。

修复：

- 改成兼容写法
- 保证测试文件不会拖垮生产构建

### 9.3 Vitest mock hoist 规则

现象：

`vi.mock` 工厂函数不能直接捕获普通顶层变量。

修复：

- 改用 `vi.hoisted(...)` 声明 mock 容器

### 9.4 UI 自动化不适合作为唯一真相来源

经验：

- 桌面坐标点击非常脆弱
- React 组件级测试更稳定
- 最可靠的链路应该是：
  前端交互测试 + 后端自测 + 构建验证 + 安装包验证

---

## 10. 构建与打包

### 10.1 常用命令

```powershell
cmd /c npm install
cmd /c npm run build
cmd /c npm run test
cmd /c npm run tauri build -- --debug --no-bundle
cmd /c npm run tauri build -- --bundles nsis
```

### 10.2 构建辅助

脚本：
[scripts/tauri-env.cmd](E:\ScriptWorkbench\scripts\tauri-env.cmd)

作用：

- 自动把 `llvm-mingw` 和 `cargo` 加入 PATH
- 避免每次手工设置环境变量

后端自测通过 `SCRIPT_WORKBENCH_DATA_DIR` 使用隔离数据目录，禁止清理真实用户的 `app_data_dir`。

### 10.3 Tauri 配置

配置文件：
[src-tauri/tauri.conf.json](E:\ScriptWorkbench\src-tauri\tauri.conf.json)

关键点：

- 产品名：`Script Workbench`
- 标识符：`com.lmoon.scriptworkbench`
- 初始窗口大小：`1560 x 980`
- 打包资源：`resources/python/**/*`

---

## 11. 当前交付范围

### 11.1 已交付

- 可运行的桌面应用
- 可构建的 release 可执行文件
- 可生成的 NSIS 安装包
- 项目说明文档
- 自测脚本与自测报告

### 11.2 当前运行策略

- 首版只支持 Windows
- 所有任务都在内置终端显示输出
- 不支持交互式 stdin shell
- 默认解释器为 `System Python`
- `Bundled Python` 可用但不强制默认

### 11.3 建议后续迭代

- 动态参数的数字、路径、下拉框等字段类型配置
- 更稳定的桌面端 E2E 自动化
- 安装后的版本升级与迁移策略
- 日志搜索 / 清理策略的 UI 化
- 导入命令时自动识别更多 PowerShell 粘贴格式

---

## 12. MCP 结构化调试

新增本地 MCP 服务：
[scripts/script_workbench_mcp.py](E:\ScriptWorkbench\scripts\script_workbench_mcp.py)

使用说明：
[MCP_DEBUG_GUIDE.md](E:\ScriptWorkbench\MCP_DEBUG_GUIDE.md)

该服务直接连接 `workbench.sqlite`、运行记录和日志，不依赖截图、OCR 或坐标点击。它支持检查任务配置、解析动态参数、生成最终命令、执行限时探测和读取正式运行日志。

本轮通过 MCP 定位并修复了“视频源摘要”任务模板：旧模板只传 `--video-id`，但脚本要求 `--watch-url` 或 `--input-html`。新模板会由一个 `video_id` 同时生成播放页 URL 和显式 ID：

```text
--watch-url https://hanime1.me/watch?v={{video_id}} --video-id {{video_id}}
```

旧数据库启动后会自动迁移，不要求用户手工编辑任务。

内置终端的停止按钮也会显示实际绑定的任务名，例如 `停止「ComicBox 备份」`，避免用户编辑其他任务时误停后台任务。成功任务写入 stderr 的 curl 进度会标为“进程信息（stderr）”，不再暗示运行失败。

---

## 13. 交付结论

当前项目已经完成以下层面的交付：

- 架构层：前后端结构完整
- 功能层：核心脚本工作台功能可用
- 构建层：开发构建、发布构建、安装包构建可通过
- 自测层：前端交互测试与后端自测已落地并通过
- 文档层：README、自测报告、项目书齐备

如果未来继续迭代，这份 `PROJECT_BOOK.md` 可以作为：

- 产品技术说明
- 交接文档
- 开发与测试参考
- 后续版本演进基础

---

## 14. 运行可靠性增强（2026-07-13）

- 数据库引入 `schema_migrations`；可靠性版本为 `2`，动态参数 2.0 阶段 schema version 为 `3`（当前结构化参数版本为 `4`）
- 任务增加超时、重试次数、重试间隔、并发策略和输出编码
- 并发策略支持允许并发、拒绝新实例、停止旧实例
- Windows 子进程统一加入 Job Object，停止或应用退出时清理完整进程树
- 运行记录增加 `attempt_count` 与 `termination_reason`
- 超时最终状态为 `timed_out`，应用异常退出恢复状态为 `interrupted`
- stdout/stderr 改为增量解码，支持 UTF-8 与 GBK
- MCP 可读取 schema version、任务可靠性策略、尝试次数和终止原因
- 所有后端与桌面自测使用隔离数据目录，不再停止用户正在运行的正式进程
- `selftest_backend.py` 会对真实数据库进行测试前后哈希校验

---

## 15. 动态参数 2.0（2026-07-14）

- 参数模板中的 `{{变量名}}` 会按出现顺序自动生成运行控件，同名占位符只生成一次
- 旧任务没有参数元数据时，自动按“必填文本”兼容，不需要手工迁移
- 每个参数可配置显示名称、说明、类型、必填、默认值、选项以及数字范围
- 控件类型支持文本、数字、布尔开关、下拉选项、文件、目录和密码/Token
- 前端即时校验与 Rust 后端校验使用相同规则，绕过 UI 也不能提交非法范围或非法选项
- 敏感参数不会保存到 `task_runtime_values`、`run_records.runtime_values_json` 或命令预览
- 数据库新增 `task_runtime_parameters`，schema version 升级为 `3`
- 工作区备份版本升级为 `3`；旧备份缺少参数元数据时仍能导入
- MCP 的 `inspect_task` 返回完整动态参数定义，`preview_task` 支持默认值并对敏感值脱敏

---

## 16. 脚本扫描与结构化运行控件（Schema v4，2026-07-14）

- Python 任务增加 `argumentMode: template | structured`；旧任务与旧备份保持模板模式
- 扫描顺序为 `{脚本名}.workbench.json`、静态 AST、用户确认后的 `--help`、模板占位符兜底
- 静态扫描覆盖 argparse、Click、Typer；目标脚本只被 AST 读取，不被导入
- `--help` 补扫使用无窗口进程、3 秒超时和 Windows Job Object
- 结构化 argv 支持位置参数、always、when_non_empty、when_true、when_false、repeat、条件和派生模板
- 联合校验支持条件必填、至少选择一个、互斥、数值范围、枚举和重复项计数
- 运行控件采用“常用参数 + 高级设置折叠”，显示来源、可信度、分组、派生值和人工锁定状态
- 脚本 SHA-256 变化后展示新增、删除、类型变化及默认值变化；重新扫描时人工锁定配置继续沿用
- ComicBox 扫描生成漫画 ID、派生 URL、可覆盖输出目录、可空章节范围和高级下载参数
- 视频摘要扫描生成 ID/URL/HTML 来源模式、Cookie 敏感输入、网络模式、输出目录预览与反向布尔开关
- 数据库和工作区备份版本升级为 4；v3 数据原样保留，导入后默认模板模式
- MCP 返回参数模式、扫描来源、参数组、argv 规则、脚本变化状态，并按相同规则生成脱敏预览

---

## 17. 当前项目结构快照（2026-07-14）

本节记录当前代码结构；前面的章节保留产品演进与历史设计背景。

```text
E:\ScriptWorkbench
├─ src/                              React 前端
│  ├─ App.tsx                        页面编排、任务/运行状态、终端路由
│  ├─ App.selftest.test.tsx          前端主链路回归测试
│  ├─ styles.css                     桌面布局、滚动区和响应式样式
│  ├─ types.ts                       前后端共享数据类型
│  ├─ components/
│  │  ├─ AppErrorBoundary.tsx        页面错误边界
│  │  ├─ RuntimeParameterFields.tsx  结构化运行控件
│  │  ├─ RuntimeParameterEditor.tsx  参数元数据编辑器
│  │  ├─ SafeFields.tsx              WebView 稳定输入、开关和长文本滚动
│  │  └─ ScriptScanPreviewModal.tsx  脚本扫描结果确认
│  └─ lib/
│     ├─ api.ts                       Tauri invoke API
│     ├─ runtimeParameters.ts         参数派生、条件与前端校验
│     └─ taskUtils.ts                 任务默认值、克隆和兼容迁移
├─ src-tauri/
│  ├─ src/lib.rs                      Tauri 命令注册与运行编排
│  ├─ src/database.rs                 SQLite Schema v4 与迁移
│  ├─ src/python_scanner.rs           Python 参数扫描与业务表单增强
│  ├─ src/python_scan_helper.py       argparse/Click/Typer AST 扫描器
│  ├─ src/structured_arguments.rs     结构化 argv 构造与联合校验
│  ├─ src/runtime_parameters.rs       后端参数校验、默认值与脱敏
│  ├─ src/runtime_policy.rs           超时、重试和并发策略
│  ├─ src/process_control.rs          Windows Job Object 进程树控制
│  ├─ src/output_decode.rs            UTF-8/GBK 增量输出解码
│  ├─ src/run_recovery.rs             异常退出后的运行状态恢复
│  ├─ src/command_template.rs         命令模板解析与参数替换
│  └─ src/backup_files.rs             工作区备份文件校验
├─ scripts/
│  ├─ selftest_backend.py             隔离数据库和运行时自测
│  ├─ selftest_mcp.py                 MCP 协议与脱敏预览自测
│  ├─ selftest_smoke.py               桌面 E2E 自测
│  ├─ script_workbench_mcp.py         本地 MCP 调试服务
│  └─ tauri-env.cmd                   Windows Rust/Tauri 构建环境
├─ fixtures/                          扫描、结构化 argv 和运行测试样本
├─ artifacts/                         自测报告、截图与隔离构建产物
├─ src-tauri/resources/python/        精简 bundled Python
├─ README.md
├─ SELFTEST_REPORT.md
├─ MCP_DEBUG_GUIDE.md
└─ PROJECT_BOOK.md
```

### 17.1 前端职责

- `App.tsx` 维护任务草稿、运行参数、运行记录、按任务隔离的终端上下文和页面路由。
- `RuntimeParameterFields` 按参数定义生成文本、数字、布尔、枚举、文件、目录、重复项和敏感输入控件。
- `ScriptScanPreviewModal` 在扫描结果写入任务前展示来源、可信度、参数组、argv 规则和变化摘要。
- `SafeFields` 统一处理 WebView 中的单行输入、粘贴、长 URL 横向滚动和安全开关。
- `styles.css` 负责三栏任务页、列内独立滚动、窄栏单列运行表单和高 DPI 布局约束。

### 17.2 后端职责

- SQLite 保存任务、解释器、可靠性策略、结构化参数、运行快照和日志索引。
- 每次运行拥有独立 Run ID、stdout/stderr 文件、状态、尝试次数和终止原因。
- Python 任务使用 `-u` 并默认注入 `PYTHONIOENCODING=utf-8`，避免 Windows 重定向输出继承 ANSI/GBK 后在 Unicode 文本处中断。
- Windows 子进程加入 Job Object；停止、超时、替换旧实例和应用退出均按完整进程树处理。
- 扫描器静态读取 Python 源码；经用户确认后可执行限时 `--help` 补扫。
- MCP 直接读取数据库和运行日志，可检查任务、生成脱敏命令预览和执行限时探测。

---

## 18. 当前功能基线（2026-07-14）

### 18.1 任务与配置

- 新建、编辑、删除、收藏和筛选 Python/命令任务
- 解释器选择、脚本定位、工作目录和环境变量配置
- 模板参数与结构化参数两种运行模式
- 工作区 JSON v4 导入导出
- 脚本变化检测、重新扫描、人工锁定字段保留

### 18.2 结构化运行表单

- argparse、Click、Typer、sidecar 和 `--help` 参数来源
- 文本、数字、布尔、枚举、文件、目录、敏感值和重复参数
- 默认值、必填、范围、选项、条件显示、互斥、至少选择一项
- 派生 URL/路径、可覆盖派生值、正向和反向布尔 flag
- 敏感值参与本次进程参数，但从历史值、运行快照和命令预览中脱敏

### 18.3 运行可靠性

- 允许并发、拒绝新实例、停止旧实例三种并发策略
- 超时、重试次数、重试间隔和独立停止
- 运行状态：`running`、`finished`、`failed`、`stopped`、`timed_out`、`interrupted`
- 应用启动时恢复异常中断记录
- UTF-8/GBK 增量日志解码及 Python UTF-8 输出环境

### 18.4 终端与运行记录

- stdout/stderr 分流、复制、清空、日志定位和工作目录打开
- 终端缓冲区和磁盘日志均按 Run ID 隔离
- 前端使用 `activeRunByTask[taskId]` 保存每个任务当前查看的运行实例
- 切换任务时同步切换终端；不会继续展示上一任务的活动实例
- 同一任务最近 8 个运行实例可在终端顶部按 Run ID 切换
- 从运行记录打开终端时同步定位对应任务，并加载已有磁盘日志

---

## 19. 任务运行页布局修复（2026-07-14）

问题表现：在 Windows 高 DPI、显示缩放或任务运行栏较窄时，双列运行参数会越过右侧边界，Output、Timeout、布尔开关及说明文字显示不完整。

修复内容：

- 任务配置/运行两列比例由 `1.05 / 0.95` 调整为 `0.95 / 1.05`，优先给运行栏更多宽度。
- 所有工作台面板、运行参数容器和参数字段增加 `width/max-width/min-width` 边界。
- 文件/目录选择行改为 `minmax(0, 1fr) auto`，长路径只在输入区内部滚动。
- 任务运行列启用 CSS Container Query；可用宽度不超过 `680px` 时，运行参数自动切换为单列。
- 窄窗口下配置区与运行区改为统一纵向滚动，避免两个 `height: 100%` 区块互相覆盖。
- 长 URL 输入保留水平滚动条、滚轮横向浏览和悬停完整值。

视觉验证：

- 修复后截图：[artifacts/layout_selftest/task-run-layout-dpi.png](E:\ScriptWorkbench\artifacts\layout_selftest\task-run-layout-dpi.png)
- 运行参数已完整收纳在右侧面板内，URL、Output、Work Dir、数字字段和说明文字均未越界。
- 任务列表、配置列和运行列仍保持各自的垂直滚动区域。

---

## 20. 当前自测与发布基线（2026-07-14）

- 前端 Vitest：`6` 个测试文件，`23 passed`
- Rust：`39 passed`
- 后端隔离自测：Schema version `4`，真实用户数据库测试前后保持不变
- MCP 自测：结构化参数、默认值、AST 来源和敏感参数脱敏通过
- TypeScript + Vite 生产构建通过
- Tauri Release 构建通过
- NSIS 安装包构建通过

当前标准产物：

- [Release](E:\ScriptWorkbench\src-tauri\target\release\script-workbench.exe)
- [NSIS 安装包](E:\ScriptWorkbench\src-tauri\target\release\bundle\nsis\Script%20Workbench_0.1.0_x64-setup.exe)

---

## 21. Telegram 备份脚本专用适配（2026-07-14）

- 为 argparse 脚本增加专用 sidecar 运行表单，可在不改动脚本主体的情况下覆盖通用 AST 推断结果。
- 表单提供“消息链接”和“实体 / 对话”两种目标模式，并按条件切换链接、链接文件、实体、消息 ID 和历史数量字段。
- 多个 Telegram 链接使用 repeat 规则逐行生成位置参数。
- 动作、媒体类型、分组消息和登录方式使用带中文业务标签的选择控件。
- 下载目录、Session、链接列表和检查结果 JSON 使用目录/文件选择控件。
- Proxy、连接超时、并发数、分块大小、API ID 和 Dry Run 收入高级设置。
- API Hash 使用 `secret` 类型；参与本次进程调用但不写入历史值和命令预览。
- 联合校验覆盖目标必填、实体必填、链接数量、历史数量、超时、并发数和分块范围。
- 正式任务使用 `reject` 并发策略，避免多个进程同时占用同一 Telethon Session。
- 已通过 Tauri 实际扫描验证：来源 `sidecar`、`21` 个参数、`20` 条 argv 规则、`7` 条联合校验。
- 已通过链接模式 Dry Run：状态 `finished`、退出码 `0`，stdout 正确输出实体与消息 ID。
- 已验证实体模式命令预览仅生成实体相关参数，并正确生成 `--no-proxy`、`--json-out` 等条件参数。

相关文件：

- 专用表单：`F:\CIL\tg_backup.workbench.json`
- 使用文档：`F:\CIL\TG_BACKUP_USAGE.md`
- UI 验证截图：[artifacts/tg_sidecar_selftest/tg-sidecar-form.png](E:\ScriptWorkbench\artifacts\tg_sidecar_selftest\tg-sidecar-form.png)

---

## 22. Telegram 并行下载可靠性修复（2026-07-14）

问题根因与速度差异：

- `F:\CIL\tg_backup.py` 的并行 MTProto Sender 原先使用 `auto_reconnect=False` 和 `retries=0`；连接读取 8 字节传输头时发生 EOF 后，Fast mode 立即退出。
- `asyncio.gather` 抛出第一个 worker 异常时，其余 worker 未显式取消和回收，产生 `Future exception was never retrieved`。
- 软件内失败运行在约 1.26% 后进入 Telethon 单连接 fallback，速度约 0.9–0.98 MB/s；PowerShell 运行仍处于 4-worker Fast mode，速度约 3.22 MB/s。差异来自下载路径，不是 Script Workbench 的终端管道限速。

脚本修复：

- Fast Sender 改为自动重连并设置 5 次重连。
- 分块读取对 `IncompleteReadError`、超时、连接错误和系统网络错误执行指数退避重试。
- worker 改为显式 `asyncio.Task`；失败时取消并通过 `return_exceptions=True` 回收全部任务。
- Fast mode 完成前核对真实累计接收字节数，防止预分配稀疏 `.part` 被误判为完成。
- Fast mode 回退后重连主 TelegramClient、重新读取消息并刷新 document/file reference。
- 标准下载最多重试 3 次；顺序下载达到预期文件大小时可接收 Telethon 收尾阶段的空返回或连接异常。
- 隐藏 Telethon 已自动恢复的逐次 socket EOF warning，保留最终连接错误和脚本自身 retry/fallback 输出。

备份与验证：

- 修改前备份：`F:\CIL\tg_backup.py.pre-reconnect-20260714-205321.bak`
- `python -m py_compile F:\CIL\tg_backup.py`：通过
- Sidecar 等价参数 Dry Run：通过
- 故障注入测试：`5 passed`，覆盖分块 EOF 重试、其他 worker 取消回收、完整文件空返回、完整文件收尾异常、半文件失败后重连重试
- 真实下载：238.92 MB，4 workers × 512 KB，67.66 秒，末次 3.74 MB/s，退出码 0，stderr 0 字节
- 两次独立下载 SHA-256 一致：`14E6FE0EB3F6A5812980D47BDE3C7492A0B1A93EC143BAC81A96C5C09AF0A692`
- MP4 顶层 atom 校验：`ftyp + mdat + moov`，边界精确结束于 EOF

验证资料：

- `E:\ScriptWorkbench\artifacts\test_tg_download_resilience.py`
- `E:\ScriptWorkbench\artifacts\tg_network_quiet_selftest\summary.json`
- `E:\ScriptWorkbench\artifacts\tg_network_quiet_selftest\stdout.log`
- `E:\ScriptWorkbench\artifacts\tg_network_quiet_selftest\stderr.log`


---

## 23. 漫画并发运行临时目录隔离修复（2026-07-14）

执行日志分析：

- 漫画任务的运行策略是 `allow`，用户在短时间内启动的多个图集确实同时执行。
- 所有进程原先共同使用 `F:\CIL\conmic\临时` 下相同的 `raw`、`pages`、`render` 和临时 PDF。
- 任一成功任务会删除整个共享临时目录；其他仍在运行的任务则继续读取被覆盖、混入或删除的页面。
- 最近一批失败中主要出现 7 次“标准化页面数大于目标页数”、3 次渲染图与源图 MAE 异常，以及 1 次输出已存在被记为失败，均与共享目录和旧的存在文件处理有关。

脚本修复：

- `--work-dir` 现在表示临时根目录，每个运行建立 `wnacg_{aid}_{pid}` 隔离子目录。
- 页面列表按目标页码 `0001..N` 精确构造，不再把目录中的额外 JPG 计入当前图集。
- PDF 先写入本次隔离目录的 staging 文件；页数、元数据和 Poppler 渲染全部通过后才发布到正式输出路径。
- `Overwrite` 未选且输出已存在时输出 `[跳过]` 并以退出码 0 结束，不再把正常跳过记录成失败。
- 同时生成同一个输出时，在发布前再次检查目标文件。

备份与数据处理：

- 修改前脚本：`F:\CIL\wnacg_backup_to_pdf.py.pre-concurrency-20260714-215105.bak`
- 3 个在旧共享目录条件下生成但未通过渲染验证的 PDF 已保留到：`F:\CIL\conmic\failed-verification-backup-20260714-2151`

并发真实自测：

- 同时启动 aid `368173`、`343308`、`271232`，共用同一个 `--work-dir` 根目录。
- 三个进程分别建立独立子目录，最终全部完成，stderr 均为 0 字节。
- PDF 页数分别为 `33/33`、`34/34`、`34/34`，Poppler 逐页渲染校验全部通过。
- 已存在输出再次执行时状态为正常跳过，退出码 0，且未创建临时子目录。
- 验证报告：`E:\ScriptWorkbench\artifacts\wnacg_concurrency_selftest\report.json`


---

## 24. 漫画多 URL 批量输入与换行修复（2026-07-14）

需求与问题：

- 漫画任务的 URL 控件扩展为多行输入，每行一个 URL，单次最多 100 个。
- 首版表单虽然视觉上显示两行，但 `SafeMultilineInput` 使用 DOM `textContent` 读取 contenteditable；Chromium 对分行的子元素返回拼接文本，两个 URL 因而变成一个连续字符串。
- 错误命令表现为 `...219161.htmlhttps://...265303.html`，脚本只能从拼接字符串中解析第一个 aid。

前端修复：

- `SafeMultilineInput` 改用 `innerText` 读写，保留 contenteditable 的视觉换行。
- 粘贴内容统一保留 `\n`，并增加 `role=textbox`、`aria-multiline=true` 和字段 aria-label。
- 新增回归测试，验证 repeat 参数将两个视觉行保存为带换行的运行值。

漫画脚本与专用表单：

- `wnacg_backup_to_pdf.py` 的位置参数改为 `URL [URL ...]`。
- 批量任务按输入顺序执行；单项失败后记录异常并继续后续 URL，结尾输出 finished/skipped/failed 汇总。
- 批量输出要求目录；每个图集仍使用独立 staging 和隔离临时目录。
- 专用 sidecar：`F:\CIL\wnacg_backup_to_pdf.workbench.json`。
- Sidecar 包含 11 个参数、11 条 argv 规则和 5 条联合校验；URL 使用 repeat 规则逐行生成独立位置参数。

实机验证：

- Release 软件运行 ID：`769e250f-1f6f-4b52-8d91-6248a4eef125`。
- 命令快照中两个 URL 之间为独立 argv：`...219161.html ...265303.html`。
- 运行值 JSON 保留 `\n`，脚本分别输出 `[批量 1/2]` 和 `[批量 2/2]`。
- 实际结果：一个已有 PDF 正常跳过，一个完成 31 页下载、PDF 生成及 Poppler 逐页验证；汇总为 finished 1、skipped 1、failed 0，退出码 0。

当前验证与发布：

- 前端 Vitest：`24 passed`
- Rust：`39 passed`
- TypeScript/Vite 生产构建通过
- Tauri Release、MSI、NSIS 构建通过
- Release SHA-256：`37192FE42F119915FAF9386907C37424C20547907691A050D05FDFE2DA11FD69`
- NSIS SHA-256：`0F7674F889C829B6FD27E6F147E49A60822200B0FE4ED1B936A36BC765699B19`
- MSI SHA-256：`18CF4EBE1CCCAEF6D44CCA1E1EA9A5523C8CB5F53F812E3E8EDAD26874482EBC`

发布文件：

- `E:\ScriptWorkbench\src-tauri\target\release\script-workbench.exe`
- `E:\ScriptWorkbench\src-tauri\target\release\bundle\nsis\Script Workbench_0.1.0_x64-setup.exe`
- `E:\ScriptWorkbench\src-tauri\target\release\bundle\msi\Script Workbench_0.1.0_x64_en-US.msi`

---

## 25. 漫画任务 Telegraph / Telegraph Clone 站点适配（2026-07-16）

需求：漫画任务原先主要面向 WNACG `photos-slide-aid-*` 页面，本次扩展到用户提供的两个页面来源：

- `https://telegra.ph/...-08-14`
- `https://139-59-122-31.sslip.io/assets/telegraph_clone/.../index_hmlfmh.html?v=...`

脚本改进：

- 主脚本：`F:\CIL\wnacg_backup_to_pdf.py`。
- 保留 WNACG 原流程，同时新增通用 HTML 图集解析流程：抓取页面 `<img>`，支持 `src`、`data-src`、`data-original`、`data-lazy-src` 等常见懒加载字段。
- Telegraph / Telegraph Clone 图片链接会基于页面 URL 自动补全相对路径，并按页面顺序去重。
- 非 WNACG URL 使用稳定 `gallery_id`：由 host、页面路径和短 SHA 组成，用于隔离临时目录与 PDF 文件名，避免不同站点标题重名冲突。
- `request_get` 增加 host 级网络 fallback：环境代理请求失败后，对该 host 自动切换直连；本次 `139-59-122-31.sslip.io` 已触发并验证该逻辑。
- 批量 URL 能继续按输入顺序执行，单个 URL 失败会记录异常并继续后续 URL，结尾输出 `finished/skipped/failed` 汇总。

专用表单 / sidecar：

- Sidecar：`F:\CIL\wnacg_backup_to_pdf.workbench.json`。
- 任务描述已更新为支持 `WNACG / Telegraph / Telegraph Clone`。
- URL 字段继续使用 repeat 规则，每行一个 URL，单次最多 100 个；生成命令时每一行都是独立位置参数，不会拼接成一个 URL。
- 已同步当前软件数据库中的漫画任务结构化参数、规则、校验与脚本哈希。

命令行真实下载验证：

- 验证目录：`E:\ScriptWorkbench\artifacts\telegraph_site_selftest`。
- Telegraph 页面：检出 48 页，PDF 生成与 Poppler 逐页渲染校验通过。
  - PDF SHA-256：`067db95505cf5a02f1bd49c5f13c716a0824ed8f97f6db8bc198df33f7adabab`
  - `max_mean_absolute_error: 24.2193`
- Telegraph Clone 页面：检出 35 页，PDF 生成与 Poppler 逐页渲染校验通过。
  - PDF SHA-256：`042f442b6db8ffb3e8f959a600e72e3e4a3aec0ddc82c94698ca496f8d6886a2`
  - `max_mean_absolute_error: 21.145`
- 批量汇总：`batch_total=2`、`finished=2`、`skipped=0`、`failed=0`、退出码 `0`。

软件实机验证：

- 验证脚本：`E:\ScriptWorkbench\artifacts\telegraph_desktop_e2e.py`。
- 验证报告：`E:\ScriptWorkbench\artifacts\telegraph_desktop_e2e\report.json`。
- Release 软件启动后通过 UI 顶部运行按钮触发漫画任务，运行 ID：`992afa44-b26e-441c-b0ae-90291af0df25`。
- 命令快照中两个 URL 为独立 argv，且运行值 JSON 中保留 `\n`：
  - 出现 `[批量 1/2]` 和 `[批量 2/2]`。
  - 汇总：`batch_total=2`、`failed=0`。
  - 本轮因命令行验证产物已存在，软件实机运行结果为 `skipped=2`、退出码 `0`，证明软件表单到脚本 argv 的多 URL 链路正确。

当前验证与发布：

- `F:\node\npm.cmd test`：6 个测试文件、24 项测试通过。
- `F:\node\npm.cmd run build`：TypeScript / Vite 生产构建通过。
- `E:\ScriptWorkbench\scripts\tauri-env.cmd cargo test`：Rust 39 项测试通过。
- `F:\node\npm.cmd run tauri -- build`：Release、MSI、NSIS 构建通过。
- 发布文件：
  - `E:\ScriptWorkbench\src-tauri\target\release\script-workbench.exe`
  - `E:\ScriptWorkbench\src-tauri\target\release\bundle\nsis\Script Workbench_0.1.0_x64-setup.exe`
  - `E:\ScriptWorkbench\src-tauri\target\release\bundle\msi\Script Workbench_0.1.0_x64_en-US.msi`
- SHA-256：
  - 脚本：`4FF0E732F05950A9953E3155A9A9DB31B056D7E8988DE5E49A9C9B22A663F350`
  - Release EXE：`0F8D5E8607E3739585DB757239E1BCF824F745414D8BD1D69D49DD02D2F48F4B`
  - NSIS：`D6477D652D6DD599048ABCA56E0183197E9B3388AFD434831206387FA9918CCD`
  - MSI：`8597C69F8F53DA08ECDC903276DE671B71C3C1C37FE872EC7195583EB66794BC`

---

## 26. WNACG 图片列表正则热修复（2026-07-21）

问题：用户提供 `https://www.wnacg.com/photos-slide-aid-370897.html` 后，检查发现该站点类型本身已在漫画任务中支持，但 `F:\CIL\wnacg_backup_to_pdf.py` 的 WNACG `page_url` 图片列表正则少了一层反斜杠转义，运行时报 `unterminated character set at position 16`，导致 WNACG 分支无法解析图片列表。

修复：

- 修复 WNACG 图片 URL 提取正则，将字符集里的反斜杠正确写为 `[^"\\]`。
- 修改前备份：`F:\CIL\wnacg_backup_to_pdf.py.pre-wnacg-regex-20260721-001.bak`。
- 更新 sidecar 脚本哈希：`F:\CIL\wnacg_backup_to_pdf.workbench.json`。
- 同步软件数据库中的漫画任务 `python_task_configs.script_hash`，数据库备份：`C:\Users\Lmoon\AppData\Roaming\com.lmoon.scriptworkbench\workbench.sqlite.pre-wnacg-regex-20260721-221108.bak`。

验证：

- `D:\python\Python311\python.exe -m py_compile F:\CIL\wnacg_backup_to_pdf.py` 通过。
- 对 aid `370897` 调用元数据解析成功：标题为 `[只野めざし] 田舎の人妻たち + メロンブックス まんがリーフレット + とらのあな 4Pリーフレット`，解析到 `251` 页，首图为 `https://img5.qy0.ru/data/3708/97/001.webp`。
- 使用已存在输出文件执行跳过链路验证，脚本退出码 `0`，stdout 出现 `[1/5] 读取图集信息：id=370897` 和 `[跳过] 输出已存在`。

当前脚本 SHA-256：`F0EB526D3673A41A86A72BFDB4EA5D9D96582205152F80227B2F453D89D1E5E9`。

---

## 27. Telegram QR 登录在软件内显示过大的修复（2026-07-25）

问题：`F:\CIL\tg_backup.py` 在 QR 登录时会同时输出二维码 PNG 路径、`tg://login?...` 链接和终端 ASCII 二维码。Script Workbench 的 stdout 区域不是交互式终端，大块 ASCII 二维码会撑出横向/纵向滚动条，导致用户在软件内看起来像二维码显示不全。

修复：

- 主脚本：`F:\CIL\tg_backup.py`。
- 新增参数 `--qr-ascii {auto,always,never}`：
  - `auto`：仅在 stdout 是交互式终端时打印 ASCII 二维码。
  - `always`：强制打印终端二维码。
  - `never`：只输出 QR 图片路径和登录链接。
- 新增环境变量覆盖：`TG_BACKUP_QR_ASCII=1/0/always/never`。
- 软件内 Telegram 任务已新增高级参数“二维码终端预览”，默认 `never`，启动命令会追加 `--qr-ascii never`。
- 原始脚本备份：`F:\CIL\tg_backup.py.pre-qr-stdout-20260725-001.bak`。
- 数据库备份：`C:\Users\Lmoon\AppData\Roaming\com.lmoon.scriptworkbench\workbench.sqlite.pre-tg-qr-stdout-20260725-203407.bak`。

验证：

- `D:\python\Python311\python.exe -m py_compile F:\CIL\tg_backup.py` 通过。
- `D:\python\Python311\python.exe F:\CIL\tg_backup.py --help` 已显示 `--qr-ascii {auto,always,never}`。
- 在非交互式 stdout 下，`should_render_qr_ascii('auto') == False`，`render_qr_ascii(..., 'auto')` 输出字符数为 `0`。
- 当前脚本 SHA-256：`110062E8F055B854ECA4D5451774D89B1C974684DAD1706F60DBC883608CF97B`。

使用方式：在软件里登录 Telegram 时，直接打开 stdout 中显示的 `QR image: F:\CIL\tg_backup.qr.png`，用手机 Telegram 的“设备 / Link Desktop Device”扫描；stdout 不再显示大块 ASCII 二维码。

---

## 28. Telegram QR 扫码后不继续登录的原因分析与修复（2026-07-25）

现象：用户在软件内运行 Telegram 媒体备份任务，stdout 显示 `Scan this QR with Telegram mobile app`，扫码后没有进入后续下载。读取最近运行记录发现最新 Run ID `42eadc73-f028-4728-accd-b1430d33905d` 仍处于 `running`，stdout 连续出现 `QR expired, creating a new one...`，说明 Telethon 一直没有收到 Telegram 手机端确认登录事件。

原因判断：

- 脚本此前每次都覆盖同一个固定二维码路径：`F:\CIL\tg_backup.qr.png`。
- Windows 图片查看器可能缓存已打开图片，用户看似打开了同一路径，实际扫描的是旧二维码；Telegram QR token 约 120 秒过期，旧图扫码后不会让脚本继续。
- Telegram 手机端扫码入口必须是 `Settings -> Devices -> Link Desktop Device`，扫码后还要确认登录提示。
- 如果账号开启 Two-Step Verification，QR 接受后还需要二步验证密码；在 Script Workbench 的非交互运行环境里不能用 `getpass()` 阻塞等待输入。

修复：

- 主脚本：`F:\CIL\tg_backup.py`。
- `save_qr_png()` 改为每次同时保存：
  - 唯一二维码文件：`tg_backup.qr.YYYYMMDD-HHMMSS.NNN.<token_hash>.png`
  - 最新覆盖文件：`tg_backup.qr.png`
- stdout 新增 `QR attempt`、`QR image`、`QR latest image`、手机端扫码路径和确认提示，要求优先打开唯一二维码文件，避免扫旧图。
- QR 被 Telegram 接受后输出 `QR login accepted by Telegram.`。
- 新增 `--two-step-password-env`，默认读取环境变量 `TG_BACKUP_2FA_PASSWORD`；非交互环境遇到二步验证时输出明确错误，不再静默卡住。
- 修改前备份：`F:\CIL\tg_backup.py.pre-qr-unique-20260725-001.bak`。
- 数据库备份：`C:\Users\Lmoon\AppData\Roaming\com.lmoon.scriptworkbench\workbench.sqlite.pre-tg-qr-unique-20260725-204314.bak`。

验证：

- `D:\python\Python311\python.exe -m py_compile F:\CIL\tg_backup.py` 通过。
- `--help` 已显示 `--qr-ascii` 和 `--two-step-password-env`。
- 自测生成唯一二维码和 latest 二维码均存在，且路径不同。
- 非交互环境未设置二步验证密码时，`read_two_step_password()` 会返回明确 RuntimeError。
- 当前脚本 SHA-256：`7C3C7A84DFF9ED810459270B25DCB047B2F64EA54F294F1529A525DCDBB764DB`。

---

## 29. Telegram QR 登录内嵌显示与运行记录输出区放大（2026-07-25）

需求：用户反馈 Telegram QR 登录流程过于费劲，希望不要只在 stdout 中显示路径，而是在软件中直接显示二维码，并放大运行记录中的 Stdout 显示面积。

前端修改：

- 修改文件：`E:\ScriptWorkbench\src\App.tsx`。
- 新增 `TerminalOutputView`，在 stdout 中自动识别：
  - `QR image: F:\...\*.png`
  - `QR latest image: F:\...\*.png`
  - 兼容旧日志中的 `WindowsPath('F:/...png')` 输出。
- 检出 QR 图片后，使用 Tauri `convertFileSrc()` 转为 asset URL，在软件内直接渲染二维码图片。
- 二维码卡片显示：扫码说明、图片路径、二维码预览和“打开二维码图片”按钮。
- 内置终端和运行记录详情均使用新的输出组件。

样式修改：

- 修改文件：`E:\ScriptWorkbench\src\styles.css`。
- 新增 `.qr-preview-card`、`.qr-preview-image`、`.terminal-output-wrap` 等样式。
- 运行记录详情输出区使用 `.run-record-terminal-grid`，改为单列显示。
- 运行记录中的 stdout/stderr 区域从原先较小的 `220~320px` 扩展为 `min-height: 360px; max-height: 58vh`。

Tauri 配置：

- 修改文件：`E:\ScriptWorkbench\src-tauri\tauri.conf.json`。
- 开启 `app.security.assetProtocol`，允许前端 `<img>` 加载本地二维码图片。
- 当前 scope：
  - `F:\CIL\**`
  - `E:\ScriptWorkbench\**`

验证：

- `F:\node\npm.cmd test`：6 个测试文件、24 项测试通过。
- `F:\node\npm.cmd run build`：TypeScript / Vite 生产构建通过。
- `F:\node\npm.cmd run tauri -- build`：Release、MSI、NSIS 构建通过。

发布产物：

- Release：`E:\ScriptWorkbench\src-tauri\target\release\script-workbench.exe`
  - SHA-256：`762F7C4208C81B0FA583E5497B776B79E0723C8EACE7C3E2B620E18C0FEC5967`
- NSIS：`E:\ScriptWorkbench\src-tauri\target\release\bundle\nsis\Script Workbench_0.1.0_x64-setup.exe`
  - SHA-256：`174506D20BC0CF6151CF7C3F692427A7D56F3CA407027C12BB1529CAEA0E8C47`
- MSI：`E:\ScriptWorkbench\src-tauri\target\release\bundle\msi\Script Workbench_0.1.0_x64_en-US.msi`
  - SHA-256：`2617FA533704E8148526335F17CDB9D47BB1AE79546594A2C3CAB7CCEC74A9AE`

备份：

- `E:\ScriptWorkbench\src\App.tsx.pre-qr-inline-20260725-001.bak`
- `E:\ScriptWorkbench\src\styles.css.pre-qr-inline-20260725-001.bak`
- `E:\ScriptWorkbench\src-tauri\tauri.conf.json.pre-qr-asset-20260725-001.bak`

---

## 30. 移动端 API 与 Android 客户端 V1（2026-08-16）

目标：在不打乱现有 Windows 桌面端代码结构的前提下，新增“电脑执行、手机遥控和下载”的移动端能力。

桌面端新增：

- 新增后端模块：`E:\ScriptWorkbench\src-tauri\src\api_server.rs`。
- 使用嵌入式 HTTP 服务提供局域网 API，默认关闭，由设置页手动启用。
- 新增设置页“移动端连接”卡片，可配置启用状态、监听地址、端口，显示访问地址和 6 位配对码。
- 数据库 schema 升级到 v5，新增：
  - `mobile_api_settings`
  - `mobile_file_index`
- 配对流程为 `POST /api/pair`，手机端用配对码换取 Bearer Token。
- 已实现 API：
  - `GET /api/health`
  - `POST /api/pair`
  - `GET /api/tasks`
  - `GET /api/tasks/{task_id}`
  - `POST /api/tasks/{task_id}/run`
  - `GET /api/runs`
  - `GET /api/runs/{run_id}`
  - `GET /api/runs/{run_id}/output`
  - `GET /api/runs/{run_id}/stream`
  - `POST /api/runs/{run_id}/stop`
  - `GET /api/runs/{run_id}/files`
  - `GET /api/files/{file_id}/download`
- 文件下载支持 HTTP Range，输出文件通过 file_id 映射真实路径，不把本机路径作为下载参数。
- 运行日志同时发送给桌面 Tauri event 和移动端 SSE 事件流。

Android 客户端：

- 新增独立目录：`E:\ScriptWorkbench\android-client`。
- 当前为零外部依赖的原生 Android Java 客户端，避免本机 Kotlin/Compose Gradle 插件下载阻塞。
- 功能包含：
  - 输入电脑 API 地址和配对码
  - 保存 Token
  - 查看任务列表
  - 启动任务
  - 查看运行记录
  - 读取 stdout/stderr
  - 查看运行产物
  - 通过系统 DownloadManager 下载文件到 `Downloads/ScriptWorkbench`
- Android Manifest 已开启局域网 HTTP 访问所需的 `INTERNET` 和 `usesCleartextTraffic`。

实现文件：

- `E:\ScriptWorkbench\src-tauri\src\api_server.rs`
- `E:\ScriptWorkbench\src-tauri\src\database.rs`
- `E:\ScriptWorkbench\src-tauri\src\lib.rs`
- `E:\ScriptWorkbench\src\App.tsx`
- `E:\ScriptWorkbench\src\types.ts`
- `E:\ScriptWorkbench\src\lib\api.ts`
- `E:\ScriptWorkbench\android-client\app\src\main\java\com\lmoon\scriptworkbench\mobile\MainActivity.java`

验证：

- `E:\ScriptWorkbench\scripts\tauri-env.cmd cargo test`：41 项 Rust 测试通过。
- `F:\node\npm.cmd test`：6 个测试文件、28 项前端测试通过。
- `F:\node\npm.cmd run build`：TypeScript / Vite 生产构建通过。
- `F:\node\npm.cmd run tauri -- build`：Release、MSI、NSIS 构建通过。

Android 构建状态：

- 本机存在 Gradle：`D:\download\document\IDEA\.gradle\wrapper\dists\gradle-9.2.1-bin\...\gradle.bat`。
- 本机缓存存在 Android Gradle Plugin `9.0.1`。
- `assembleDebug --offline` 当前阻塞于 AGP 自身依赖缺失：`kotlin-reflect-2.2.20.jar` 和 `kotlin-stdlib-2.2.20.jar` 未缓存。
- 在线 `assembleDebug --info --stacktrace` 卡在 Maven 依赖解析阶段，未进入 Java 编译。
- 因此本轮 Android 源码已落地，但 debug APK 还需要完成 Gradle/AGP 依赖下载后再构建。

发布产物：

- Release：`E:\ScriptWorkbench\src-tauri\target\release\script-workbench.exe`
  - SHA-256：`137C29AFF14A78F97396DC9BFB16BD4DF9D12D6045AD180FC1B9375285117B05`
- NSIS：`E:\ScriptWorkbench\src-tauri\target\release\bundle\nsis\Script Workbench_0.1.0_x64-setup.exe`
  - SHA-256：`61ACCCBDB3B816842F7F1822D7F22A673F13D8D5C1F61F4EE32B80BBDC78404D`
- MSI：`E:\ScriptWorkbench\src-tauri\target\release\bundle\msi\Script Workbench_0.1.0_x64_en-US.msi`
  - SHA-256：`7B03156C7DE1869CDB33DC0D849FCC58B6FDC3A06A2F5474B6F92ECE67E483C7`
