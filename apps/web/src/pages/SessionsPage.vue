<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { DiscoveredSessionDto } from '@noidle/resume-contracts';
import type { SessionWithTask } from '../api/client';
import { api, ApiError } from '../api/client';
import { humanizeError } from '../api/humanize';
import { refreshSessions, refreshTasks, eventById, settings, store } from '../stores/data';
import { agoShort, fmtHM, isoWallInTz, nowWallInTz, remainParts, shortId, shortPath } from '../stores/format';
import { now } from '../stores/ticker';

// ---- 添加会话 ----
const addForm = reactive({ sessionId: '', projectPath: '', displayName: '' });
const addBusy = ref(false);
const addError = ref('');
const addOk = ref('');
const manualOpen = ref(false); // 手填字段默认折叠：日常从下拉选即可

// ---- 最近会话发现（登记下拉：扫转写根自动填充，不必手抠 UUID） ----
const recent = ref<DiscoveredSessionDto[]>([]);
const recentLoaded = ref(false);
const recentBusy = ref(false);
const pick = ref('');
const pickOpen = ref(false);

const triggerLabel = computed(() => {
  if (!recentLoaded.value) return '扫描中…';
  if (!recent.value.length) return '近 24 小时没有会话转写 — 在下方手动填写';
  if (picked.value) return picked.value.suggestedName || shortId(picked.value.sessionId);
  return `近 24 小时发现 ${recent.value.length} 个会话 — 点击选择`;
});

function onEsc(e: KeyboardEvent): void {
  if (e.key === 'Escape') pickOpen.value = false;
}
watch(pickOpen, (v) => {
  if (v) window.addEventListener('keydown', onEsc);
  else window.removeEventListener('keydown', onEsc);
});
onUnmounted(() => window.removeEventListener('keydown', onEsc));

async function loadRecent(): Promise<void> {
  recentBusy.value = true;
  try {
    const r = await api.discoverSessions(24);
    recent.value = r.sessions;
    recentLoaded.value = true;
    if (pick.value && !recent.value.some((d) => d.sessionId === pick.value)) pick.value = '';
  } catch {
    recentLoaded.value = true; // 扫描失败静默：下拉留空，手动填写仍可用
  } finally {
    recentBusy.value = false;
  }
}
onMounted(() => {
  void loadRecent();
});

const picked = computed(() => recent.value.find((d) => d.sessionId === pick.value) ?? null);

function choose(d: DiscoveredSessionDto): void {
  if (d.registered) return; // 已登记的不可再选
  pick.value = d.sessionId;
  applyPick();
  pickOpen.value = false;
}

function applyPick(): void {
  const d = picked.value;
  if (!d) return;
  addForm.sessionId = d.sessionId;
  addForm.projectPath = d.projectPath;
  if (!addForm.displayName.trim() && d.suggestedName) addForm.displayName = d.suggestedName;
}

async function onAdd(): Promise<void> {
  if (addBusy.value) return;
  addBusy.value = true;
  addError.value = '';
  addOk.value = '';
  try {
    const r = await api.addSession({
      sessionId: addForm.sessionId.trim(),
      projectPath: addForm.projectPath.trim(),
      displayName: addForm.displayName.trim() || undefined,
    });
    addOk.value = `已加入自动化列表：「${r.session.displayName}」— 已按限额重置时刻排队，到点自动续跑`;
    addForm.sessionId = '';
    addForm.projectPath = '';
    addForm.displayName = '';
    pick.value = '';
    await refreshSessions();
    await refreshTasks();
    void loadRecent(); // 已登记标记随扫描刷新
  } catch (err) {
    addError.value =
      err instanceof ApiError ? humanizeError(err.code, err.message) : '登记失败：服务不可达';
  } finally {
    addBusy.value = false;
  }
}

// ---- 行操作：移除（加入列表即守护，退出=移除；无单独开关概念） ----
const rowBusy = ref<string | null>(null);
const rowError = ref('');

// 列表里的会话都在等待自动重置：行内不贴状态，只给重置时刻与倒计时（流程阶段看总览看板）
function rowMeta(s: SessionWithTask): string {
  const t = s.activeTask;
  if (!t) return '';
  const e = t.usageEventId ? (eventById.value.get(t.usageEventId) ?? null) : null;
  const reset = fmtHM(e?.resetAt ?? t.scheduledAt, settings.value.timezone);
  const remain = t.status === 'waiting' ? remainParts(t.scheduledAt, now.value) : null;
  return remain ? `重置 ${reset} · T-${remain.total}` : `重置 ${reset}`;
}

// 列表与总览的自动化列表同源：只显示值守中的会话（等待重置/核验中/续跑中）。
// 加入即建任务、完结自动移除，列表外的会话不存在登记态，无需管理视图。
const visibleSessions = computed(() =>
  store.sessions.filter((s) => {
    const st = s.activeTask?.status;
    return st === 'waiting' || st === 'checking' || st === 'recovering';
  }),
);

