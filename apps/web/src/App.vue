<script setup lang="ts">
import { store } from './stores/data';
import ServiceBadge from './components/ServiceBadge.vue';
import TokenGate from './pages/TokenGate.vue';
</script>

<template>
  <TokenGate v-if="store.auth === 'gate'" />

  <div v-else-if="store.auth === 'checking'" class="overlay" style="place-items: center">
    <div style="color: var(--tx-3); font-size: 13px">连接本机服务…</div>
  </div>

  <div v-else class="wrap">
    <header class="top">
      <div class="brand"><span class="mark">N</span>NoIdle Resume</div>
      <nav class="nav">
        <router-link to="/">总览</router-link>
        <router-link to="/sessions">会话</router-link>
        <router-link to="/settings">设置</router-link>
      </nav>
      <div class="spacer"></div>
      <ServiceBadge />
    </header>

    <router-view />

    <footer class="foot">本地优先 · 数据不出本机 · <span class="mono">noidle-auto-resume v0.1</span></footer>
  </div>
</template>
