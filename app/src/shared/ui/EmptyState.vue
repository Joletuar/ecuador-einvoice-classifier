<script setup lang="ts">
import type { Component } from 'vue'

defineProps<{
  icon: Component
  message: string
}>()
</script>

<template>
  <div
    class="flex min-h-44 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm text-ink-muted"
  >
    <component
      :is="icon"
      :size="26"
      class="shrink-0"
      aria-hidden="true"
    />
    <p>{{ message }}</p>
  </div>
</template>
