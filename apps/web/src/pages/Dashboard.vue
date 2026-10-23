<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import type { SessionWithTask } from '../api/client';
import { api } from '../api/client';
import { humanizeError, ACTION_LABELS } from '../api/humanize';
import { counters, eventById, heroTask, settings, store } from '../stores/data';
import { now } from '../stores/ticker';
import { fmtHM, fmtHMS, remainParts, shortId, shortPath } from '../stores/format';
import { useTaskActions } from '../stores/taskActions';
import StatusChip from '../components/StatusChip.vue';
import SwitchToggle from '../components/SwitchToggle.vue';
import EvidenceBlock from '../components/EvidenceBlock.vue';
import RecoveryTimeline from '../components/RecoveryTimeline.vue';

const router = useRouter();
const actions = useTaskActions();
const pauseAllBusy = ref(false);
const pauseAllMsg = ref('');

const task = heroTask;
const event = computed(() =>
  task.value?.usageEventId ? (eventById.value.get(task.value.usageEventId) ?? null) : null,
);
const tz = computed(() => settings.value.timezone);

/** 倒计时锚点：重置前倒数到重置；退避重排后倒数到下次核验。 */
const countdown = computed(() => {
  const t = task.value;
  if (!t) return null;
  const resetAt = event.value?.resetAt ?? null;
  if (resetAt && now.value < new Date(resetAt).getTime()) {
    return { label: '距限额重置', parts: remainParts(resetAt, now.value) };
  }
  if (t.status === 'waiting') {
    return { label: '距下次核验', parts: remainParts(t.scheduledAt, now.value) };
  }
  return null;
});

/** 5 小时窗口进度（窗口 = 重置前 5 小时）。 */
const window5h = computed(() => {
  const resetAt = event.value?.resetAt ?? null;
  if (!resetAt) return null;
  const resetMs = new Date(resetAt).getTime();
  const startMs = resetMs - 5 * 3600_000;
  const pct = Math.round(
    Math.min(100, Math.max(0, ((now.value - startMs) / (resetMs - startMs)) * 100)),
  );
  return {
    pct,
    left: `${fmtHM(event.value?.detectedAt ?? null, tz.value)} 撞限`,
    right: `${fmtHM(resetAt, tz.value)} 重置`,
  };
});

const backoffNote = computed(() => {
  const t = task.value;
  if (!t || t.status !== 'waiting') return '';
  const resetAt = event.value?.resetAt ?? null;
  if (resetAt && new Date(t.scheduledAt).getTime() > new Date(resetAt).getTime() + 1000) {
    return `仍受限 · 已退避重排（${humanizeError('STILL_LIMITED')}）`;
  }
  return '到期先核验额度，再续跑';
});

const hint = computed(() => {
  const t = task.value;
  if (!t) return '';
  if (t.status === 'recovering' || t.verifiedLeafUuid) {
    return '恢复由本工具执行并展示 · 会话已标记 ';
  }
  if (t.status === 'paused' && t.lastErrorCode === 'RESUME_RESULT_UNKNOWN') {
    return '结果未知，绝不重发 — 请到详情页人工确认';
  }
  if (t.status === 'paused') return humanizeError(t.lastErrorCode ?? '', '已暂停，可重试');
  if (t.status === 'failed') return `${humanizeError(t.lastErrorCode ?? '', '失败')} · 可重试`;
  if (t.status === 'resumed') return '续跑轮已核验落盘';
  if (t.status === 'cancelled') return '任务已取消';
  return backoffNote.value;
});

const canPause = computed(() => task.value?.status === 'waiting');
const canCancel = computed(() =>
  ['waiting', 'checking', 'recovering', 'paused', 'failed'].includes(task.value?.status ?? ''),
);
const canRetry = computed(() =>
  ['paused', 'failed'].includes(task.value?.status ?? ''),
);

async function onPauseAll(): Promise<void> {
  if (pauseAllBusy.value) return;
  pauseAllBusy.value = true;
  pauseAllMsg.value = '';
  try {
    const r = await api.pauseAllTasks();
    pauseAllMsg.value = r.paused > 0 ? `已暂停 ${r.paused} 个任务` : '没有待执行任务';
  } catch (err) {
    pauseAllMsg.value = '操作失败';
  } finally {
    pauseAllBusy.value = false;
    window.setTimeout(() => (pauseAllMsg.value = ''), 4000);
  }
}

function sessionStatus(s: SessionWithTask): { text: string; cls: string; taken: boolean } {
  if (!s.enabled) return { text: '未启用', cls: 's-pause', taken: false };
  const t = s.activeTask;
  if (!t) return { text: '监控中 · 未撞限', cls: 's-run', taken: false };
  switch (t.status) {
    case 'waiting':
      return { text: '等待恢复', cls: 's-wait', taken: false };
    case 'checking':
    case 'recovering':
      return { text: '续跑中', cls: 's-hold', taken: true };
    case 'paused':
      return { text: '已暂停 · 需确认', cls: 's-pause', taken: false };
    case 'failed':
      return { text: '恢复失败', cls: 's-err', taken: false };
    case 'resumed':
      return { text: '已恢复', cls: 's-ok', taken: false };
    default:
      return { text: '监控中 · 未撞限', cls: 's-run', taken: false };
  }
}

