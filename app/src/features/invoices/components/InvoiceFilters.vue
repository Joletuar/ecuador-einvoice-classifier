<script setup lang="ts">
import { computed } from 'vue'
import { categories } from '../domain/categoryModel'
import { appliedInvoiceQuery, type Filter } from '../domain/invoiceFilters'
import NativeSelect from '../../../shared/ui/NativeSelect.vue'
import Button from '../../../shared/ui/button/Button.vue'

const { filters, yearOptions, disabled } = defineProps<{
  filters: Filter
  yearOptions: string[]
  disabled: boolean
}>()

const emit = defineEmits<{
  change: [key: keyof Filter, value: string]
  clear: []
}>()

const hasFilters = computed(() =>
  Boolean(
    appliedInvoiceQuery(filters.query) || filters.year || filters.category,
  ),
)
</script>

<template>
  <div class="flex flex-wrap items-end gap-4">
    <label class="grid flex-[1_1_280px] gap-1 text-ink-muted">
      Buscar
      <input
        class="h-10 w-full rounded-md border border-line bg-white px-3 text-ink outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/25 disabled:opacity-55"
        :value="filters.query"
        :disabled="disabled"
        placeholder="Emisor o número"
        @input="
          emit('change', 'query', ($event.target as HTMLInputElement).value)
        "
      />
    </label>
    <label class="grid gap-1 text-ink-muted">
      Año
      <NativeSelect
        class="h-10"
        :value="filters.year"
        :disabled="disabled"
        @change="
          emit('change', 'year', ($event.target as HTMLSelectElement).value)
        "
      >
        <option value="">Todos</option>
        <option
          v-for="year in yearOptions"
          :key="year"
          :value="year"
        >
          {{ year }}
        </option>
      </NativeSelect>
    </label>
    <label class="grid gap-1 text-ink-muted">
      Categoría
      <NativeSelect
        class="h-10"
        :value="filters.category"
        :disabled="disabled"
        @change="
          emit('change', 'category', ($event.target as HTMLSelectElement).value)
        "
      >
        <option value="">Todas</option>
        <option
          v-for="category in categories"
          :key="category"
          :value="category"
        >
          {{ category }}
        </option>
      </NativeSelect>
    </label>
    <Button
      variant="outline"
      class="h-10"
      :disabled="disabled || !hasFilters"
      @click="emit('clear')"
    >
      Limpiar filtros
    </Button>
  </div>
</template>
