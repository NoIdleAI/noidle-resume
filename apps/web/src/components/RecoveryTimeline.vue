<script setup lang="ts">
import { computed } from 'vue';
import type { ResumeTaskDto, UsageEventDto } from '@noidle/auto-resume-contracts';
import { buildTimeline } from '../stores/timeline';
import { settings } from '../stores/data';

const props = defineProps<{ task: ResumeTaskDto; event: UsageEventDto | null }>();
// 任务态随 WS 实时变，时间线必须跟随重算（时区也来自 settings）
const steps = computed(() => buildTimeline(props.task, props.event, settings.value.timezone));
</script>

<template>
  <div class="tl">
    <div v-for="(s, i) in steps" :key="i" class="step" :class="s.state">
      <span class="dot2"></span>
      <div class="t">{{ s.t }}</div>
      <div class="n">{{ s.n }}</div>
    </div>
  </div>
</template>