function logClass(action: string): string {
  if (action.includes('error')) return 'wa';
  if (action.includes('event') || action.includes('EVENT')) return 'wa';
  if (action.includes('enabled') || action.includes('resumed')) return 'ok';
  return '';
}

function logText(a: AuditLike): string {
  const label = ACTION_LABELS[a.action] ?? a.action;
  const detail = a.detail ? ` · ${a.detail}` : '';
  const target = a.target ? ` · ${shortId(a.target)}` : '';
  return `${label}${target}${detail}`;
}

interface AuditLike {
  at: string;
  action: string;
  target: string | null;
  detail: string | null;
}

const logTail = computed<AuditLike[]>(() => store.logs.slice(0, 6));

function goDetail(id: string): void {
  void router.push(`/tasks/${id}`);
}

function goSessions(): void {
  void router.push('/sessions');
}

async function toggleSession(s: SessionWithTask): Promise<void> {
  // 启用会重核身份；失败时 WS/列表会给出服务端真实状态，这里只管发起
  await api.patchSession(s.id, { enabled: !s.enabled }).catch(() => undefined);
}
</script>

<template>
  <!-- 主任务卡 -->
  <section v-if="task" class="hero">
    <div class="hero-top">
      <h1>{{ task.sessionDisplayName }}</h1>
      <span class="path">{{ shortPath(task.projectPath) }} · {{ shortId(task.sessionId) }}</span>
      <span class="push"></span>
      <StatusChip :status="task.status" />
    </div>

    <div class="count-grid">
      <div v-if="countdown" class="count">
        <div class="label">{{ countdown.label }}</div>
        <div class="num">
          <template v-if="countdown.parts">{{ countdown.parts.main }}<span class="sec">{{ countdown.parts.sec }}</span></template>
          <template v-else>—</template>
        </div>
      </div>
      <div v-if="window5h" class="window">
        <div class="label"><span>5 小时窗口进度</span><span>{{ window5h.pct }}%</span></div>
        <div class="bar"><i :style="{ width: window5h.pct + '%' }"></i></div>
        <div class="bar-note"><span>{{ window5h.left }}</span><span>{{ window5h.right }}</span></div>
      </div>
      <div class="cell">
        <div class="label">重置时刻</div>
        <div class="val">{{ fmtHMS(event?.resetAt ?? null, tz) }}</div>
        <div class="sub">{{ tz }} · 已按绝对时间锚定</div>
      </div>
      <div class="cell">
        <div class="label">尝试 / 上限</div>
        <div class="val">{{ task.attemptCount }} / {{ settings.maxAttempts }}</div>
        <div class="sub">{{ backoffNote || '到期先核验额度，再续跑' }}</div>
      </div>
    </div>

    <EvidenceBlock :event="event" />

    <RecoveryTimeline :task="task" :event="event" />

    <div class="actions">
      <button v-if="canRetry" class="btn primary" :disabled="actions.busyId.value !== null" @click="actions.run(task.id, 'retry')">重试</button>
      <button v-else-if="canPause" class="btn primary" :disabled="actions.busyId.value !== null" @click="actions.run(task.id, 'pause')">暂停任务</button>
      <button v-if="canCancel" class="btn ghost" :disabled="actions.busyId.value !== null" @click="actions.run(task.id, 'cancel')">取消</button>
      <button class="btn ghost" @click="goDetail(task.id)">详情</button>
      <span class="hint"><template v-if="hint">{{ hint }}<b v-if="task.status === 'recovering' || task.verifiedLeafUuid">已接管</b></template></span>
    </div>
  </section>
  <div v-else class="empty">
    还没有恢复任务 — 转写监听会在撞限时自动建任务；也可以在会话页对已启用会话人工登记限额事件。
  </div>

  <!-- 白名单 -->
  <div class="sec-head">
    <h2>白名单会话</h2>
    <span class="cnt">{{ counters.enabled }} 启用 / {{ store.sessions.length }} 登记</span>
    <span class="push2"></span>
    <span v-if="pauseAllMsg" class="cnt">{{ pauseAllMsg }}</span>
    <button class="mini" :disabled="pauseAllBusy" @click="onPauseAll">全部暂停</button>
    <button class="mini acc" @click="goSessions">添加会话</button>
  </div>
  <div v-if="store.sessions.length" class="list">
    <div v-for="s in store.sessions" :key="s.id" class="row">
      <span class="nm">{{ s.displayName }}</span>
      <span class="pth">{{ shortPath(s.projectPath) }}</span>
      <span class="st" :class="sessionStatus(s).cls">
        {{ sessionStatus(s).text }}<span v-if="sessionStatus(s).taken" class="badge">已接管</span>
        <button
          v-if="s.activeTask"
          class="mini"
          style="margin-left: 8px; padding: 1px 8px; font-size: 11px"
          @click="goDetail(s.activeTask!.id)"
        >详情</button>
      </span>
      <SwitchToggle :on="s.enabled" @toggle="toggleSession(s)" />
    </div>
  </div>
  <div v-else class="empty">白名单为空 — 到「会话」页登记第一个会话（默认不启用，启用前会重核身份）。</div>

  <!-- 脱敏日志尾 -->
  <div v-if="logTail.length" class="log">
    <div v-for="(l, i) in logTail" :key="i">
      <span class="t">{{ fmtHMS(l.at, tz) }}</span><span :class="logClass(l.action)">{{ logText(l) }}</span>
    </div>
  </div>
</template>
