<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { ResumeTaskDto } from '@noidle/auto-resume-contracts';
import { humanizeError, ACTION_LABELS } from '../api/humanize';
import { api } from '../api/client';
import { activeTasks, eventById, heroTask, historyTasks, refreshTasks, settings, store } from '../stores/data';
import { now } from '../stores/ticker';
import { fmtHM, fmtHMS, remainParts, shortId, shortPath } from '../stores/format';
import EvidenceBlock from '../components/EvidenceBlock.vue';
import RecoveryTimeline from '../components/RecoveryTimeline.vue';

const router = useRouter();

// 监控视图：多任务时右上角下拉切换单会话详情 / ALL 看板。
// 下拉与自动化列表同源（activeTasks），终态任务自动从监控中退场、进历史记录。
const view = ref<string>('ALL');
const multi = computed(() => activeTasks.value.length > 1);
const task = computed(() => {
  if (!multi.value) return activeTasks.value[0] ?? null;
  if (view.value === 'ALL') return null;
  return activeTasks.value.find((t) => t.id === view.value) ?? null;
});
// 选中的会话恢复完结退场后自动回到 ALL 看板
watch(activeTasks, (list) => {
  if (view.value !== 'ALL' && !list.some((t) => t.id === view.value)) view.value = 'ALL';
});

// 自动化列表区：Tab 切换 值守列表 / 历史记录
const listTab = ref<'auto' | 'history'>('auto');
const clearing = ref(false);
/** 自动化列表行：所有行都是等待自动重置的任务，只给重置时刻与倒计时，不贴状态。 */
function rowMeta(t: ResumeTaskDto): string {
  const e = t.usageEventId ? (eventById.value.get(t.usageEventId) ?? null) : null;
  const reset = fmtHM(e?.resetAt ?? t.scheduledAt, tz.value);
  const remain = remainParts(t.scheduledAt, now.value);
  return remain ? `重置 ${reset} · T-${remain.total}` : `重置 ${reset} · 即将核验`;
}

function historyOutcome(t: ResumeTaskDto): { text: string; cls: string } {
  if (t.status === 'resumed') return { text: '恢复成功 ✓', cls: 's-ok' };
  if (t.status === 'cancelled') return { text: '已取消', cls: 's-run' };
  return { text: `恢复失败 · ${humanizeError(t.lastErrorCode ?? '', '原因见详情')}`, cls: 's-err' };
}

async function clearHistory(): Promise<void> {
  if (!window.confirm(`清空全部 ${historyTasks.value.length} 条历史记录？（审计日志保留）`)) return;
  clearing.value = true;
  try {
    await api.clearHistory();
    await refreshTasks();
  } finally {
    clearing.value = false;
  }
}

const pickOpen = ref(false);
function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape') pickOpen.value = false;
}
watch(pickOpen, (v) => {
  if (v) window.addEventListener('keydown', onEsc);
  else window.removeEventListener('keydown', onEsc);
});
onUnmounted(() => window.removeEventListener('keydown', onEsc));

const viewLabel = computed(() => {
  if (view.value === 'ALL') return 'ALL · 看板';
  return activeTasks.value.find((t) => t.id === view.value)?.sessionDisplayName ?? 'ALL · 看板';
});
function chooseView(id: string): void {
  view.value = id;
  pickOpen.value = false;
}

/** ALL 看板：只分两列——排队等待（重置未到）/ 正在执行（重置已到，核验+续跑）；成败看历史。 */
const columns = computed(() => {
  const cardOf = (t: ResumeTaskDto) => {
    const e = t.usageEventId ? (eventById.value.get(t.usageEventId) ?? null) : null;
    const remain = t.status === 'waiting' ? remainParts(t.scheduledAt, now.value) : null;
    return {
      t,
      resetHM: fmtHM(e?.resetAt ?? t.scheduledAt, tz.value),
      remain: remain?.total ?? null,
    };
  };
  return [
    { key: 'wait', title: '排队等待', hint: '到重置时刻自动开工', cards: activeTasks.value.filter((t) => t.status === 'waiting').sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)).map(cardOf) },
    { key: 'run', title: '正在执行', hint: '重置时刻已到 · 核验并自动续跑', cards: activeTasks.value.filter((t) => t.status === 'checking' || t.status === 'recovering').map(cardOf) },
  ];
});

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

