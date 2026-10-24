<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError } from '../api/client';
import { initAuth, loginWithToken } from '../stores/data';

const token = ref('');
const busy = ref(false);
const error = ref('');

async function submit(): Promise<void> {
  if (busy.value || !token.value.trim()) return;
  busy.value = true;
  error.value = '';
  try {
    await loginWithToken(token.value);
  } catch (err) {
    if (err instanceof ApiError && err.httpStatus === 401) {
      error.value = '令牌不对 — 到启动横幅或数据目录 token.txt 里复制完整令牌';
    } else {
      error.value = '连不上服务（127.0.0.1 本机端口）。确认后台已在运行。';
      // 服务其实活着、只是刚才网络抖动：允许重试静默验证
      void initAuth();
    }
  } finally {
    busy.value = false;
  }
}

// 桌面壳传入的免登录令牌：#token=xxx（hash 不发往服务端，用后即清）
onMounted(() => {
  const m = /^#token=([0-9a-f]{64})$/.exec(location.hash);
  if (!m?.[1]) return;
  history.replaceState(null, '', location.pathname + location.search);
  token.value = m[1];
  void submit();
});
</script>

<template>
  <div class="overlay" style="place-items: center">
    <div class="dialog" style="width: 440px">
      <div class="brand" style="margin-bottom: 16px">
        <span class="mark">N</span>NoIdle Resume
      </div>
      <div style="font-size: 13px; color: var(--tx-2); line-height: 1.8; margin-bottom: 16px">
        本地值守台需要访问令牌。启动后台时会打印在终端，也存于：
        <div class="mono" style="font-size: 11.5px; color: var(--tx-3); margin-top: 6px; word-break: break-all">
          ~/Library/Application Support/noidle-resume/token.txt
        </div>
      </div>
      <div v-if="error" class="form-error">{{ error }}</div>
      <div class="field">
        <label>访问令牌</label>
        <input
          v-model="token"
          type="password"
          placeholder="粘贴 64 位十六进制令牌"
          spellcheck="false"
          @keydown.enter="submit"
        />
      </div>
      <div class="actions" style="justify-content: flex-end">
        <button class="btn primary" :disabled="busy || !token.trim()" @click="submit">
          {{ busy ? '验证中…' : '进入值守台' }}
        </button>
      </div>
    </div>
  </div>
</template>
