# Script Workbench

`Script Workbench` 是一个基于 `Tauri 2 + React + TypeScript + Rust + SQLite` 的 Windows 脚本工作台，用来管理、编辑、预览并运行 Python 脚本和通用命令任务。

当前版本已经实现这些主链：

- 任务库：`Python 任务` 和 `原始命令任务`
- 任务编辑：解释器、脚本路径、参数模板、工作目录、环境变量、标签、备注
- Schema v4 结构化参数：Python 脚本按 sidecar → 静态 AST → 用户确认后的 `--help` → 模板占位符扫描
- CLI 框架扫描：首版覆盖 argparse、Click 与 Typer，扫描结果确认后直接构造 argv 数组
- 运行控件：支持常用/高级分组、条件显示、派生字段、正反向布尔、重复参数、文件/目录和敏感输入
- 脚本变化检测：保存 SHA-256 与扫描快照，显示新增、删除、类型及默认值差异，保留人工锁定项
- 参数规则：支持显示名称、说明、必填、默认值、枚举选项、数字最小值和最大值
- 敏感参数：密码与 Token 只传给当前子进程，不写入命令预览、上次参数或运行历史
- 命令预览：实时显示最终执行命令
- 内置终端：所有输出都回流到软件内部，不额外弹出系统终端
- 运行历史：保存命令快照、状态、退出码和日志文件路径
- 脚本配置：选择 Python 入口脚本并通过外部编辑器维护源码
- 解释器管理：支持默认解释器、外部解释器和健康检查
- Bundled Python：支持检测 bundled 运行时状态，并从本机 `python.exe` 安装到应用自管目录
- 工作区备份：支持导出/导入任务、解释器和全局设置的 JSON 备份
- 资源定位：可直接打开工作目录、定位脚本文件、定位 stdout/stderr 日志
- 运行重放：可从运行记录页直接重跑原任务
- 列表筛选：任务库支持按关键字/类型/收藏筛选，运行记录支持按关键字/状态筛选
- 运行可靠性：每个任务可配置超时、失败重试、重试间隔和并发策略
- 进程树托管：使用 Windows Job Object 统一停止主进程和全部子进程
- 输出编码：任务可选择 UTF-8 或 GBK，流式输出不会因分块破坏多字节字符
- 异常恢复：应用重启后自动把遗留运行标记为 interrupted，并补全耗时和终止原因

## 开发环境

已验证前端可直接构建：

```powershell
cmd /c npm install
cmd /c npm run build
```

Tauri/Rust 侧需要本机具备 Rust 工具链。如果还没有：

```powershell
winget install --id Rustlang.Rust.MSVC -e --accept-package-agreements --accept-source-agreements
```

如果后续 `cargo` 仍不可用，再补装 Visual Studio Build Tools：

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-package-agreements --accept-source-agreements
```

## 常用命令

前端开发：

```powershell
cmd /c npm run dev
```

Tauri 桌面开发：

```powershell
cmd /c npm run tauri dev
```

前端生产构建：

```powershell
cmd /c npm run build
```

Tauri 打包：

```powershell
cmd /c npm run tauri build
```

## 数据位置

应用运行后会在 Tauri 的 `app_data_dir` 下创建：

- `workbench.sqlite`：任务、解释器、设置、运行记录索引
- `logs/`：每次运行的 `stdout/stderr` 日志

## 当前约束

- 首版只支持 `Windows`
- 终端为“内置输出面板”，不支持交互式 `stdin`
- 当前 bundled Python 采用“应用自管目录”方案，安装后会落到 `app_data_dir/bundled-python/`
- 如果未来要把 bundled Python 直接随安装包分发，仍可把运行时资源放到 `src-tauri/resources/python/`

## 可靠性自测

后端和桌面 smoke 测试必须使用隔离数据目录，不能写入真实 `%APPDATA%` 工作区：

```powershell
cmd /c npm run test
scripts\tauri-env.cmd cargo test --manifest-path src-tauri\Cargo.toml
python scripts/selftest_backend.py
python scripts/selftest_mcp.py
python scripts/selftest_smoke.py
```

`selftest_backend.py` 会验证 schema v4、隔离数据库路径，并使用 SHA-256 确认真实用户数据库在测试前后没有变化。`selftest_mcp.py` 会验证模板/结构化预览、扫描元数据、默认值、条件规则和敏感值脱敏；`selftest_smoke.py` 会从真实桌面 UI 验证 ComicBox 空章节、省略规则、视频三种来源模式和可靠性策略。
