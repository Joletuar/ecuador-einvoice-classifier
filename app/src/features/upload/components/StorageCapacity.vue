<script setup lang="ts">
import type { StorageLimits } from '../../../app/config/storageLimits'
import type { StorageUsage } from '../../invoices/domain/storageModel'
import ProgressBar from '../../../shared/ui/ProgressBar.vue'
import Button from '../../../shared/ui/button/Button.vue'
import { Trash2 } from 'lucide-vue-next'

import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import { formatBytes } from '../model/selection'

defineProps<{
  usage: StorageUsage | undefined
  limits: StorageLimits
  unavailable: boolean
  clearDisabled?: boolean
  clearing?: boolean
}>()

const emit = defineEmits<{ clear: [] }>()

function capacityTone(value: number, maximum: number) {
  if (value >= maximum) {
    return FeedbackTone.Danger
  }

  if (value > maximum * 0.8) {
    return FeedbackTone.Warning
  }

  return FeedbackTone.Primary
}
</script>

<template>
  <div class="space-y-4">
    <template v-if="usage">
      <ProgressBar
        label="Archivos almacenados"
        :value="usage.files"
        :max="limits.maxFiles"
        :tone="capacityTone(usage.files, limits.maxFiles)"
        :detail="`${usage.files} / ${limits.maxFiles} archivos`"
      />
      <ProgressBar
        label="Espacio utilizado"
        :value="usage.bytes"
        :max="limits.maxTotalBytes"
        :tone="capacityTone(usage.bytes, limits.maxTotalBytes)"
        :detail="`${formatBytes(usage.bytes)} / ${formatBytes(limits.maxTotalBytes)}`"
      />
    </template>
    <dl
      v-else-if="unavailable"
      class="grid gap-3 text-sm text-ink-muted"
    >
      <div class="flex flex-wrap justify-between gap-2">
        <dt>Archivos almacenados</dt>
        <dd class="tabular-nums">— / {{ limits.maxFiles }} archivos</dd>
      </div>
      <div class="flex flex-wrap justify-between gap-2">
        <dt>Espacio utilizado</dt>
        <dd class="tabular-nums">
          — / {{ formatBytes(limits.maxTotalBytes) }}
        </dd>
      </div>
    </dl>
    <p
      v-else
      class="text-sm text-ink-muted"
    >
      Consultando el almacenamiento…
    </p>
    <div class="flex justify-end border-t border-line pt-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="w-full border-danger/40 text-danger transition-colors hover:border-danger hover:bg-danger hover:text-white motion-reduce:transition-none"
        :disabled="clearDisabled || unavailable || !usage?.files"
        :aria-busy="clearing || undefined"
        @click="emit('clear')"
      >
        <Trash2
          :size="16"
          aria-hidden="true"
        />
        {{ clearing ? 'Borrando datos…' : 'Borrar datos almacenados' }}
      </Button>
    </div>
  </div>
</template>
