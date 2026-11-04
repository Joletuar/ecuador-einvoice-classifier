<script setup lang="ts">
import { useId } from 'vue'

import { Check, X } from 'lucide-vue-next'

import { IconActionTone } from '../../../shared/ui/iconActionTone'
import { categories, type Category } from '../domain/categoryModel'
import CategoryBadge from './CategoryBadge.vue'
import IconAction from './IconAction.vue'
import NativeSelect from '../../../shared/ui/NativeSelect.vue'
import { useUpdateInteraction } from '../../../app/updateCoordinator'

defineProps<{
  label: string
  category: Category
  active: boolean
  draft: string
  baseCategory?: Category
  saving: boolean
  error?: string
  stale?: boolean
}>()

const emit = defineEmits<{
  change: [value: string]
  save: []
  cancel: []
}>()

const interaction = useUpdateInteraction()
const fieldId = useId()
</script>

<template>
  <div class="min-w-0">
    <div class="flex min-h-8 items-center gap-2 whitespace-nowrap">
      <template v-if="active">
        <label
          class="sr-only"
          :for="fieldId"
        >
          Categoría de {{ label }}
        </label>
        <NativeSelect
          :id="fieldId"
          class="min-w-0 flex-[1_1_156px] w-[156px]"
          compact
          autofocus
          :value="draft"
          :disabled="saving || stale || interaction?.blocked.value"
          @change="emit('change', ($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="item in categories"
            :key="item"
            :value="item"
          >
            {{ item }}
          </option>
        </NativeSelect>
        <IconAction
          :icon="Check"
          :tone="IconActionTone.Positive"
          tooltip="Guardar cambios"
          :label="`Guardar cambios de ${label}`"
          :disabled="saving || stale || interaction?.blocked.value"
          @click="emit('save')"
        />
        <IconAction
          :icon="X"
          :tone="IconActionTone.Cancel"
          tooltip="Cancelar edición"
          :label="`Cancelar edición de ${label}`"
          :disabled="saving || interaction?.blocked.value"
          @click="emit('cancel')"
        />
      </template>
      <CategoryBadge
        v-else
        :category="category"
      />
    </div>
    <span
      v-if="active && error"
      role="alert"
      class="text-danger"
    >
      {{ error }}
    </span>
  </div>
</template>