/** 5 小时窗口进度（只在值守中有意义；终态卡片改用一句话事实行）。 */
const window5h = computed(() => {
  const resetAt = event.value?.resetAt ?? null;
  if (!resetAt || terminal.value) return null;
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
  if (t.status === 'failed' && t.lastErrorCode === 'RESUME_RESULT_UNKNOWN') {
    return '结果未知，为防重复投喂未再重发 — 要继续守护到会话页补录撞限';
  }
  if (t.status === 'failed') {
    return `${humanizeError(t.lastErrorCode ?? '', '恢复失败')} — 重新守护到会话页补录撞限`;
  }
  if (t.status === 'resumed') return '续跑轮已核验落盘 · 重启 VS Code 或重新打开该会话即可看到续跑内容';
  if (t.status === 'cancelled') return '已叫停 — 要重新守护这条会话，到会话页补录撞限即可';
  return backoffNote.value;
});

const terminal = computed(() =>
  task.value ? ['resumed', 'paused', 'failed', 'cancelled'].includes(task.value.status) : false,
);/** 终态一句话：撞限→重置（已过/未到）· 尝试 · 结果。 */
const factline = computed(() => {
  const t = task.value;
  if (!t) return '';
  const hit = fmtHM(event.value?.detectedAt ?? null, tz.value);
  const reset = fmtHM(event.value?.resetAt ?? null, tz.value);
  const resetPassed = event.value?.resetAt
    ? now.value >= new Date(event.value.resetAt).getTime()
    : true;
  const outcome =
    t.status === 'resumed'
      ? '已恢复 ✓'
      : t.status === 'cancelled'
        ? '已取消，不再执行'
        : `恢复失败 · ${humanizeError(t.lastErrorCode ?? '', '原因见详情')}`;
  return `${hit} 撞限 → ${reset} 重置（${resetPassed ? '已过' : '未到'}） · 尝试 ${t.attemptCount}/${settings.value.maxAttempts} · ${outcome}`;
});

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
}</script>

