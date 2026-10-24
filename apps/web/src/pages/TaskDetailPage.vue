<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ResumeTaskDto } from '@noidle/resume-contracts';
import { api } from '../api/client';
import { humanizeError } from '../api/humanize';
import { eventById, refreshEvents, refreshTasks, settings, store } from '../stores/data';
import { fmtHMS, shortId, shortPath } from '../stores/format';
import StatusChip from '../components/StatusChip.vue';
import EvidenceBlock from '../components/EvidenceBlock.vue';
import RecoveryTimeline from '../components/RecoveryTimeline.vue';

const route = useRoute();
const router = useRouter();
const notFound = ref(false);

const task = computed<ResumeTaskDto | null>(() => {
  const id = String(route.params.id ?? '');
  return store.tasks.find((t) => t.id === id) ?? null;
});
const event = computed(() =>
  task.value?.usageEventId ? (eventById.value.get(task.value.usageEventId) ?? null) : null,
);
const tz = computed(() => settings.value.timezone);

onMounted(async () => {
  const id = String(route.params.id ?? '');
  if (store.tasks.some((t) => t.id === id)) return;
  try {
    const r = await api.task(id);
    await Promise.all([refreshTasks(), refreshEvents()]);
    if (!store.tasks.some((t) => t.id === id)) {
      // 刷新后仍无（理论不可达）——直接补插
      store.tasks.unshift(r.task);
    }
  } catch {
    notFound.value = true;
  }
});

/** 状态解读：回答「现在到底在哪一步、为什么」。 */
const reading = computed(() => {
  const t = task.value;
  if (!t) return [];
  const out: string[] = [];
  switch (t.status) {
    case 'waiting': {
      const resetAt = event.value?.resetAt ?? null;
      if (resetAt && new Date(t.scheduledAt).getTime() > new Date(resetAt).getTime() + 1000) {
        out.push('上一次到期核验时<b class="bad">额度仍受限</b>，已按指数退避重新排队。');
        out.push(`下次核验：<b>${fmtHMS(t.scheduledAt, tz.value)}</b>（退避基数 ${settings.value.backoffBaseMs / 1000}s，封顶 ${settings.value.backoffCapMs / 1000}s，第 ${t.attemptCount} 次尝试 / 上限 ${settings.value.maxAttempts}）。`);
      } else {
        out.push(`等待限额重置，到点（<b>${fmtHMS(t.scheduledAt, tz.value)}</b>）先核验额度再续跑。`);
      }
      out.push('重置时刻来自限额帧内自证的墙上钟，按配置时区换算成绝对时间锚定。');
      break;
    }
    case 'checking':
      out.push('正在到期核验：冷守卫（pgrep）确认侧边栏没有热持有该会话。');
      break;
    case 'recovering':
      out.push('正在 headless 续跑原会话（显式 <b>--permission-mode default</b>，不会跳过权限）。');
      out.push('完成后做叶血统核验：本工具的 user 帧必须是 baseLeaf 的后代。');
      break;
    case 'resumed':
      out.push('<b class="good">恢复成功</b>：续跑轮已落盘且血统核验通过。');
      out.push('重启 VS Code（或重新打开该会话 / 其他终端里的 claude）即可看到续跑写入的内容。');
      out.push(`核验叶 <b>${shortId(t.verifiedLeafUuid ?? '')}</b>（起点叶 ${shortId(t.baseLeafUuid ?? '')} 的后代）。`);
      break;
    case 'paused': {
      const code = t.lastErrorCode ?? '';
      out.push(`已停止（旧版暂停任务，已按未完成归档）：${humanizeError(code, '原因见错误码')}。`);
      break;
    }
    case 'failed': {
      const code = t.lastErrorCode ?? '';
      if (code === 'RESET_TIME_UNPARSED') {
        out.push('<b class="bad">重置时刻解析失败</b> — 事件里没有可识别的重置时间。到会话页补录正确时刻重新入队。');
      } else if (code === 'RESUME_RESULT_UNKNOWN') {
        out.push('<b class="bad">续跑结果未知</b>：转写里找不到本工具的续跑轮。');
        out.push(settings.value.autoResend
          ? '已达最大尝试次数，<b>自动重发停止</b> — 要继续守护到会话页补录撞限。'
          : '自动重发已关闭，<b>不会重发</b> — 要继续守护到会话页补录撞限。');
      } else if (code === 'SESSION_HOT_HELD') {
        out.push('<b class="acc">侧边栏正持有该会话（热）</b>，按安全规则拒绝接管。等它冷下来自动再试（每次计入尝试数）。');
      } else {
        out.push(`<b class="bad">恢复失败</b>：${humanizeError(code, '原因见错误码')}。`);
      }
      out.push(`尝试 ${t.attemptCount} / 上限 ${settings.value.maxAttempts}。`);
      break;
    }
    case 'cancelled':
      out.push('任务已取消（用户操作或会话被禁用/移除）。');
      break;
  }
  return out;
});