async function removeSession(s: SessionWithTask): Promise<void> {
  if (!window.confirm(`把「${s.displayName}」移出自动化列表？待执行任务将一并取消（审计记录保留）。`)) return;
  rowBusy.value = s.id;
  rowError.value = '';
  try {
    await api.removeSession(s.id);
    await refreshSessions();
  } catch (err) {
    rowError.value =
      err instanceof ApiError ? humanizeError(err.code, err.message) : '移除失败：服务不可达';
  } finally {
    rowBusy.value = null;
  }
}

// ---- 补录撞限（监听漏报时的兜底）：粘贴原文自动解析 + 手填保留 ----
const manualFor = ref<SessionWithTask | null>(null);
const manualForm = reactive({ rawText: '', resetAt: '' });
const manualBusy = ref(false);
const manualError = ref('');
const manualOk = ref('');
const parseBusy = ref(false);
const parseInfo = ref('');
const tz = computed(() => settings.value.timezone);

function openManual(s: SessionWithTask): void {
  manualFor.value = s;
  manualError.value = '';
  manualOk.value = '';
  parseInfo.value = '';
  manualForm.rawText = '';
  manualForm.resetAt = nowWallInTz(tz.value);
}

function closeManual(): void {
  manualFor.value = null;
}

async function parseFill(): Promise<void> {
  const text = manualForm.rawText.trim();
  if (!text || parseBusy.value) return;
  parseBusy.value = true;
  parseInfo.value = '';
  try {
    const r = await api.parseLimit(text);
    if (r.resetAt) {
      manualForm.resetAt = isoWallInTz(r.resetAt, tz.value, true);
      parseInfo.value = `已解析：HTTP ${r.httpStatus ?? '—'} / 码 ${r.providerCode ?? '—'} · 置信度 ${r.confidence} · 重置 ${r.resetAtRaw}（${r.resetTz}）。可手动微调。`;
    } else {
      parseInfo.value = `识别到限额特征（置信度 ${r.confidence}）但时刻解析失败 — 请在下面手动填。`;
    }
  } catch (err) {
    parseInfo.value =
      err instanceof ApiError ? humanizeError(err.code, err.message) : '解析失败：服务不可达';
  } finally {
    parseBusy.value = false;
  }
}

async function submitManual(): Promise<void> {
  const s = manualFor.value;
  if (!s || manualBusy.value) return;
  manualBusy.value = true;
  manualError.value = '';
  manualOk.value = '';
  try {
    // datetime-local 值按服务器配置时区的墙上钟解释（§6.3）
    const wall = manualForm.resetAt.replace('T', ' ') + (manualForm.resetAt.length === 16 ? ':00' : '');
    const raw = manualForm.rawText.trim() || `人工补录：429/1308，重置 ${wall}（${tz.value}）`;
    const r = await api.registerUsageLimit({
      sessionId: s.sessionId,
      projectPath: s.projectPath,
      httpStatus: 429,
      providerCode: '1308',
      resetAt: wall,
      rawMessage: raw,
    });
    manualOk.value = r.taskCreated
      ? '已补录，恢复任务已入队'
      : `已补录（${r.reason ?? '未建任务'}）`;
    manualForm.rawText = '';
    parseInfo.value = '';
    manualForm.resetAt = nowWallInTz(tz.value);
  } catch (err) {
    manualError.value =
      err instanceof ApiError ? humanizeError(err.code, err.message) : '补录失败：服务不可达';
  } finally {
    manualBusy.value = false;
  }
}
</script>

