# 更新日志（Changelog）

本项目的全部重要变更都记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **热会话接管**（实验性，设置页开关，默认关）：到期时若 VS Code 侧仍持有该会话（热），确认转写静默 ≥10 分钟后，只结束其专属持有进程（命令行精确带 `--resume=<sid>`，绝不碰共享组件）→ 正常续跑 → `vscode://` URI 复活会话界面 + 系统通知。基于真机实验：持有进程死亡后扩展不会自动重启、接管轮单链落盘无分叉、URI 复活后进程重读转写血统不破。开关关闭（默认）维持既有退避行为；挂机不聊的会话无专属进程、天然是冷的，两种模式下都直接续跑。热持有未静默时推迟 5 分钟再探且不烧尝试次数

### 计划中

- Windows 真机验证（安装 → 托盘 → 自启 → 登记 → 限额 → 自动续跑全链）
- 阶段四：安全加固、兼容性扩展与发布
- 已知待修：测试夹具 `limitFrame` 的 `error` 为字符串形状，`frameText` 提取不到（生产路径走 assistant+isApiErrorMessage 分支不受影响，但 `enforceLimitCheck` 路径零测试覆盖、smoke 因此失败）

## [0.1.1] - 2026-10-25

### Added

- Windows 客户端（Tauri v2 壳 + 同一 bun 单文件 sidecar）：数据目录 `%APPDATA%\noidle-resume`、自启动走注册表、NSIS currentUser 安装（简中/英文）
- Windows 冷会话守卫：PowerShell CIM 枚举进程命令行（WQL 服务端过滤 + 参数白名单防注入），探测失败仍按热持有保守拒跑
- Windows 续跑引擎：`where` 落地解析（exe 优先）、npm shim（.cmd/.bat）经 `cmd /d /s /c` 包装与 MSVCRT 引号转义
- 转写路径等值判定 `samePath`：Windows 大小写不敏感 + 分隔符归一（转写定位、登记核验、发现去重三处共用）
- `scripts/build-sidecar.mjs`（`npm run build:sidecar[:win]`）：bun 单文件编译 sidecar，支持从 mac/linux 交叉编译 Windows exe
- GitHub Actions 双平台构建（`.github/workflows/build.yml`）：macOS 出 .dmg、Windows 出 NSIS exe，两平台都跑全量测试；打 tag `v*` 或手动触发
- WS 可靠性四层防线（修复值守台页面冻结在旧快照）：事件总线全局单调 `seq` + WS 20s 心跳（连接即发对齐帧）+ `GET /api/v1/revision` 对账端点 + 前端看门狗（45s 无帧判半开重连）/20s 对账轮询/重连与回前台补拉快照；任务与会话变更同步刷新审计面板

### Fixed

- 值守台页面自首次加载后不再更新（macOS 挂起隐藏窗口 + WS 半开连接叠加导致冻结一晚）：重连/回前台/对账三条补快照路径 + 心跳探活，界面最大陈旧时间封顶 20s

### Changed

- tauri.conf.json 拆分平台配置：`tauri.macos.conf.json`（app+dmg）与 `tauri.windows.conf.json`（nsis + icon.ico）
- 桌面壳数据目录按平台分派（与 `config.ts defaultDataDir` 注释互链，两处同源）；Unix 信号收割限定 macOS/Linux（`signal-hook` 改为 unix-only 依赖）
- 迁移目录定位改用 `fileURLToPath`（修复 Windows 下 `URL.pathname` 的 `/C:/...` 形态）；legacy 数据目录搬迁限定 macOS

## [0.1.0] - 2026-10-24

首个公开发行版。

### Added

- 限额自动检测：监控 VS Code 侧边栏 Claude Code 会话转写中的 `api_error` 帧，按配置时区解析重置时刻
- 自动续跑引擎：重置后以 headless CLI 续跑会话；以转写落盘 + 血统核验为结算事实源，进程异常退场不影响判定
- 会话登记：自动扫描转写根最近 24 小时会话（`entrypoint=claude-vscode`），下拉选择即守护，支持粘贴限额原文自动解析
- Web 值守台（Vue3 深色值守室）：总览 / 会话 / 任务详情 / 设置与日志四页
- 任务引擎：SQLite 持久化（WAL + 迁移）、串行调度、指数退避、崩溃对账、同会话单活动任务约束
- 本地 API + WebSocket 实时推送（`task.changed` / `event.detected` / `session.changed`）
- Mac 托盘壳（Tauri v2）：单文件 sidecar、菜单栏常驻、拉起/收割服务、开机自启
- 安全基线：仅监听 `127.0.0.1`、令牌门 + HttpOnly Cookie、CSRF 防护、日志脱敏
- 测试基建：61 项单元 + 集成测试、冒烟脚本、真浏览器 E2E 全链 13 步（假引擎，零真额度）

[Unreleased]: https://github.com/NoIdleAI/noidle-resume/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/NoIdleAI/noidle-resume/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/NoIdleAI/noidle-resume/releases/tag/v0.1.0
