import { ref } from 'vue';

/** 页面级 1s 心跳：倒计时只在展示层动态计算（设计书 §10.1，不写库）。
 *  窗口被遮住/最小化时停跳——1s 一次的整页重渲染在后台纯属烧 CPU；
 *  回前台立即补一拍,倒计时不跳变。 */
export const now = ref(Date.now());

let started = false;
export function startTicker(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    if (document.visibilityState === 'hidden') return;
    now.value = Date.now();
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') now.value = Date.now();
  });
}
