<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { api, ApiError } from '../api/client';
import { humanizeError, ACTION_LABELS } from '../api/humanize';
import { refreshLogs, refreshSettings, settings, store } from '../stores/data';
import { fmtHMS, shortId } from '../stores/format';

const tz = computed(() => settings.value.timezone);
const host = location.host;

// ---- 表单（人单位 ↔ 毫秒换算） ----
const form = reactive({
  timezone: settings.value.timezone,
  maxAttempts: settings.value.maxAttempts,
  backoffBaseSec: settings.value.backoffBaseMs / 1000,
  backoffCapSec: settings.value.backoffCapMs / 1000,
  resumeTimeoutMin: settings.value.resumeAttemptTimeoutMs / 60_000,
  concurrency: settings.value.concurrency,
  resumePromptTemplate: settings.value.resumePromptTemplate,
  autoResend: settings.value.autoResend,
  hotTakeover: settings.value.hotTakeover,
});
let loadedFor = store.settings?.timezone;
// settings 异步到达后回填一次
void Promise.resolve().then(() => {
  if (store.settings && loadedFor !== store.settings.timezone) {
    loadedFor = store.settings.timezone;
    form.timezone = store.settings.timezone;
    form.maxAttempts = store.settings.maxAttempts;
    form.backoffBaseSec = store.settings.backoffBaseMs / 1000;
    form.backoffCapSec = store.settings.backoffCapMs / 1000;
    form.resumeTimeoutMin = store.settings.resumeAttemptTimeoutMs / 60_000;
    form.concurrency = store.settings.concurrency;
    form.resumePromptTemplate = store.settings.resumePromptTemplate;
    form.autoResend = store.settings.autoResend;
    form.hotTakeover = store.settings.hotTakeover;
  }
});

const busy = ref(false);
const saveError = ref('');
const saveOk = ref('');

const tzList: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();

async function onSave(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  saveError.value = '';
  saveOk.value = '';
  try {
    await api.patchSettings({
      timezone: form.timezone.trim(),
      maxAttempts: Math.max(1, Math.floor(form.maxAttempts)),
      backoffBaseMs: Math.max(1000, Math.round(form.backoffBaseSec * 1000)),
      backoffCapMs: Math.max(1000, Math.round(form.backoffCapSec * 1000)),
      resumeAttemptTimeoutMs: Math.max(10_000, Math.round(form.resumeTimeoutMin * 60_000)),
      concurrency: Math.min(3, Math.max(1, Math.floor(form.concurrency))),
      resumePromptTemplate: form.resumePromptTemplate,
      autoResend: form.autoResend,
      hotTakeover: form.hotTakeover,
    });
    await refreshSettings();
    saveOk.value = '已保存（立即生效）';
  } catch (err) {
    saveError.value =
      err instanceof ApiError ? humanizeError(err.code, err.message) : '保存失败：服务不可达';
  } finally {
    busy.value = false;
  }
}

function logText(a: { action: string; target: string | null; detail: string | null }): string {
  const label = ACTION_LABELS[a.action] ?? a.action;
  return `${label}${a.target ? ` · ${shortId(a.target)}` : ''}${a.detail ? ` · ${a.detail}` : ''}`;
}

async function reloadLogs(): Promise<void> {
  await refreshLogs();
}
</script>

<template>
  <div class="form-panel">
    <h3>恢复策略</h3>
    <div v-if="saveError" class="form-error">{{ saveError }}</div>
    <div v-if="saveOk" class="form-ok">{{ saveOk }}</div>
    <div class="field" style="margin-bottom: 16px">
      <label class="autoresend">
        <input v-model="form.autoResend" type="checkbox" />
        <span>自动化重发 — 恢复结果未知/失败时按退避间隔自动重发</span>
      </label>
      <div class="note">
        开启（推荐）：无人值守全自动，最多尝试「最大尝试次数」次后如实报告失败。
        关闭：结果未知一次即终止，绝不重发（防重复投喂保守模式）。
      </div>
    </div>
    <div class="field" style="margin-bottom: 16px">
      <label class="autoresend">
        <input v-model="form.hotTakeover" type="checkbox" />
        <span>热会话接管 — 实验性</span>
      </label>
      <div class="note">
        开启：到期时若 VS Code 仍开着该会话（热持有），确认你已 10 分钟没动它后，
        结束其专属持有进程（只杀该会话的进程，绝不碰共享组件）→ 自动续跑 → 自动
        刷新 VS Code 里的会话界面并弹通知。VS Code 全程不用关。
        关闭（默认）：热持有按退避重试直至次数上限（现行为）。挂机不聊的会话无进程、
        天然是冷的，两种模式下都直接续跑。
      </div>
    </div>
    <div class="form-grid">
      <div class="field">
        <label>时区（重置时刻的墙上钟按此解释）</label>
        <input v-model="form.timezone" list="tz-list" spellcheck="false" />
        <datalist id="tz-list">
          <option v-for="z in tzList.slice(0, 80)" :key="z" :value="z" />
        </datalist>
      </div>
      <div class="field">
        <label>最大尝试次数</label>
        <input v-model.number="form.maxAttempts" type="number" min="1" max="20" />
        <div class="note">超过后任务转 failed 如实报告；重新守护到会话页补录</div>
      </div>
      <div class="field">
        <label>退避基数（秒）</label>
        <input v-model.number="form.backoffBaseSec" type="number" min="1" />
      </div>
      <div class="field">
        <label>退避封顶（秒）</label>
        <input v-model.number="form.backoffCapSec" type="number" min="1" />
      </div>
      <div class="field">
        <label>单次续跑超时（分钟）</label>
        <input v-model.number="form.resumeTimeoutMin" type="number" min="1" />
      </div>
      <div class="field">
        <label>并发数（串行恢复，1–3）</label>
        <input v-model.number="form.concurrency" type="number" min="1" max="3" />
      </div>
      <div class="field" style="grid-column: 1 / -1">
        <label>续跑提示词模板（{taskId} 会被替换；此标记是叶核验凭据）</label>
        <input v-model="form.resumePromptTemplate" spellcheck="false" />
      </div>
    </div>
    <button class="btn primary" :disabled="busy" @click="onSave">保存</button>
  </div>

  <div class="form-panel">
    <h3>服务状态</h3>
    <div class="kv">
      <span class="k">健康检查</span>
      <span class="v">{{ store.health?.ok ? '正常' : '不可达' }}</span>
      <span class="k">服务时间</span>
      <span class="v">{{ store.health ? fmtHMS(store.health.time, tz) : '—' }}（{{ tz }}）</span>
      <span class="k">WS 实时推送</span>
      <span class="v">{{ store.connected ? '已连接' : '未连接' }}</span>
      <span class="k">服务地址</span>
      <span class="v">{{ host }}</span>
    </div>
  </div>

  <div class="sec-head">
    <h2>脱敏日志</h2>
    <span class="cnt">{{ store.logs.length }} 条（最近）</span>
    <span class="push2"></span>
    <button class="mini" @click="reloadLogs">刷新</button>
  </div>
  <div v-if="store.logs.length" class="list">
    <div v-for="l in store.logs" :key="l.id" class="row" style="font-family: var(--mono); font-size: 11.5px; color: var(--tx-3)">
      <span class="mono" style="min-width: 88px">{{ fmtHMS(l.at, tz) }}</span>
      <span class="mono" style="min-width: 130px; color: var(--tx-2)">{{ l.action }}</span>
      <span class="mono" style="flex: 1; word-break: break-all">{{ logText(l) }}</span>
    </div>
  </div>
  <div v-else class="empty">暂无日志。</div>
</template>
