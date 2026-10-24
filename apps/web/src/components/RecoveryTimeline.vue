<script setup lang="ts">
import { computed } from 'vue';
import type { ResumeTaskDto, UsageEventDto } from '@noidle/auto-resume-contracts';
import { buildTimeline } from '../stores/timeline';
import { settings } from '../stores/data';

const props = defineProps<{ task: ResumeTaskDto; event: UsageEventDto | null }>();
// 任务态随 WS 实时变，时间线必须跟随重算（时区也来自 settings）
const steps = computed(() => buildTimeline(props.task, props.event, settings.value.timezone));
// 终态一句话：卡片不再让用户自己拼五个点
const caption = computed(() => {
  switch (props.task.status) {
    case 'cancelled':
      return '已取消 — 后面的步骤不会再执行';
    case 'resumed':
      return '已完成 — 会话已恢复并核验落盘';
    case 'failed':
      return '已失败 — 自动重发到上限或结果未知终止；重新守护到会话页补录';
    default:
      return '';
  }
});
</script>

<template>
  <div class="tl">
    <div v-for="(s, i) in steps" :key="i" class="step" :class="s.state">
      <span class="dot2"></span>
      <div class="t">{{ s.t }}</div>
      <div class="n">{{ s.n }}</div>
    </div>
  </div>
  <div v-if="caption" class="tl-cap">{{ caption }}</div>
</template>

<style scoped>
.tl-cap {
  margin-top: 10px;
  font-size: 12px;
  color: var(--tx-3);
}
</style>
