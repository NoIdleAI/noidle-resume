<script setup lang="ts">
import { computed } from 'vue';
import type { UsageEventDto } from '@noidle/resume-contracts';
import { fmtMDHM } from '../stores/format';
import { settings } from '../stores/data';

const props = defineProps<{ event: UsageEventDto | null }>();

const sourceLabel = computed(() =>
  props.event ? (props.event.source === 'transcript' ? '来源 转写帧' : '来源 人工登记') : '',
);
const confidenceLabel = computed(() => {
  if (!props.event) return '';
  const m: Record<string, string> = { high: '置信度高', medium: '置信度中', low: '置信度低' };
  return m[props.event.confidence] ?? props.event.confidence;
});
const frameProof = computed(() => {
  const e = props.event;
  if (!e) return '';
  return `${fmtMDHM(e.detectedAt, settings.value.timezone)} 检测 · 帧内自证 ${e.sessionId.slice(0, 8)}`;
});
</script>

<template>
  <div v-if="event" class="evidence">
    <div class="meta">
      <span v-if="event.httpStatus !== null" class="tag">{{ event.httpStatus }}</span>
      <span v-if="event.providerCode" class="tag code">{{ event.providerCode }}</span>
      <span v-if="event.confidence === 'high'" class="tag hi">{{ confidenceLabel }}</span>
      <span v-else class="tag">{{ confidenceLabel }}</span>
      <span class="tag">{{ sourceLabel }}</span>
      <span class="when">{{ frameProof }}</span>
    </div>
    {{ event.rawMessage ?? '（原始错误文本未留存）' }}
  </div>
</template>
