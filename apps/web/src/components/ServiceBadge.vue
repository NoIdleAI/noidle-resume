<script setup lang="ts">
import { computed } from 'vue';
import { store } from '../stores/data';

const ok = computed(() => store.connected && !!store.health?.ok);
const text = computed(() => (ok.value ? '服务运行中' : '连接中断'));
</script>

<template>
  <div class="svc-mini">
    <span class="dot" :class="{ off: !ok }"></span>
    {{ text }}
  </div>
</template>
