<script setup lang="ts">
import { AlertCircle, CheckCircle, Copy, File } from 'lucide-vue-next'

import { FileResultStatus } from '../model/processingStatus'
import AnimatedScrollList from '../../../shared/ui/AnimatedScrollList.vue'
import type {
  FileProcessingResult,
  ProcessingSummary,
} from '../services/processingService'

const {
  results,
  attemptId,
  summary = undefined,
} = defineProps<{
  results: readonly FileProcessingResult[]
  attemptId: number
  summary?: ProcessingSummary | null
}>()
const open = defineModel<boolean>('open', { default: false })

const visual = {
  [FileResultStatus.Added]: {
    label: 'Guardado',
    classes: 'border-success/30 bg-success-soft text-success-strong',
    rowClasses: 'border-l-success/40 bg-success/5',
    iconClasses: 'text-success',
    icon: CheckCircle,
  },
  [FileResultStatus.Duplicate]: {
    label: 'Duplicado',
    classes: 'border-warning/30 bg-warning-soft text-warning',
    rowClasses: 'border-l-warning/50 bg-warning/5',
    iconClasses: 'text-warning',
    icon: Copy,
  },
  [FileResultStatus.Error]: {
    label: 'Error',
    classes: 'border-danger/30 bg-danger-soft text-danger-strong',
    rowClasses: 'border-l-danger/40 bg-danger/5',
    iconClasses: 'text-danger',
    icon: AlertCircle,
  },
}
</script>

<template>
  <AnimatedScrollList
    v-model:open="open"
    label="Resultados por archivo"
    :mobile-row-height="67"
    :keys="results.map((result) => `${attemptId}:${result.id}`)"
  >
    <template #header-detail>
      <dl
        aria-label="Resumen confirmado de archivos"
        class="grid grid-cols-3 gap-3 text-xs sm:flex sm:items-center sm:gap-5"
      >
        <div class="grid gap-0.5 sm:flex sm:items-baseline sm:gap-1">
          <dt class="text-ink-muted [overflow-wrap:anywhere]">Guardados</dt>
          <dd class="text-sm font-semibold tabular-nums text-ink">
            {{ summary?.saved ?? 0 }}
          </dd>
        </div>
        <div class="grid gap-0.5 sm:flex sm:items-baseline sm:gap-1">
          <dt class="text-ink-muted [overflow-wrap:anywhere]">Duplicados</dt>
          <dd class="text-sm font-semibold tabular-nums text-ink">
            {{ summary?.duplicates ?? 0 }}
          </dd>
        </div>
        <div class="grid gap-0.5 sm:flex sm:items-baseline sm:gap-1">
          <dt class="text-ink-muted [overflow-wrap:anywhere]">Con errores</dt>
          <dd class="text-sm font-semibold tabular-nums text-ink">
            {{ summary?.failed ?? 0 }}
          </dd>
        </div>
      </dl>
    </template>
    <template
      v-if="results.length"
      #columns
    >
      <div
        class="hidden h-[33px] grid-cols-[1.5rem_minmax(0,1fr)_8.5rem] gap-3 border-b border-line bg-table-head px-4 py-2 text-xs font-semibold leading-4 text-ink-muted sm:grid"
        aria-hidden="true"
      >
        <span class="col-span-2">Archivo</span>
        <span class="text-right">Estado</span>
      </div>
    </template>
    <p
      v-if="!results.length"
      class="px-4 py-3 text-sm leading-5 text-ink-muted"
    >
      No hay resultados todavía.
    </p>
    <ul
      v-else
      class="divide-y divide-line"
    >
      <li
        v-for="result in results"
        :key="`${attemptId}:${result.id}`"
        :data-row-key="`${attemptId}:${result.id}`"
        class="grid min-h-[var(--file-list-row-height)] grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3 border-l-2 px-4 py-2 sm:grid-cols-[1.5rem_minmax(0,1fr)_8.5rem]"
        :class="visual[result.status].rowClasses"
      >
        <span
          class="col-start-1 row-span-2 row-start-1 grid size-6 place-items-center sm:row-span-1"
          :class="visual[result.status].iconClasses"
        >
          <File
            class="size-6"
            :size="24"
            aria-hidden="true"
          />
        </span>
        <div class="col-start-2 row-start-1 min-w-0">
          <p class="min-w-0 flex-1 break-all text-sm font-medium text-ink">
            {{ result.name }}
          </p>
          <p
            v-if="
              result.status === FileResultStatus.Error ||
              result.retryable ||
              result.issues?.length
            "
            class="mt-1 break-words text-xs text-ink-muted"
          >
            {{ result.message }}
          </p>
        </div>
        <span
          class="col-start-2 row-start-2 mt-1 inline-flex items-center justify-self-start gap-1.5 rounded-md border px-2 py-1 text-xs font-medium sm:col-start-3 sm:row-start-1 sm:mt-0 sm:justify-self-end"
          :class="visual[result.status].classes"
        >
          <component
            :is="visual[result.status].icon"
            :size="12"
            aria-hidden="true"
          />
          {{
            result.retryable
              ? 'Pendiente'
              : result.issues?.length &&
                  result.status === FileResultStatus.Added
                ? 'Con incidencias'
                : visual[result.status].label
          }}
        </span>
      </li>
    </ul>
  </AnimatedScrollList>
</template>
