# 更新日志（Changelog）

本项目的全部重要变更都记录在本文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 阶段四：安全加固、兼容性扩展与发布

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

[Unreleased]: https://github.com/NoIdleAI/noidle-resume/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/NoIdleAI/noidle-resume/releases/tag/v0.1.0
