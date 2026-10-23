# NoIdle Auto Resume

GLM Coding Plan 5 小时限额到点后，自动续跑 VS Code 侧边栏 Claude Code 会话的**本地独立小工具**。

设计书：《../限额恢复设计方案01.md》（2026-10-23 真机定案版）。与 NoIdle Orbit 无从属关系。

## 当前进度

- ✅ 阶段一：技术验证收官（URI 判死 / 转写=事件源 / CLI headless 续跑 / 冷热矩阵，见设计书附录 A）
- 🚧 **阶段二：本地后台与任务引擎（本仓库当前交付）**
  - SQLite 持久化（WAL + 迁移）、会话白名单、限额解析、任务状态机、串行调度、取消与重启对账、本地 API + WebSocket
- ⬜ 阶段三：Web 管理页面（视觉稿已定版：`../原型图/auto-resume-01.html`）
- ⬜ 阶段四：安全、兼容性与发布

## 快速开始

```bash
npm install
npm run dev        # 启动本地服务（默认 127.0.0.1:7842）
npm test           # 单元 + 集成测试（零真模型调用）
npm run smoke      # 冒烟：起真服务走 API 全链（假恢复引擎）
npm run typecheck
```

启动后控制台打印本机访问令牌（也存于数据目录 `token.txt`，0600）：

```bash
curl -H "Authorization: Bearer <token>" http://127.0.0.1:7842/api/v1/health
```

环境变量：`CAR_DATA_DIR`（数据目录）、`CAR_PROJECTS_ROOT`（转写根，默认 `~/.claude/projects`）、`CAR_CLAUDE_BIN`、`CAR_HOST`、`CAR_PORT`。

## 核心机制（与设计书对位）

| 机制 | 实现位置 |
| --- | --- |
| 限额事件源 = 转写 `api_error` 帧（§6.1） | `modules/limit/detector.ts` + `modules/watcher/` |
| 重置时刻按配置时区解析（§6.3） | `modules/limit/timezone.ts` |
| 冷会话守卫 `pgrep --resume=<sid>`（§5.1-11） | `modules/resume/coldGuard.ts` |
| headless 续跑引擎（§2.3） | `modules/resume/runner.ts` |
| 叶血统核验，禁文件级启发（§5.1-13） | `modules/resume/transcript.ts` |
| 串行调度 + 指数退避（§6.3/§7） | `modules/scheduler/` |
| 崩溃对账单位=叶，结果不明即 paused（§7.3） | `scheduler.reconcileOnBoot()` |
| 同会话单活动任务（§7.3） | 部分唯一索引 `idx_tasks_active` |

## 安全红线（§11）

- 只监听 `127.0.0.1`；令牌鉴权；写操作 CSRF 防护（自定义头 + Origin/Host 校验）
- 恢复引擎显式 `--permission-mode default`，**绝不使用** `--dangerously-skip-permissions`
- 未登记会话的事件一概不落库；日志脱敏截断
- 会话由工具续跑后即「已接管」，展示以工具自有面为准，侧边栏视为只读发源地

## 目录

```
apps/server/          本地服务（Fastify + SQLite + 任务引擎）
packages/contracts/   前后端共享类型与错误码
migrations/           SQLite 迁移
tests/                单元 + 集成测试（fake-claude 假引擎）
scripts/              fake-claude.mjs（测试假引擎）、smoke.mjs（冒烟）
```
