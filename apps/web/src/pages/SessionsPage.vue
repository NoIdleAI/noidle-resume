<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { DiscoveredSessionDto } from '@noidle/auto-resume-contracts';
import type { SessionWithTask } from '../api/client';
import { api, ApiError } from '../api/client';
import { humanizeError } from '../api/humanize';
import { refreshSessions, settings, store } from '../stores/data';
import { agoShort, nowWallInTz, shortId, shortPath } from '../stores/format';
import SwitchToggle from '../components/SwitchToggle.vue';

// ---- 添加会话 ----
const addForm = reactive({ sessionId: '', projectPath: '', displayName: '' });
const addBusy = ref(false);
const addError = ref('');
const addOk = ref('');

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
    addOk.value = `已登记「${r.session.displayName}」— 默认未启用，确认无误后打开开关（启用会重核身份）`;
    addForm.sessionId = '';
    addForm.projectPath = '';
    addForm.displayName = '';
    pick.value = '';
    await refreshSessions();
    void loadRecent(); // 已登记标记随扫描刷新
  } catch (err) {
    addError.value =
      err instanceof ApiError ? humanizeError(err.code, err.message) : '登记失败：服务不可达';
  } finally {
    addBusy.value = false;
  }
}

// ---- 行操作 ----
const rowBusy = ref<string | null>(null);
const rowError = ref('');

async function toggleSession(s: SessionWithTask): Promise<void> {
  rowBusy.value = s.id;
  rowError.value = '';
  try {
    await api.patchSession(s.id, { enabled: !s.enabled });
    await refreshSessions();
  } catch (err) {
    rowError.value =
      err instanceof ApiError ? humanizeError(err.code, err.message) : '操作失败：服务不可达';
  } finally {
    rowBusy.value = null;
  }
}

async function removeSession(s: SessionWithTask): Promise<void> {
  if (!window.confirm(`移除「${s.displayName}」？待执行任务将一并取消（审计记录保留）。`)) return;
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

// ---- 人工登记限额事件（§9.3 兜底入口） ----
const manualFor = ref<SessionWithTask | null>(null);
const manualForm = reactive({ resetAt: '' });
const manualBusy = ref(false);
const manualError = ref('');
const manualOk = ref('');
const tz = computed(() => settings.value.timezone);

function openManual(s: SessionWithTask): void {
  manualFor.value = s;
  manualError.value = '';
  manualOk.value = '';
  manualForm.resetAt = nowWallInTz(tz.value);
}

function closeManual(): void {
  manualFor.value = null;
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
    const r = await api.registerUsageLimit({
      sessionId: s.sessionId,
      projectPath: s.projectPath,
      httpStatus: 429,
      providerCode: '1308',
      resetAt: wall,
      rawMessage: `人工登记：429/1308，重置 ${wall}（${tz.value}）`,
    });
    manualOk.value = r.taskCreated
      ? '已登记，恢复任务已入队'
      : `已登记（${r.reason ?? '未建任务'}）`;
    manualForm.resetAt = nowWallInTz(tz.value);
  } catch (err) {
    manualError.value =
      err instanceof ApiError ? humanizeError(err.code, err.message) : '登记失败：服务不可达';
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
      <label>从最近会话选择（自动扫描本机转写，近 24 小时）</label>
      <div class="pickrow">
        <div class="pickwrap">
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
      </div>
      <div v-if="picked" class="note">
        将登记 <span class="mono">{{ picked.sessionId }}</span> @ {{ picked.projectPath }}
      </div>
    </div>
    <div class="form-grid">
      <div class="field">
        <label>会话 ID（sessionId）</label>
        <input v-model="addForm.sessionId" placeholder="claude 会话 UUID" spellcheck="false" />
      </div>
      <div class="field">
        <label>工作区目录（projectPath）</label>
        <input v-model="addForm.projectPath" placeholder="/Users/you/WorkSpace/my-app" spellcheck="false" />
      </div>
      <div class="field">
        <label>展示名称（可选）</label>
        <input v-model="addForm.displayName" placeholder="后端接口开发" />
        <div class="note">留空则自动取「目录名#会话前8位」</div>
      </div>
    </div>
    <div class="form-foot">
      <div class="note">
        下拉里的会话来自本机转写扫描（近 24 小时），工作区路径取自转写帧内 cwd，与登记核验同源；
        找不到想要的（如超过 24 小时）再手动填。登记后默认不启用，需手动打开开关才获得自动续跑授权。
      </div>
      <button class="btn primary" :disabled="addBusy || !addForm.sessionId || !addForm.projectPath" @click="onAdd">
        登记并核验身份
      </button>
    </div>
  </div>

  <!-- 列表 -->
  <div class="sec-head">
    <h2>白名单</h2>
    <span class="cnt">{{ store.sessions.length }} 项</span>
    <span class="push2"></span>
  </div>
  <div v-if="rowError" class="form-error">{{ rowError }}</div>
  <div v-if="store.sessions.length" class="list">
    <div v-for="s in store.sessions" :key="s.id" class="row">
      <span class="nm">{{ s.displayName }}</span>
      <span class="pth">{{ shortPath(s.projectPath) }} · {{ shortId(s.sessionId) }}</span>
      <button class="mini" :disabled="!s.enabled || rowBusy === s.id" @click="openManual(s)">登记限额</button>
      <button class="mini danger" :disabled="rowBusy === s.id" @click="removeSession(s)">移除</button>
      <SwitchToggle :on="s.enabled" :disabled="rowBusy === s.id" @toggle="toggleSession(s)" />
    </div>
  </div>
  <div v-else class="empty">还没有登记会话 — 用上方表单添加第一个。</div>

  <!-- 人工登记限额弹层 -->
  <div v-if="manualFor" class="overlay" @click.self="closeManual">
    <div class="dialog">
      <h3>登记限额事件 · {{ manualFor.displayName }}</h3>
      <div v-if="manualError" class="form-error">{{ manualError }}</div>
      <div v-if="manualOk" class="form-ok">{{ manualOk }}</div>
      <div class="field">
        <label>重置时刻（{{ tz }} 墙上钟，取自限额提示原文）</label>
        <input v-model="manualForm.resetAt" type="datetime-local" step="1" />
        <div class="note">登记后立即建恢复任务，到点自动核验并续跑。</div>
      </div>
      <div class="actions" style="justify-content: flex-end">
        <button class="btn ghost" @click="closeManual">关闭</button>
        <button class="btn primary" :disabled="manualBusy || !manualForm.resetAt" @click="submitManual">登记 429/1308</button>
      </div>
    </div>
  </div>
</template>
