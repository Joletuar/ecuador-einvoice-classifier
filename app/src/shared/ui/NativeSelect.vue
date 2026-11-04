<script setup lang="ts">
import { onMounted, useTemplateRef } from 'vue'
import { ChevronDown } from 'lucide-vue-next'

defineOptions({ inheritAttrs: false })

const props = withDefaults(
  defineProps<{
    compact?: boolean
    autofocus?: boolean
  }>(),
  {
    compact: false,
    autofocus: false,
  },
)

const select = useTemplateRef<HTMLSelectElement>('select')

onMounted(() => {
  if (props.autofocus) {
    select.value?.focus({ preventScroll: true })
  }
})
</script>

<template>
  <span class="relative inline-block min-w-0">
    <select
      ref="select"
      v-bind="$attrs"
      class="w-full appearance-none rounded-md border border-line bg-surface pr-9 text-sm text-ink focus-visible:border-primary focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:bg-canvas disabled:opacity-55"
      :class="compact ? 'h-8 py-1 pl-2 leading-5' : 'h-10 py-2 pl-3'"
    >
      <slot />
    </select>
    <ChevronDown
      :size="16"
      class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2"
      aria-hidden="true"
    />
  </span>
</template>
