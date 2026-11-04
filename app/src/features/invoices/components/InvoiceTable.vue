<script setup lang="ts">
import { computed, useTemplateRef, watch } from 'vue'
import { ChevronDown, ChevronRight, Eye, Trash2 } from 'lucide-vue-next'
import type { InvoiceListRow } from '../presentation/invoiceListPresenter'
import Button from '../../../shared/ui/button/Button.vue'
import CategoryBadge from './CategoryBadge.vue'
import IconAction from './IconAction.vue'
import InvoiceConceptTable from './InvoiceConceptTable.vue'

const props = defineProps<{
  rows: InvoiceListRow[]
  expanded: string[]
  disabled: boolean
  scrollResetKey?: string
}>()
const emit = defineEmits<{
  toggle: [id: string]
  open: [id: string]
  remove: [id: string]
}>()

const viewport = useTemplateRef<HTMLDivElement>('viewport')

const needsHeightLimit = computed(() => props.rows.length > 10)

watch(
  () => props.scrollResetKey,
  () => {
    if (viewport.value) {
      viewport.value.scrollTop = 0
    }
  },
  { flush: 'post' },
)
</script>

<template>
  <div
    ref="viewport"
    role="region"
    aria-label="Listado de facturas"
    tabindex="0"
    class="relative min-w-0 max-w-full overflow-auto overscroll-y-auto rounded-lg border border-line [scrollbar-color:#a8b5c4_transparent] [scrollbar-width:thin] hover:[scrollbar-color:var(--color-ink-muted)_transparent] focus-visible:outline-2 focus-visible:outline-primary [&::-webkit-scrollbar]:size-2 [&::-webkit-scrollbar-button]:hidden [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-line [&::-webkit-scrollbar-thumb:hover]:bg-ink-muted [&::-webkit-scrollbar-track]:bg-transparent"
    :class="needsHeightLimit ? 'max-h-[min(calc(43rem+2px),70dvh)]' : ''"
  >
    <table
      class="w-full border-separate border-spacing-0 text-left [&_th]:border-b [&_th]:border-line [&_th]:p-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-ink-muted [&_td]:border-b [&_td]:border-line [&_td]:p-3"
    >
      <thead class="sticky top-0 z-10 bg-surface">
        <tr class="h-12 whitespace-nowrap">
          <th><span class="sr-only">Conceptos</span></th>
          <th>Emisor</th>
          <th>Número</th>
          <th>Fecha</th>
          <th>Categoría principal</th>
          <th class="text-right">Conceptos</th>
          <th class="text-right">Total de factura</th>
          <th><span class="sr-only">Acciones</span></th>
        </tr>
      </thead>
      <tbody>
        <template
          v-for="row in rows"
          :key="row.invoice.id"
        >
          <tr class="h-16">
            <td>
              <Button
                variant="ghost"
                size="icon"
                :disabled="disabled"
                :aria-expanded="expanded.includes(row.invoice.id)"
                :aria-label="`${expanded.includes(row.invoice.id) ? 'Ocultar' : 'Mostrar'} conceptos de ${row.invoice.issuer ?? 'No disponible'}`"
                @click="emit('toggle', row.invoice.id)"
              >
                <ChevronDown
                  v-if="expanded.includes(row.invoice.id)"
                  :size="16"
                />
                <ChevronRight
                  v-else
                  :size="16"
                />
              </Button>
            </td>
            <td class="font-semibold">
              {{ row.invoice.issuer ?? 'No disponible' }}
              <span
                v-if="row.invoice.issues.length"
                class="mt-1 block text-xs font-normal text-warning"
              >
                {{ row.invoice.issues.length }} incidencias
              </span>
            </td>
            <td>{{ row.invoice.number ?? 'No disponible' }}</td>
            <td class="whitespace-nowrap">{{ row.dateLabel }}</td>
            <td>
              <CategoryBadge :category="row.invoice.principal" />
            </td>
            <td class="text-right tabular-nums">
              {{ row.invoice.concepts.length }}
            </td>
            <td class="whitespace-nowrap text-right tabular-nums">
              {{ row.totalLabel }}
            </td>
            <td>
              <div class="flex justify-end gap-1">
                <IconAction
                  :icon="Eye"
                  tooltip="Ver detalles"
                  :label="`Ver detalles de ${row.invoice.issuer ?? 'No disponible'}`"
                  :disabled="disabled"
                  @click="emit('open', row.invoice.id)"
                />
                <IconAction
                  :icon="Trash2"
                  tooltip="Eliminar factura"
                  :label="`Eliminar factura de ${row.invoice.issuer ?? 'No disponible'}`"
                  :disabled="disabled"
                  destructive
                  @click="emit('remove', row.invoice.id)"
                />
              </div>
            </td>
          </tr>
          <tr v-if="expanded.includes(row.invoice.id)">
            <td
              colspan="8"
              class="bg-canvas"
            >
              <InvoiceConceptTable
                :invoice="row.invoice"
                :disabled="disabled"
              />
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
