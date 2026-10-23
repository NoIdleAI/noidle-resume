import { ref } from 'vue';

/** 页面级 1s 心跳：倒计时只在展示层动态计算（设计书 §10.1，不写库）。 */
export const now = ref(Date.now());

let started = false;
export function startTicker(): void {
  if (started) return;
  started = true;
  setInterval(() => {
    now.value = Date.now();
  }, 1000);
}
