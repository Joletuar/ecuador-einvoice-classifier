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
    class="grid grid-cols-2 items-center gap-x-2 gap-y-3 text-xs text-ink-muted sm:flex sm:flex-wrap sm:justify-between sm:gap-4 sm:text-sm"
  >
    <label
      class="col-start-1 row-start-1 flex w-max items-center gap-1 sm:w-auto sm:gap-2"
    >
      Mostrar
      <NativeSelect
        class="inline-block h-11 w-[64px] pl-[8px] pr-[28px] sm:h-10 sm:w-[86px] sm:pl-3 sm:pr-9"
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
    <div class="contents sm:flex sm:flex-wrap sm:items-center sm:gap-2">
      <Button
        variant="outline"
        size="sm"
        class="col-start-1 row-start-2 h-11 w-full sm:h-10 sm:w-auto"
        :disabled="disabled || pagination.page <= 1"
        @click="emit('page', pagination.page - 1)"
      >
        Anterior
      </Button>
      <span class="col-start-2 row-start-1 justify-self-end whitespace-nowrap">
        Página {{ pagination.page }} de {{ pagination.pages }}
      </span>
      <Button
        variant="outline"
        size="sm"
        class="col-start-2 row-start-2 h-11 w-full sm:h-10 sm:w-auto"
        :disabled="disabled || pagination.page >= pagination.pages"
        @click="emit('page', pagination.page + 1)"
      >
        Siguiente
      </Button>
    </div>
  </div>
</template>
