# NoIdle Auto Resume

GLM Coding Plan 5 小时限额到点后，自动续跑 VS Code 侧边栏 Claude Code 会话的**本地独立小工具**。

设计书：《../限额恢复设计方案01.md》（2026-10-23 真机定案版）。与 NoIdle Orbit 无从属关系。

## 当前进度

- ✅ 阶段一：技术验证收官（URI 判死 / 转写=事件源 / CLI headless 续跑 / 冷热矩阵，见设计书附录 A）
- ✅ 阶段二：本地后台与任务引擎
  - SQLite 持久化（WAL + 迁移）、会话白名单、限额解析、任务状态机、串行调度、取消与重启对账、本地 API + WebSocket
- 🚧 **阶段三：Web 管理页面（本仓库当前交付）**
  - Vue3 + Vite 管理面（`apps/web`），视觉语言照定版原型稿 `../原型图/auto-resume-01.html`（深色值守室 · 暖珊瑚单强调 · 等宽承载数据）
  - 四页：总览（主任务卡=倒计时/5h 窗口/证据块/五步时间线 + 白名单 + 日志尾）、会话（登记/开关/移除/人工登记限额）、任务详情（§10.3 六问）、设置与日志
  - 登记不必手抠 UUID：自动扫描本机转写根近 24 小时会话做自绘下拉，选中即填充；标题与侧边栏同源（转写 `ai-title` 帧 > summary > 首条用户消息），工作区取帧内 cwd 与核验同源
  - 实时推送：WS `task.changed` / `event.detected` / `session.changed`；令牌门登录 → HttpOnly Cookie（WS 同源免头）
  - 服务端直接托管 `apps/web/dist`（`npm run build` 后单进程即可用）；开发态 `npm run dev:web`（vite 代理 /api 与 WS）
  - 新增 API：`POST /api/v1/tasks/:id/pause`；cancel 支持搁置 paused/failed
  - 验收：59/59 单元+集成测试 + `scripts/e2e-web.mjs` 真浏览器 E2E 全链 12 步（门→下拉发现→登记→启用→限额→值守→恢复→详情→设置→转写事实，零真额度）
- ⬜ 阶段四：安全、兼容性与发布

## 快速开始

```bash
npm install
npm run build      # 构建前端到 apps/web/dist
npm start          # 启动本地服务（默认 127.0.0.1:7842，直接托管管理页）
npm test           # 单元 + 集成测试（零真模型调用）
npm run smoke      # 冒烟：起真服务走 API 全链（假恢复引擎）
npm run dev        # 仅后端开发态
npm run dev:web    # 前端开发态（vite :5173，代理 /api 到 7842）
node scripts/e2e-web.mjs   # Web 管理面真浏览器 E2E（需系统 Chrome，零真额度）
npm run typecheck
```

启动后控制台打印本机访问令牌（也存于数据目录 `token.txt`，0600）。浏览器打开 `http://127.0.0.1:7842`，粘贴令牌进入值守台。

环境变量：`CAR_DATA_DIR`（数据目录）、`CAR_PROJECTS_ROOT`（转写根，默认 `~/.claude/projects`）、`CAR_CLAUDE_BIN`、`CAR_HOST`、`CAR_PORT`。

演练模式：把 `CAR_PROJECTS_ROOT` 指向真实转写根并配假引擎时，给假引擎加 `CAR_FAKE_NOWRITE=1`（`scripts/fake-claude.mjs` 只输出成功结果、绝不向转写落帧，叶核验会诚实失败）。注意 `@fastify/static` 在启动时挂静态路由——**重建 dist 后需重启进程**。

## 核心机制（与设计书对位）

| 机制 | 实现位置 |
| --- | --- |
| 限额事件源 = 转写 `api_error` 帧（§6.1） | `modules/limit/detector.ts` + `modules/watcher/` |
| 登记下拉 = 只读扫描转写根最近会话（`entrypoint=claude-vscode` 才收，不入库） | `modules/discover/discoveryService.ts` |
| 重置时刻按配置时区解析（§6.3） | `modules/limit/timezone.ts` |
| 冷会话守卫 `pgrep --resume=<sid>`（§5.1-11） | `modules/resume/coldGuard.ts` |
| headless 续跑引擎（§2.3） | `modules/resume/runner.ts` |
| 叶血统核验，禁文件级启发（§5.1-13） | `modules/resume/transcript.ts` |
| 串行调度 + 指数退避（§6.3/§7） | `modules/scheduler/` |
| 崩溃对账单位=叶，结果不明即 paused（§7.3） | `scheduler.reconcileOnBoot()` |
| 同会话单活动任务（§7.3） | 部分唯一索引 `idx_tasks_active` |
| 倒计时只在展示层动态计算（§10.1） | `apps/web/src/stores/ticker.ts` |
| 任务详情回答六问（§10.3） | `apps/web/src/pages/TaskDetailPage.vue` |

## 安全红线（§11）

- 只监听 `127.0.0.1`；令牌鉴权；写操作 CSRF 防护（自定义头 + Origin/Host 校验）
- 恢复引擎显式 `--permission-mode default`，**绝不使用** `--dangerously-skip-permissions`
- 未登记会话的事件一概不落库；日志脱敏截断
- 会话由工具续跑后即「已接管」，展示以工具自有面为准，侧边栏视为只读发源地

## 目录

```
apps/server/          本地服务（Fastify + SQLite + 任务引擎）
apps/web/             Vue3 管理面（Vite 构建，服务端托管 dist）
packages/contracts/   前后端共享类型与错误码
migrations/           SQLite 迁移
tests/                单元 + 集成测试（fake-claude 假引擎）
scripts/              fake-claude.mjs（测试假引擎）、smoke.mjs（冒烟）、e2e-web.mjs（Web E2E）
```
