import { ref } from 'vue';

/**
 * 主任务卡等比例缩放：卡片排版不改，整卡按系数缩小。
 * 系数经 CSS 变量 --card-zoom 挂在 .hero 上（zoom 保持满宽，内容/高度按系数缩），
 * 页面其余部分不缩放。默认 100%（窗口默认尺寸已改小），localStorage 记忆。
 */
const KEY = 'noidle.ui.zoom.v2';
const MIN = 0.6;
const MAX = 1.2;
const STEP = 0.05;
const DEFAULT = 1;

function clamp(z: number): number {
  return Math.min(MAX, Math.max(MIN, z));
}

function readInit(): number {
  const v = Number(localStorage.getItem(KEY));
  return Number.isFinite(v) && v >= MIN && v <= MAX ? v : DEFAULT;
}

export const uiZoom = ref(readInit());

export function applyZoom(z: number): void {
  const v = clamp(Math.round(z / STEP) * STEP);
  uiZoom.value = v;
  localStorage.setItem(KEY, String(v));
  document.documentElement.style.setProperty('--card-zoom', String(v));
}

export function zoomBy(delta: number): void {
  applyZoom(uiZoom.value + delta);
}

// 模块加载即生效（App.vue 首个 import 处触发）
applyZoom(uiZoom.value);
