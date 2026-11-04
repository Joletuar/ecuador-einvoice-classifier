<script setup lang="ts">
import type { PaginationView } from '../presentation/invoiceListPresenter'
import NativeSelect from '../../../shared/ui/NativeSelect.vue'
import Button from '../../../shared/ui/button/Button.vue'

defineProps<{
  pagination: PaginationView
  pageSize: number
  disabled: boolean
}>()

const emit = defineEmits<{
  page: [value: number]
  pageSize: [value: number]
}>()
</script>

<template>
  <div
    class="flex flex-wrap items-center justify-between gap-4 text-sm text-ink-muted"
  >
    <label class="flex items-center gap-2">
      Mostrar
      <NativeSelect
        class="inline-block h-10 w-[86px]"
        :value="pageSize"
        :disabled="disabled"
        @change="
          emit('pageSize', Number(($event.target as HTMLSelectElement).value))
        "
      >
        <option
          v-for="size in [10, 30, 50, 100]"
          :key="size"
          :value="size"
        >
          {{ size }}
        </option>
      </NativeSelect>
    </label>
    <div class="flex flex-wrap items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        class="h-10"
        :disabled="disabled || pagination.page <= 1"
        @click="emit('page', pagination.page - 1)"
      >
        Anterior
      </Button>
      <span>Página {{ pagination.page }} de {{ pagination.pages }}</span>
      <Button
        variant="outline"
        size="sm"
        class="h-10"
        :disabled="disabled || pagination.page >= pagination.pages"
        @click="emit('page', pagination.page + 1)"
      >
        Siguiente
      </Button>
    </div>
  </div>
</template>
