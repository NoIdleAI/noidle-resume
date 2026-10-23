<script setup lang="ts">
import { computed } from 'vue';
import type { TaskStatus } from '@noidle/auto-resume-contracts';
import { STATUS_CHIP } from '../api/humanize';

const props = defineProps<{ status: TaskStatus }>();
const chip = computed(() => STATUS_CHIP[props.status] ?? { label: props.status, cls: '' });
</script>

<template>
  <span class="chip" :class="chip.cls">{{ chip.label }}</span>
</template>
