<script setup lang="ts">
import { computed } from 'vue';
import { store } from '../stores/data';

const text = computed(() => {
  if (!store.connected || !store.health?.ok) return '连接中断';
  return '服务运行中';
});
const addr = computed(() => location.host);
</script>

<template>
  <div class="svc">
    <span class="dot" :class="{ off: !store.connected || !store.health?.ok }"></span>
    {{ text }}<span class="addr">{{ addr }}</span>
  </div>
</template>
