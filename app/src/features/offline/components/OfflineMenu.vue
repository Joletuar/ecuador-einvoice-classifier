<script setup lang="ts">
import { computed, shallowRef, useTemplateRef, watch } from 'vue'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  RefreshCw,
  XCircle,
} from 'lucide-vue-next'
import {
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from 'reka-ui'

import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import type { OfflineView } from '../services/offlineService'
import Button from '../../../shared/ui/button/Button.vue'

const {
  view,
  canRetry = false,
  retrying = false,
} = defineProps<{
  view: OfflineView
  canRetry?: boolean
  retrying?: boolean
}>()
const emit = defineEmits<{
  update: []
  retry: []
}>()

const unavailable = computed(() =>
  view.items.filter((item) => item.tone !== FeedbackTone.Success),
)
const available = computed(() =>
  view.items.filter((item) => item.tone === FeedbackTone.Success),
)

const unavailableList = useTemplateRef<HTMLUListElement>('unavailableList')
const unavailableHeight = shallowRef<number>()

watch(
  [unavailableList, unavailable],
  ([list], _previous, onCleanup) => {
    unavailableHeight.value = undefined

    if (!list || unavailable.value.length <= 3) {
      return
    }

    const rows = Array.from(list.children).slice(0, 3) as HTMLElement[]
    const measure = () => {
      const first = rows[0]!
      const third = rows[2]!

      unavailableHeight.value =
        third.offsetTop + third.offsetHeight - first.offsetTop
    }

    measure()

    const observer = new ResizeObserver(measure)

    observer.observe(list)
    rows.forEach((row) => observer.observe(row))
    onCleanup(() => observer.disconnect())
  },
  { flush: 'post' },
)

const dotClasses = {
  [FeedbackTone.Neutral]: 'bg-ink-muted',
  [FeedbackTone.Success]: 'bg-success',
  [FeedbackTone.Warning]: 'bg-warning',
  [FeedbackTone.Danger]: 'bg-danger',
}
const itemClasses = {
  [FeedbackTone.Neutral]: 'text-ink-muted',
  [FeedbackTone.Success]: 'text-success',
  [FeedbackTone.Warning]: 'text-warning',
  [FeedbackTone.Danger]: 'text-danger',
}
const itemIcons = {
  [FeedbackTone.Neutral]: Loader2,
  [FeedbackTone.Success]: CheckCircle2,
  [FeedbackTone.Warning]: AlertTriangle,
  [FeedbackTone.Danger]: XCircle,
}

const labels = {
  [FeedbackTone.Success]: 'Modo offline disponible',
  [FeedbackTone.Danger]: 'Modo offline no disponible',
  [FeedbackTone.Warning]: 'Modo offline limitado',
  [FeedbackTone.Neutral]: 'Preparando modo offline',
}
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger as-child>
      <button
        type="button"
        class="relative inline-flex size-11 shrink-0 items-center justify-center overflow-visible rounded-full border border-line bg-surface text-xs font-semibold whitespace-nowrap text-ink hover:bg-primary-soft sm:size-auto sm:gap-1.5 sm:px-3 sm:py-1"
      >
        <component
          :is="itemIcons[view.tone]"
          class="size-4.5 shrink-0 sm:hidden"
          :class="[
            itemClasses[view.tone],
            {
              'animate-spin motion-reduce:animate-none':
                view.tone === FeedbackTone.Neutral,
            },
          ]"
          aria-hidden="true"
        />
        <span
          class="hidden h-2 w-2 rounded-full sm:block"
          :class="dotClasses[view.tone]"
          aria-hidden="true"
        />
        <span class="sr-only sm:not-sr-only sm:whitespace-nowrap">
          {{ labels[view.tone] }}
        </span>
        <template v-if="view.updateAvailable">
          <span
            aria-hidden="true"
            class="pointer-events-none absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-amber-400 ring-2 ring-surface motion-safe:animate-pulse"
          />
          <span class="sr-only">Actualización disponible</span>
        </template>
        <ChevronDown
          :size="14"
          class="hidden sm:block"
          aria-hidden="true"
        />
      </button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        align="end"
        :side-offset="8"
        :collision-padding="16"
        class="z-60 flex max-h-[min(36rem,var(--reka-popover-content-available-height))] w-96 max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-card border border-line bg-surface p-4 text-left shadow-lg"
      >
        <h2 class="shrink-0 text-sm font-bold text-ink">Estado sin conexión</h2>
        <p
          class="mt-3 flex shrink-0 items-start gap-2 text-xs"
          :class="
            view.tone === FeedbackTone.Danger ? 'text-danger' : 'text-ink-muted'
          "
          :role="view.tone === FeedbackTone.Danger ? 'alert' : undefined"
        >
          <Loader2
            v-if="view.tone === FeedbackTone.Neutral"
            :size="16"
            class="mt-0.5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <span>{{ view.label }}</span>
        </p>
        <Button
          v-if="view.updateAvailable"
          type="button"
          class="mt-3 w-full shrink-0 gap-2"
          :disabled="view.updatePending"
          @click="emit('update')"
        >
          <RefreshCw
            class="size-4"
            aria-hidden="true"
          />
          {{ view.updateLabel }}
        </Button>
        <h3
          v-if="unavailable.length"
          class="mt-4 shrink-0 border-t border-line pt-3 text-xs font-semibold text-ink-muted"
        >
          Funciones no disponibles
        </h3>
        <ul
          v-if="unavailable.length"
          ref="unavailableList"
          :style="
            unavailableHeight === undefined
              ? undefined
              : { maxHeight: `${unavailableHeight}px` }
          "
          tabindex="0"
          aria-label="Funciones no disponibles"
          class="relative mt-3 grid min-h-0 gap-3 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:outline-primary"
        >
          <li
            v-for="item in unavailable"
            :key="item.label"
            class="flex items-start gap-2 text-sm"
          >
            <component
              :is="itemIcons[item.tone]"
              :size="16"
              class="mt-0.5 shrink-0"
              :class="itemClasses[item.tone]"
              aria-hidden="true"
            />
            <div class="min-w-0">
              <p class="font-medium text-ink">{{ item.label }}</p>
              <p
                v-if="item.detail"
                class="mt-0.5 text-xs leading-relaxed text-ink-muted"
              >
                {{ item.detail }}
              </p>
            </div>
          </li>
        </ul>
        <Button
          v-if="canRetry || retrying"
          type="button"
          variant="outline"
          :disabled="retrying || view.updatePending"
          :aria-busy="retrying"
          class="mt-3 w-full shrink-0"
          @click="emit('retry')"
        >
          {{ retrying ? 'Reintentando…' : 'Reintentar' }}
        </Button>
        <ul
          v-if="available.length"
          class="mt-4 grid min-h-0 gap-2 overflow-y-auto border-t border-line pt-3"
        >
          <li
            v-for="item in available"
            :key="item.label"
            class="flex items-start gap-2 text-sm text-ink-muted"
          >
            <CheckCircle2
              :size="16"
              class="mt-0.5 shrink-0 text-success"
              aria-hidden="true"
            />
            <span>
              {{ item.label }}
              <span
                v-if="item.detail"
                class="mt-0.5 block text-xs"
              >
                {{ item.detail }}
              </span>
            </span>
          </li>
        </ul>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
