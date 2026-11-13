<script setup lang="ts">
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  useTemplateRef,
  watch,
} from 'vue'
import { TriangleAlert } from 'lucide-vue-next'

import { SelectionMode } from '../domain/classificationModel'
import type { Invoice } from '../domain/invoiceModel'
import {
  conceptDescription,
  conceptExclusionReasons,
  exactMoney,
} from '../presentation/invoiceFormatting'
import { useCategoryEditing } from '../composables/categoryEditingContext'
import CategoryEditor from './CategoryEditor.vue'
import CategoryActions from './CategoryActions.vue'
import CategoryBadge from './CategoryBadge.vue'

const { invoice, editable = false } = defineProps<{
  invoice: Invoice
  disabled: boolean
  editable?: boolean
}>()

const editing = useCategoryEditing()
const exclusions = computed(() => conceptExclusionReasons(invoice))

const viewport = useTemplateRef<HTMLDivElement>('viewport')
const table = useTemplateRef<HTMLTableElement>('table')
const maxHeight = ref<string>()

let observer: ResizeObserver | undefined

function measure() {
  const el = viewport.value
  const content = table.value

  const rows = Array.from(content?.tBodies[0]?.rows ?? [])

  if (!el || !content || invoice.concepts.length <= 5 || !rows.length) {
    maxHeight.value = undefined

    return
  }

  const shortestRow = rows.reduce(
    (shortest, row) => Math.min(shortest, row.getBoundingClientRect().height),
    Infinity,
  )
  const headerHeight = content.tHead?.getBoundingClientRect().height ?? 0
  const horizontalScrollbar = el.offsetHeight - el.clientHeight

  maxHeight.value = `${Math.floor(headerHeight + shortestRow * 5 + horizontalScrollbar)}px`
}

function observeRows() {
  observer?.disconnect()
  measure()

  if (typeof ResizeObserver === 'undefined') {
    return
  }

  observer = new ResizeObserver(measure)

  const rows = Array.from(table.value?.tBodies[0]?.rows ?? [])

  for (const el of [viewport.value, table.value, ...rows]) {
    if (el) {
      observer.observe(el)
    }
  }
}

onMounted(observeRows)
watch(() => [invoice.id, invoice.concepts.length], observeRows, {
  flush: 'post',
})
onBeforeUnmount(() => observer?.disconnect())
</script>

<template>
  <div
    ref="viewport"
    role="region"
    aria-label="Conceptos de la factura"
    tabindex="0"
    :style="{ maxHeight }"
    class="min-w-0 max-w-full overflow-auto focus-visible:outline-2 focus-visible:outline-primary"
  >
    <table
      ref="table"
      class="w-full min-w-[600px] table-fixed border-collapse bg-white text-left [&_th]:border [&_th]:border-line [&_th]:bg-table-head [&_th]:p-3 [&_th]:text-xs [&_th]:font-medium [&_th]:text-ink-muted [&_td]:border [&_td]:border-line [&_td]:p-3 [&_td]:wrap-anywhere"
    >
      <colgroup>
        <col />
        <col class="w-[260px]" />
        <col class="w-[110px]" />
        <col
          v-if="editable"
          class="w-[92px]"
        />
      </colgroup>
      <thead class="sticky top-0 z-10">
        <tr>
          <th>Concepto</th>
          <th>Categoría</th>
          <th class="text-right">Importe</th>
          <th v-if="editable">Acciones</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="concept in invoice.concepts"
          :key="concept.id"
          class="hover:bg-table-hover"
        >
          <td>
            <span
              v-if="exclusions.has(concept.id)"
              role="img"
              :aria-label="exclusions.get(concept.id)"
              :title="exclusions.get(concept.id)"
              class="mr-1 inline-flex align-text-bottom text-warning"
            >
              <TriangleAlert
                :size="14"
                aria-hidden="true"
              />
            </span>
            {{ conceptDescription(concept) }}
          </td>
          <td>
            <CategoryEditor
              v-if="editable"
              :label="conceptDescription(concept)"
              :category="concept.category"
              :active="editing.isEditing(invoice.id, concept.id)"
              :draft="editing.draft.value?.category ?? concept.category"
              :base-category="
                editing.isEditing(invoice.id, concept.id)
                  ? editing.draft.value?.baseCategory
                  : concept.category
              "
              :saving="editing.locked.value"
              :stale="
                editing.isEditing(invoice.id, concept.id) &&
                editing.draft.value?.stale
              "
              :error="
                editing.isEditing(invoice.id, concept.id)
                  ? editing.draft.value?.error
                  : undefined
              "
              @change="editing.change"
              @save="editing.save"
              @cancel="editing.cancel"
            />
            <CategoryBadge
              v-else
              :category="concept.category"
            />
          </td>
          <td class="whitespace-nowrap text-right tabular-nums">
            {{ exactMoney(concept.netAmount, invoice.currency) }}
          </td>
          <td v-if="editable">
            <CategoryActions
              v-if="!editing.isEditing(invoice.id, concept.id)"
              :label="conceptDescription(concept)"
              :category="concept.category"
              :original="concept.original"
              :manual="concept.selectionMode === SelectionMode.Manual"
              :disabled="disabled"
              @edit="editing.begin(invoice, concept.id)"
              @automatic="editing.begin(invoice, concept.id, true)"
            />
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
