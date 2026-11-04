<script setup lang="ts">
import { computed } from 'vue'
import { categoryVisual } from './categoryVisuals'

const { category, label = '' } = defineProps<{
  category: string
  label?: string
}>()

const visual = computed(() => categoryVisual(category))
</script>

<template>
  <span
    class="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-xs font-semibold"
    :class="visual.classes"
    :data-category="category"
  >
    <component
      :is="visual.icon"
      :size="15"
      :stroke-width="2.2"
      class="shrink-0"
      aria-hidden="true"
    />
    <span>{{ label || category }}</span>
  </span>
</template>
