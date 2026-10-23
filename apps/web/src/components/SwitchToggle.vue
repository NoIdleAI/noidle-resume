<script setup lang="ts">
defineProps<{ on: boolean; disabled?: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
</script>

<template>
  <span
    class="sw"
    :class="{ on }"
    role="switch"
    :aria-checked="on"
    :aria-disabled="disabled"
    @click="!disabled && emit('toggle')"
  ><i></i></span>
</template>
