<script setup lang="ts">
import { computed } from 'vue'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
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
  canRetryStorage = false,
  retryingStorage = false,
  canRetryProcessing = false,
  retryingProcessing = false,
} = defineProps<{
  view: OfflineView
  canRetryStorage?: boolean
  retryingStorage?: boolean
  canRetryProcessing?: boolean
  retryingProcessing?: boolean
}>()
const emit = defineEmits<{
  update: []
  retryStorage: []
  retryProcessing: []
}>()

const unavailable = computed(() =>
  view.items.filter((item) => item.tone !== FeedbackTone.Success),
)
const available = computed(() =>
  view.items.filter((item) => item.tone === FeedbackTone.Success),
)

const dotClasses = {
  [FeedbackTone.Neutral]: 'bg-ink-muted',
  [FeedbackTone.Success]: 'bg-success',
  [FeedbackTone.Warning]: 'bg-warning',
  [FeedbackTone.Danger]: 'bg-danger',
}
const itemClasses = {
  [FeedbackTone.Success]: 'text-success',
  [FeedbackTone.Warning]: 'text-warning',
  [FeedbackTone.Danger]: 'text-danger',
}
const itemIcons = {
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
        class="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-2 py-1 text-xs font-semibold whitespace-nowrap text-ink hover:bg-primary-soft sm:gap-1.5 sm:px-3"
      >
        <span
          class="h-2 w-2 rounded-full"
          :class="dotClasses[view.tone]"
          aria-hidden="true"
        />
        <span>{{ labels[view.tone] }}</span>
        <ChevronDown
          :size="14"
          aria-hidden="true"
        />
      </button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        align="end"
        :side-offset="8"
        :collision-padding="16"
        class="z-60 max-h-[min(36rem,var(--reka-popover-content-available-height))] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-card border border-line bg-surface p-4 text-left shadow-lg"
      >
        <h2 class="text-sm font-bold text-ink">Estado sin conexión</h2>
        <p
          class="mt-3 flex items-start gap-2 text-sm"
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
          <span
            :class="
              view.label ===
              'Abre la aplicación instalada para comprobar el uso sin conexión.'
                ? 'text-xs'
                : undefined
            "
          >
            {{ view.label }}
          </span>
        </p>
        <h3
          v-if="unavailable.length"
          class="mt-4 border-t border-line pt-3 text-xs font-semibold text-ink-muted"
        >
          Funciones no disponibles
        </h3>
        <ul
          v-if="unavailable.length"
          class="mt-3 grid gap-3"
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
          v-if="canRetryStorage || retryingStorage"
          type="button"
          variant="outline"
          :disabled="retryingStorage"
          class="mt-3 w-full"
          @click="emit('retryStorage')"
        >
          {{
            retryingStorage ? 'Consultando facturas…' : 'Reintentar consulta'
          }}
        </Button>
        <ul
          v-if="canRetryProcessing || retryingProcessing"
          class="mt-3"
        >
          <li>
            <Button
              variant="outline"
              class="w-full"
              :disabled="retryingProcessing || view.updatePending"
              @click="emit('retryProcessing')"
            >
              {{
                retryingProcessing
                  ? 'Preparando el uso sin conexión…'
                  : 'Volver a intentar'
              }}
            </Button>
          </li>
        </ul>
        <ul
          v-if="available.length"
          class="mt-4 grid gap-2 border-t border-line pt-3"
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
        <Button
          v-if="view.updateAvailable"
          type="button"
          variant="outline"
          class="mt-3 w-full"
          :disabled="view.updatePending"
          @click="emit('update')"
        >
          {{ view.updateLabel }}
        </Button>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>