<template>
  <!-- 添加会话 -->
  <div class="form-panel">
    <h3>添加会话</h3>
    <div v-if="addError" class="form-error">{{ addError }}</div>
    <div v-if="addOk" class="form-ok">{{ addOk }}</div>
    <div class="field">
      <div class="pickrow">
        <div class="pickwrap" style="flex: 1">
          <button
            type="button"
            class="pick-trigger"
            :disabled="recentBusy || !recent.length"
            @click="pickOpen = !pickOpen"
          >
            <span :class="picked ? 't' : 'ph'" :style="picked ? 'color: var(--acc)' : ''">{{
              triggerLabel
            }}</span>
            <span class="caret">▾</span>
          </button>
          <div v-if="pickOpen" class="pick-backdrop" @click="pickOpen = false"></div>
          <div v-if="pickOpen" class="pick-panel" role="listbox">
            <div
              v-for="d in recent"
              :key="d.sessionId"
              class="pick-item"
              :class="{ off: d.registered }"
              role="option"
              @click="choose(d)"
            >
              <span class="t">{{ d.suggestedName || shortId(d.sessionId) }}</span>
              <span class="sub mono">
                {{ shortPath(d.projectPath) }} · {{ agoShort(d.lastActiveAt) }}<template v-if="d.registered"> · 已登记</template>
              </span>
            </div>
          </div>
        </div>
        <button class="mini" :disabled="recentBusy" @click="loadRecent">刷新</button>
        <button class="btn primary" :disabled="addBusy || !addForm.sessionId || !addForm.projectPath" @click="onAdd">
          加入自动化列表
        </button>
      </div>
      <div v-if="picked" class="note">
        将登记 <span class="mono">{{ picked.sessionId }}</span> @ {{ picked.projectPath }}
      </div>
      <div class="note" style="margin-top: 6px">
        <span style="color: var(--warn); font-weight: 600">只有 API 真实返回过限额消息（429/1308）的会话才能加入；</span>登记后按重置时刻自动排队，恢复完结自动归档进总览历史记录。下拉来自本机转写扫描（近 24 小时 VS Code 会话）。
      </div>
    </div>
    <div class="field">
      <button type="button" class="mini" style="margin-bottom: 8px" @click="manualOpen = !manualOpen">
        {{ manualOpen ? '收起手动填写 ▴' : '手动填写（会话不在下拉里时） ▾' }}
      </button>
      <div v-if="manualOpen" class="form-grid">
        <div class="field">
          <label>会话 ID（sessionId）</label>
          <input v-model="addForm.sessionId" placeholder="claude 会话 UUID" spellcheck="false" />
        </div>
        <div class="field">
          <label>工作区目录（projectPath）</label>
          <input v-model="addForm.projectPath" placeholder="/Users/you/WorkSpace/my-app" spellcheck="false" />
        </div>
        <div class="field">
          <label>展示名称（可选，留空自动取「目录名#会话前8位」）</label>
          <input v-model="addForm.displayName" placeholder="后端接口开发" />
        </div>
      </div>
    </div>
  </div>

  <!-- 列表 -->
  <div class="sec-head">
    <h2>自动化列表</h2>
    <span class="cnt">{{ visibleSessions.length }} 个值守中</span>
    <span class="push2"></span>
  </div>
  <div v-if="rowError" class="form-error">{{ rowError }}</div>
  <div v-if="visibleSessions.length" class="list">
    <div v-for="s in visibleSessions" :key="s.id" class="row">
      <span class="nm">{{ s.displayName }}</span>
      <span class="pth">{{ shortPath(s.projectPath) }} · {{ shortId(s.sessionId) }}</span>
      <span class="st mono" style="font-size: 12px; color: var(--tx-2)">{{ rowMeta(s) }}</span>
      <button class="mini" :disabled="rowBusy === s.id" @click="openManual(s)">补录限额</button>
      <button class="mini danger" :disabled="rowBusy === s.id" @click="removeSession(s)">移除</button>
    </div>
  </div>
  <div v-else class="empty">
    没有值守中的任务 — 撞限的会话加入后出现在这里；恢复完结自动归档进总览历史记录。
  </div>

  <!-- 补录撞限弹层（监听漏报兜底） -->
  <div v-if="manualFor" class="overlay" @click.self="closeManual">
    <div class="dialog">
      <h3>补录撞限 · {{ manualFor.displayName }}</h3>
      <div class="note" style="margin-bottom: 10px">一般不用：撞限会被自动发现并入队。这里只在监听漏报时手动补。</div>
      <div v-if="manualError" class="form-error">{{ manualError }}</div>
      <div v-if="manualOk" class="form-ok">{{ manualOk }}</div>
      <div class="field">
        <label>粘贴限额提示原文（可选，自动解析重置时刻）</label>
        <textarea
          v-model="manualForm.rawText"
          rows="3"
          class="mono"
          placeholder="API Error: Request rejected (429) · [1308][已达到 5 小时的使用上限。您的限额将在 2026-10-24 04:02:37 重置。]"
          spellcheck="false"
        ></textarea>
        <div class="pickrow" style="margin-top: 8px">
          <button class="mini acc" :disabled="parseBusy || !manualForm.rawText.trim()" @click="parseFill">
            {{ parseBusy ? '解析中…' : '解析并填充' }}
          </button>
          <span v-if="parseInfo" class="note" style="flex: 1">{{ parseInfo }}</span>
        </div>
      </div>
      <div class="field">
        <label>重置时刻（{{ tz }} 墙上钟，可手动修改）</label>
        <input v-model="manualForm.resetAt" type="datetime-local" step="1" />
        <div class="note">补录后立即建恢复任务，到点自动核验并续跑。</div>
      </div>
      <div class="actions" style="justify-content: flex-end">
        <button class="btn ghost" @click="closeManual">关闭</button>
        <button class="btn primary" :disabled="manualBusy || !manualForm.resetAt" @click="submitManual">补录</button>
      </div>
    </div>
  </div>
</template>