/** 为什么产生这项任务 / 事件来源。 */
const eventLine = computed(() => {
  const e = event.value;
  if (!e) return '关联的限额事件不在最近列表里（可能已被清理或由历史数据创建）。';
  const src = e.source === 'transcript' ? '转写监听（自动）' : '人工登记';
  return `${src} · HTTP ${e.httpStatus ?? '?'} / 码 ${e.providerCode ?? '?'} · 置信度 ${e.confidence}`;
});

/** 恢复时间如何计算。 */
const scheduleLine = computed(() => {
  const t = task.value;
  if (!t) return '';
  const e = event.value;
  const parts: string[] = [];
  if (e?.resetAt) {
    parts.push(`事件自证重置 ${fmtHMS(e.resetAt, tz.value)}（${e.resetTz ?? tz.value}）`);
  }
  parts.push(`当前排期 ${fmtHMS(t.scheduledAt, tz.value)}`);
  if (t.attemptCount > 0) {
    parts.push(`退避 = 基数 ${settings.value.backoffBaseMs / 1000}s × 2^${t.attemptCount - 1}，封顶 ${settings.value.backoffCapMs / 1000}s`);
  }
  return parts.join(' · ');
});

const evidenceJson = computed<string>(() => {
  const raw = task.value?.evidence;
  if (!raw) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});

function back(): void {
  void router.back();
}
</script>

<template>
  <div v-if="notFound" class="empty">
    任务不存在或已被清理。
    <div style="margin-top: 12px"><button class="btn ghost" @click="back">返回</button></div>
  </div>

  <section v-else-if="task" class="hero">
    <div class="hero-top">
      <h1>{{ task.sessionDisplayName }}</h1>
      <span class="path">{{ shortPath(task.projectPath) }} · {{ shortId(task.sessionId) }}</span>
      <span class="push"></span>
      <StatusChip :status="task.status" />
    </div>

    <!-- 为什么产生 / 来源 -->
    <div class="subcard">
      <h4>为什么产生这项任务</h4>
      <div class="reading">{{ eventLine }}</div>
    </div>

    <EvidenceBlock :event="event" />

    <!-- 恢复时间线 -->
    <RecoveryTimeline :task="task" :event="event" />

    <!-- 状态解读 -->
    <div class="subcard">
      <h4>当前状态解读</h4>
      <div class="reading">
        <div v-for="(line, i) in reading" :key="i" v-html="line"></div>
      </div>
    </div>

    <!-- 恢复时间如何计算 -->
    <div class="subcard">
      <h4>恢复时间如何计算</h4>
      <div class="reading mono" style="font-size: 12px">{{ scheduleLine }}</div>
    </div>

    <!-- 技术细节 -->
    <div class="subcard">
      <h4>技术细节（排查用）</h4>
      <div class="kv">
        <span class="k">任务 ID</span><span class="v">{{ task.id }}</span>
        <span class="k">状态</span><span class="v">{{ task.status }}</span>
        <span class="k">起点叶 baseLeaf</span><span class="v">{{ task.baseLeafUuid ?? '—' }}</span>
        <span class="k">核验叶 verifiedLeaf</span><span class="v">{{ task.verifiedLeafUuid ?? '—' }}</span>
        <span class="k">最近尝试</span><span class="v">{{ task.lastAttemptAt ? fmtHMS(task.lastAttemptAt, tz) : '—' }} · 第 {{ task.attemptCount }} 次</span>
        <span class="k">最近错误码</span><span class="v">{{ task.lastErrorCode ?? '—' }}</span>
        <span class="k">排期 scheduledAt</span><span class="v">{{ fmtHMS(task.scheduledAt, tz) }}</span>
        <span class="k">创建 / 更新</span><span class="v">{{ fmtHMS(task.createdAt, tz) }} / {{ fmtHMS(task.updatedAt, tz) }}</span>
      </div>
      <div v-if="task.promptSent" style="margin-top: 10px">
        <div class="k" style="font-size: 11.5px; color: var(--tx-3); margin-bottom: 4px">本工具发出的续跑提示词（核验凭据）</div>
        <div class="mono" style="font-size: 12px; color: var(--tx-2)">{{ task.promptSent }}</div>
      </div>
      <div v-if="evidenceJson" style="margin-top: 10px">
        <div class="k" style="font-size: 11.5px; color: var(--tx-3); margin-bottom: 4px">核验证据</div>
        <pre class="mono" style="font-size: 11.5px; color: var(--tx-2); white-space: pre-wrap; word-break: break-all">{{ evidenceJson }}</pre>
      </div>
    </div>

    <div class="actions">
      <button class="btn ghost" @click="back">返回</button>
      <span class="hint">详情页纯只读 — 停止守护到会话页移除；自动重发在 <b>设置</b>（当前{{ settings.autoResend ? '开启' : '关闭' }}）</span>
    </div>
  </section>

  <div v-else class="empty">载入中…</div>
</template>
