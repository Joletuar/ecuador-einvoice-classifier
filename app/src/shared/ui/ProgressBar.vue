<script setup lang="ts">
import { computed } from 'vue'

import { FeedbackTone } from './feedbackTone'

const props = withDefaults(
  defineProps<{
    value: number
    max?: number
    label?: string
    detail?: string
    tone?:
      | typeof FeedbackTone.Primary
      | typeof FeedbackTone.Success
      | typeof FeedbackTone.Danger
      | typeof FeedbackTone.Warning
    showValue?: boolean
  }>(),
  {
    max: 100,
    label: '',
    detail: '',
    tone: FeedbackTone.Primary,
    showValue: true,
  },
)

const safeMax = computed(() => (props.max > 0 ? props.max : 1))
const safeValue = computed(() =>
  Math.min(Math.max(props.value, 0), safeMax.value),
)
const percent = computed(() =>
  Math.round((safeValue.value / safeMax.value) * 100),
)
const valueText = computed(
  () => props.detail || `${safeValue.value} de ${safeMax.value}`,
)

const toneStyles = {
  [FeedbackTone.Primary]: { fill: 'bg-primary', detail: 'text-ink-muted' },
  [FeedbackTone.Success]: { fill: 'bg-success', detail: 'text-success' },
  [FeedbackTone.Warning]: { fill: 'bg-warning', detail: 'text-warning' },
  [FeedbackTone.Danger]: { fill: 'bg-danger', detail: 'text-danger' },
}

const toneClass = computed(() => toneStyles[props.tone])
</script>

<template>
  <div>
    <div
      v-if="label || (showValue && detail)"
      class="mb-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm"
    >
      <span
        v-if="label"
        class="font-semibold text-ink"
      >
        {{ label }}
      </span>
      <span
        v-if="showValue && detail"
        :class="toneClass.detail"
      >
        {{ detail }}
      </span>
    </div>
    <div
      role="progressbar"
      :aria-label="label || 'Progreso'"
      :aria-valuenow="safeValue"
      aria-valuemin="0"
      :aria-valuemax="safeMax"
      :aria-valuetext="valueText"
      class="h-2.5 w-full overflow-hidden rounded-full bg-line"
    >
      <div
        class="h-full w-(--progress) rounded-full transition-[width] duration-200 motion-reduce:transition-none"
        :class="toneClass.fill"
        :style="{ '--progress': `${percent}%` }"
      />
    </div>
  </div>
</template>