<template>
  <!-- 无任务空态 -->
  <div v-if="!store.tasks.length" class="empty">
    还没有恢复任务 — 转写监听会在撞限时自动建任务；也可以在会话页对已守护会话补录撞限。
  </div>

  <template v-else>
    <!-- 多任务：监控选择器（右上角自绘下拉，同会话页语言） -->
    <div v-if="multi" class="mon-head">
      <h2>监控</h2>
      <div class="pickwrap mon-pick">
        <button type="button" class="pick-trigger" @click="pickOpen = !pickOpen">
          <span class="t" :style="view !== 'ALL' ? 'color: var(--acc)' : ''">{{ viewLabel }}</span>
          <span class="caret">▾</span>
        </button>
        <div v-if="pickOpen" class="pick-backdrop" @click="pickOpen = false"></div>
        <div v-if="pickOpen" class="pick-panel mon-pick-panel" role="listbox">
          <div class="pick-item" :class="{ cur: view === 'ALL' }" role="option" @click="chooseView('ALL')">
            <span class="t">ALL · 看板</span>
            <span class="sub mono">值守中 {{ activeTasks.length }} 个会话一屏看护</span>
          </div>
          <div
            v-for="t in activeTasks"
            :key="t.id"
            class="pick-item"
            :class="{ cur: view === t.id }"
            role="option"
            @click="chooseView(t.id)"
          >
            <span class="t">{{ t.sessionDisplayName }}</span>
            <span class="sub mono">{{ rowMeta(t) }} · {{ shortId(t.sessionId) }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ALL 看板：按恢复流程分列，卡片即任务，点击进详情 -->
    <section v-if="multi && view === 'ALL'" class="board">
      <div v-for="col in columns" :key="col.key" class="bcol">
        <div class="bcol-head">
          <span class="bcol-title">{{ col.title }}</span>
          <span class="bcol-cnt mono">{{ col.cards.length }}</span>
          <span class="bcol-hint">{{ col.hint }}</span>
        </div>
        <div class="bcol-body">
          <div v-for="r in col.cards" :key="r.t.id" class="bcard" @click="goDetail(r.t.id)">
            <div class="bcard-nm">{{ r.t.sessionDisplayName }}</div>
            <div class="bcard-meta mono">
              <span class="bcard-reset">重置 {{ r.resetHM }}</span>
              <span v-if="r.remain" class="bcard-remain">T-{{ r.remain }}</span>
            </div>
            <div class="bcard-try mono">尝试 {{ r.t.attemptCount }}/{{ settings.maxAttempts }}</div>
          </div>
          <div v-if="!col.cards.length" class="bcard-empty">暂无任务</div>
        </div>
      </div>
    </section>

    <!-- 单任务详情卡 -->
    <section v-else-if="task" class="hero">
    <div class="hero-top">
      <h1>{{ task.sessionDisplayName }}</h1>
      <span class="path">{{ shortPath(task.projectPath) }} · {{ shortId(task.sessionId) }}</span>
      <span class="push"></span>
    </div>

    <!-- 值守中：倒计时 + 窗口；终态：一句话事实行（不再让用户拼五个点） -->
    <div v-if="!terminal" class="count-grid">
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
    <div v-else class="factline mono">{{ factline }}</div>

    <EvidenceBlock :event="event" />

    <RecoveryTimeline :task="task" :event="event" />

    <div class="actions">
      <button class="btn ghost" @click="goDetail(task.id)">详情</button>
      <span class="hint"><template v-if="hint">{{ hint }}<b v-if="task.status === 'recovering' || task.verifiedLeafUuid">已接管</b></template></span>
    </div>
  </section>
  </template>

  <!-- 自动化列表（总览侧的速览）：Tab 切换 值守列表 / 历史记录 -->
  <div class="sec-head">
    <div class="tabs">
      <button class="tab" :class="{ on: listTab === 'auto' }" @click="listTab = 'auto'">
        自动化列表 <span class="cnt">{{ activeTasks.length }}</span>
      </button>
      <button class="tab" :class="{ on: listTab === 'history' }" @click="listTab = 'history'">
        历史记录 <span class="cnt">{{ historyTasks.length }}</span>
      </button>
    </div>
    <span class="push2"></span>
    <button
      v-if="listTab === 'history' && historyTasks.length"
      class="mini danger"
      :disabled="clearing"
      @click="clearHistory"
    >清空历史</button>
    <button class="mini acc" @click="goSessions">添加会话</button>
  </div>
  <template v-if="listTab === 'auto'">
    <div v-if="activeTasks.length" class="list">
      <div v-for="t in activeTasks" :key="t.id" class="row" @click="goDetail(t.id)" style="cursor: pointer">
        <span class="nm">{{ t.sessionDisplayName }}</span>
        <span class="pth">{{ shortPath(t.projectPath) }}</span>
        <span class="st mono" style="font-size: 12px; color: var(--tx-2)">{{ rowMeta(t) }}</span>
        <button
          class="mini"
          style="margin-left: 10px; padding: 1px 8px; font-size: 11px"
          @click.stop="goDetail(t.id)"
        >详情</button>
      </div>
    </div>
    <div v-else class="empty">
      没有值守中的任务 — 撞限的会话加入后在这里排队，到重置时刻自动续跑。
    </div>
  </template>
  <template v-else>
    <div v-if="historyTasks.length" class="list">
      <div v-for="t in historyTasks" :key="t.id" class="row" @click="goDetail(t.id)" style="cursor: pointer">
        <span class="nm">{{ t.sessionDisplayName }}</span>
        <span class="pth">{{ shortPath(t.projectPath) }} · {{ fmtHMS(t.updatedAt, tz) }}</span>
        <span class="st" :class="historyOutcome(t).cls">{{ historyOutcome(t).text }}</span>
      </div>
    </div>
    <div v-else class="empty">暂无历史记录 — 恢复成功/失败的会话会归档在这里。</div>
  </template>

  <!-- 脱敏日志尾 -->
  <div v-if="logTail.length" class="log">
    <div v-for="(l, i) in logTail" :key="i">
      <span class="t">{{ fmtHMS(l.at, tz) }}</span><span :class="logClass(l.action)">{{ logText(l) }}</span>
    </div>
  </div>
</template>
