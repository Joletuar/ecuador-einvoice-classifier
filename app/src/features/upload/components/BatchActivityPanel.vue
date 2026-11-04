<script setup lang="ts">
import {
  ActivityOperation,
  ActivityPhase,
  activityLabels,
  activityUnits,
  type BatchActivity,
} from '../model/activity'

import { computed } from 'vue'
import { AlertCircle, AlertTriangle, CheckCircle } from 'lucide-vue-next'

import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import ProgressBar from '../../../shared/ui/ProgressBar.vue'
import Button from '../../../shared/ui/button/Button.vue'

const {
  activity,
  canCancel = false,
  progressKey = 0,
  selectionSize = undefined,
} = defineProps<{
  activity: BatchActivity
  canCancel?: boolean
  progressKey?: string | number
  selectionSize?: string
}>()
const emit = defineEmits<{ cancel: [] }>()

const warning = computed(() => activity.tone === FeedbackTone.Warning)
const running = computed(() =>
  [
    ActivityPhase.Loading,
    ActivityPhase.Processing,
    ActivityPhase.Finalizing,
    ActivityPhase.Saving,
  ].some((phase) => phase === activity.phase),
)

const xmlProgress = computed(() => activity.xmlProgress)
const progressValue = computed(
  () => xmlProgress.value?.completed ?? activity.completed,
)
const progressTotal = computed(() =>
  xmlProgress.value ? (xmlProgress.value.total ?? 0) : activity.total,
)

const determinate = computed(
  () =>
    progressTotal.value > 0 &&
    (xmlProgress.value !== undefined ||
      activity.operation === ActivityOperation.Selection ||
      activity.completed > 0 ||
      !running.value) &&
    activity.phase !== ActivityPhase.Unavailable,
)

const label = computed(() => {
  if (
    activity.phase === ActivityPhase.Cancelled &&
    activity.operation === ActivityOperation.Selection
  ) {
    return 'Carga cancelada'
  }

  if (activity.phase !== ActivityPhase.Completed) {
    return activityLabels[activity.phase]
  }

  if (activity.operation === ActivityOperation.Selection) {
    return 'Archivos añadidos'
  }

  return activity.summary?.failed
    ? 'Procesamiento terminado con incidencias'
    : 'Procesamiento terminado'
})
</script>

<template>
  <section
    v-if="
      activity.phase !== ActivityPhase.Idle &&
      activity.phase !== ActivityPhase.Unavailable
    "
    aria-label="Actividad de archivos"
    class="space-y-3 rounded-xl border p-4 text-left shadow-sm sm:p-5"
    :class="[
      running
        ? 'sticky top-[calc(var(--app-header-height,0px)+0.75rem)] z-20'
        : '',
      warning
        ? 'border-warning/40 bg-warning-soft'
        : activity.phase === ActivityPhase.Failed
          ? 'border-danger/30 bg-surface'
          : 'border-primary/30 bg-surface',
    ]"
  >
    <div class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-3">
        <AlertTriangle
          v-if="warning"
          class="shrink-0 text-warning"
          :size="22"
          aria-hidden="true"
        />
        <AlertCircle
          v-else-if="
            activity.phase === ActivityPhase.Failed ||
            activity.phase === ActivityPhase.Cancelled
          "
          class="shrink-0 text-danger"
          :size="22"
          aria-hidden="true"
        />
        <CheckCircle
          v-else-if="activity.phase === ActivityPhase.Completed"
          class="shrink-0 text-success"
          :size="22"
          aria-hidden="true"
        />
        <h2
          class="font-bold"
          :class="warning ? 'text-warning' : 'text-ink'"
        >
          {{ label }}
        </h2>
      </div>
      <span
        v-if="activity.total > 0"
        class="text-base font-bold tabular-nums text-ink"
      >
        {{ activity.completed }} de {{ activity.total }}
        {{ activityUnits[activity.metric] }}
        <span
          v-if="
            selectionSize &&
            activity.operation === ActivityOperation.Selection &&
            [ActivityPhase.Loading, ActivityPhase.Completed].some(
              (phase) => phase === activity.phase,
            )
          "
          class="text-sm font-medium text-ink-muted"
        >
          · {{ selectionSize }}
        </span>
      </span>
      <Button
        v-if="canCancel"
        variant="destructive"
        class="w-full sm:w-auto"
        @click="emit('cancel')"
      >
        {{
          activity.operation === ActivityOperation.Processing
            ? 'Cancelar procesamiento'
            : 'Cancelar carga'
        }}
      </Button>
    </div>
    <ProgressBar
      v-if="determinate"
      :key="progressKey"
      :class="
        activity.operation === ActivityOperation.Selection
          ? '[&_[role=progressbar]>div]:duration-600 motion-reduce:[&_[role=progressbar]>div]:transition-none'
          : undefined
      "
      :value="progressValue"
      :max="progressTotal"
      :detail="
        xmlProgress
          ? `${label}: ${progressValue} de ${progressTotal} XML finalizados`
          : `${label}: ${activity.completed} de ${activity.total} ${activityUnits[activity.metric]}`
      "
      :tone="
        activity.phase === ActivityPhase.Failed
          ? warning
            ? FeedbackTone.Warning
            : FeedbackTone.Danger
          : activity.phase === ActivityPhase.Completed
            ? FeedbackTone.Success
            : FeedbackTone.Primary
      "
      :show-value="false"
    />
    <div
      v-else-if="running"
      role="progressbar"
      :aria-label="label"
      class="h-2.5 overflow-hidden rounded-full bg-line"
    >
      <div class="activity-progress h-full w-1/3 rounded-full bg-primary" />
    </div>
    <p
      v-if="
        activity.message &&
        [
          ActivityPhase.Failed,
          ActivityPhase.Cancelled,
          ActivityPhase.Finalizing,
        ].some((phase) => phase === activity.phase)
      "
      role="alert"
      class="text-sm"
      :class="warning ? 'text-warning' : 'text-danger'"
    >
      {{ activity.message }}
    </p>
    <p
      class="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {{ label }}
    </p>
  </section>
</template>

<style scoped>
/* La animación indica que el archivo sigue en proceso mientras todavía no hay
 * un avance que se pueda medir. */
@media (prefers-reduced-motion: no-preference) {
  .activity-progress {
    animation: activity-travel 1.2s linear infinite;
  }
}

@keyframes activity-travel {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}
</style>
