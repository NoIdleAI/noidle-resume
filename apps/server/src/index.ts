import { loadConfig } from './config.ts';
import { buildContext } from './context.ts';
import { buildApp } from './api/app.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = buildContext(config);
  const { services } = ctx;

  // 重启对账先于一切调度与监听（设计书 §7.3：先恢复状态，再启动调度）
  const summary = await services.scheduler.reconcileOnBoot();
  services.audit.log(
    'service.started',
    null,
    `checking→waiting=${summary.checkingBackToWaiting} recovering→resumed=${summary.recoveringResumed} recovering→requeue=${summary.recoveringRequeued} recovering→failed=${summary.recoveringFailed}`,
    'system',
  );

  // 监听已登记会话的转写；启动调度器
  services.watcher.sync(
    services.sessions
      .list()
      .map((s) => ({ sessionId: s.session_id, projectPath: s.project_path })),
  );
  services.scheduler.start();

  const app = buildApp(ctx);
  await app.listen({ host: config.host, port: config.port });

  console.log(`NoIdle Resume 已启动: http://${config.host}:${config.port}`);
  console.log(`本机访问令牌: ${ctx.token}`);
  console.log(`(令牌存于 ${config.tokenFile}，权限 0600；数据目录 ${config.dataDir})`);

  const shutdown = (signal: string): void => {
    console.log(`收到 ${signal}，优雅退出…`);
    services.scheduler.stop();
    services.watcher.stopAll();
    void app
      .close()
      .catch(() => undefined)
      .finally(() => {
        ctx.db.close();
        process.exit(0);
      });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});
