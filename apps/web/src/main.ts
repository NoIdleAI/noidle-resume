import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router/index';
import { initAuth, startReliabilityWatch } from './stores/data';
import { startTicker } from './stores/ticker';
import './styles/tokens.css';

startTicker();
startReliabilityWatch(); // 心跳看门狗 + revision 对账 + 回前台补快照（四层防冻结）
void initAuth();

createApp(App).use(router).mount('#app');

// 空闲时预热路由分包：首次点击导航不再现拉 chunk（本地虽快,仍有一次解码延迟）
const warmRoutes = (): void => {
  void import('./pages/SessionsPage.vue');
  void import('./pages/SettingsPage.vue');
  void import('./pages/TaskDetailPage.vue');
};
if ('requestIdleCallback' in window) {
  requestIdleCallback(warmRoutes, { timeout: 3000 });
} else {
  setTimeout(warmRoutes, 1200);
}
