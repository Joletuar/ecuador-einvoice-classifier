<script setup lang="ts">
import { Pencil, RotateCcw } from 'lucide-vue-next'

import { IconActionTone } from '../../../shared/ui/iconActionTone'
import type { Category } from '../domain/categoryModel'
import IconAction from './IconAction.vue'
import { useUpdateInteraction } from '../../../app/updateCoordinator'

defineProps<{
  label: string
  category: Category
  original?: Category
  manual: boolean
  automaticInvoice?: boolean
  disabled: boolean
}>()

const emit = defineEmits<{
  edit: []
  automatic: []
}>()

const interaction = useUpdateInteraction()
</script>

<template>
  <div class="flex min-h-8 items-center gap-2">
    <IconAction
      :icon="Pencil"
      :tone="IconActionTone.Edit"
      tooltip="Editar categoría"
      :label="`Editar categoría de ${label}`"
      :disabled="disabled || interaction?.blocked.value"
      @click="emit('edit')"
    />
    <IconAction
      :icon="RotateCcw"
      :tone="IconActionTone.Restore"
      :tooltip="
        automaticInvoice
          ? 'Volver al modo automático con los conceptos actuales'
          : 'Restaurar categoría del modelo'
      "
      :label="`Restaurar categoría original de ${label}`"
      :disabled="disabled || !manual || interaction?.blocked.value"
      @click="emit('automatic')"
    />
  </div>
</template>
