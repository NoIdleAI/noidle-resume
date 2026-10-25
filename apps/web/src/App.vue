<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { store } from './stores/data';
import { uiZoom, zoomBy, applyZoom } from './stores/uiZoom';
import TokenGate from './pages/TokenGate.vue';

const route = useRoute();
const router = useRouter();
const onDashboard = computed(() => route.name === 'dashboard');
// 会话详情(/tasks/:id)归属会话分组,侧栏保持高亮
const onSessions = computed(() => route.name === 'sessions' || route.name === 'task');
const onSettings = computed(() => route.name === 'settings');
const zoomPct = computed(() => Math.round(uiZoom.value * 100));
const onAbout = computed(() => route.name === 'about');

// 顶栏三键:收起/展开侧栏(记忆偏好)、后退、前进(按浏览历史位置点亮)
const sideHidden = ref(localStorage.getItem('car_side') === '1');
function toggleSide(): void {
  sideHidden.value = !sideHidden.value;
  localStorage.setItem('car_side', sideHidden.value ? '1' : '0');
}
const navPos = ref(0);
const navMax = ref(0);
watch(
  () => route.fullPath,
  () => {
    const p = (window.history.state?.position as number | undefined) ?? 0;
    navPos.value = p;
    navMax.value = Math.max(navMax.value, p);
  },
  { immediate: true },
);
const canBack = computed(() => navPos.value > 0);
const canFwd = computed(() => navPos.value < navMax.value);

// 汽水式整窗拖拽:按住任何非交互区域即可拖动窗口。
// 交互元素(按钮/输入/可点击卡,以 cursor:pointer 为准)与需要划选的文本区
// (.evidence/.log/.kv/.reading)不参与拖拽,点击/选字照常工作。
const tauri = (): { invoke: (cmd: string) => unknown } | null => {
  const w = window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string) => unknown } };
  return w.__TAURI_INTERNALS__ ?? null;
};
const DRAG_EXCLUDE =
  'button, a, input, textarea, select, label, [contenteditable="true"], ' +
  '.dialog, .overlay, .pick-panel, .evidence, .log, .kv, .reading, .factline';
function isDraggableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest(DRAG_EXCLUDE)) return false;
  for (let el: Element | null = target; el && el !== document.body; el = el.parentElement) {
    if (getComputedStyle(el).cursor === 'pointer') return false;
  }
  return true;
}
onMounted(() => {
  if (!tauri()) return; // 纯浏览器环境没有 Tauri IPC
  document.addEventListener(
    'mousedown',
    (e) => {
      if (e.button !== 0 || !isDraggableTarget(e.target)) return;
      tauri()?.invoke('plugin:window|start_dragging');
    },
    true,
  );
});
</script>

<template>
  <TokenGate v-if="store.auth === 'gate'" />

  <div v-else-if="store.auth === 'checking'" class="overlay" style="place-items: center">
    <div style="color: var(--tx-3); font-size: 13px">连接本机服务…</div>
  </div>

  <div v-else class="shell" :class="{ 'side-hidden': sideHidden }">
    <aside class="side">
      <!-- macOS Overlay 标题栏:红绿灯叠在顶部条左侧,三键按钮在其右;空档兼作拖拽区 -->
      <div class="side-top" data-tauri-drag-region>
        <button class="tb" :title="sideHidden ? '展开菜单' : '收起菜单'" @click="toggleSide">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.2" />
            <path d="M6.2 2.75v10.5" />
          </svg>
        </button>
        <button class="tb" title="后退" :disabled="!canBack" @click="router.back()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13 8H3.5M7.5 3.5 3 8l4.5 4.5" />
          </svg>
        </button>
        <button class="tb" title="前进" :disabled="!canFwd" @click="router.forward()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 8h9.5M8.5 3.5 13 8l-4.5 4.5" />
          </svg>
        </button>
      </div>
      <div class="brand"><span class="mark">N</span>NoIdle Resume</div>

      <router-link to="/" class="side-item" :class="{ on: onDashboard }">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <rect x="1.75" y="1.75" width="5.2" height="5.2" rx="1.4" />
          <rect x="9.05" y="1.75" width="5.2" height="5.2" rx="1.4" />
          <rect x="1.75" y="9.05" width="5.2" height="5.2" rx="1.4" />
          <rect x="9.05" y="9.05" width="5.2" height="5.2" rx="1.4" />
        </svg>
        总览
      </router-link>
      <router-link to="/sessions" class="side-item" :class="{ on: onSessions }">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M2 4.4C2 3.6 2.6 3 3.4 3h9.2c.8 0 1.4.6 1.4 1.4v5.2c0 .8-.6 1.4-1.4 1.4H8.6L5.3 13.3a.5.5 0 0 1-.8-.4V11h-1c-.8 0-1.5-.6-1.5-1.4Z" />
        </svg>
        会话
      </router-link>

      <router-link to="/settings" class="side-item" :class="{ on: onSettings }">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <path d="M2.2 4.4h5.2M12.6 4.4h1.2M2.2 11.6h3.4M9.9 11.6h3.9" stroke-linecap="round" />
          <circle cx="10" cy="4.4" r="1.7" />
          <circle cx="7.3" cy="11.6" r="1.7" />
        </svg>
        设置
      </router-link>
      <router-link to="/about" class="side-item" :class="{ on: onAbout }">
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
          <circle cx="8" cy="8" r="6.3" />
          <path d="M8 7.4v3.4" stroke-linecap="round" />
          <circle cx="8" cy="5" r="0.7" fill="currentColor" stroke="none" />
        </svg>
        关于
      </router-link>

      <div class="side-push"></div>
      <!-- 任务卡等比缩放：排版不动，卡片整体缩小；记忆在 localStorage -->
      <div class="zoomctl">
        <button class="zc" title="缩小任务卡" @click="zoomBy(-0.05)">−</button>
        <span class="zp mono" :title="'任务卡缩放 ' + zoomPct + '%'">{{ zoomPct }}%</span>
        <button class="zc" title="放大任务卡" @click="zoomBy(0.05)">＋</button>
        <button v-if="uiZoom !== 1" class="zc rst" title="恢复 100%" @click="applyZoom(1)">1:1</button>
      </div>
    </aside>

    <main class="main">
      <!-- 侧栏收起后,三键浮在内容区左上角,否则收起就回不来了 -->
      <div v-if="sideHidden" class="topbar" data-tauri-drag-region>
        <button class="tb" title="展开菜单" @click="toggleSide">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2.2" />
            <path d="M6.2 2.75v10.5" />
          </svg>
        </button>
        <button class="tb" title="后退" :disabled="!canBack" @click="router.back()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M13 8H3.5M7.5 3.5 3 8l4.5 4.5" />
          </svg>
        </button>
        <button class="tb" title="前进" :disabled="!canFwd" @click="router.forward()">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 8h9.5M8.5 3.5 13 8l-4.5 4.5" />
          </svg>
        </button>
      </div>
      <div class="wrap">
        <router-view />
      </div>
    </main>
  </div>
</template>
