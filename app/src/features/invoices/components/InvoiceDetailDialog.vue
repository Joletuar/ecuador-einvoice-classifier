<script setup lang="ts">
import { computed, nextTick, watch } from 'vue'
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from 'reka-ui'
import { X } from 'lucide-vue-next'

import {
  RuleReason,
  RuleStatus,
  SelectionMode,
} from '../domain/classificationModel'
import type { Invoice } from '../domain/invoiceModel'
import { excludedTotalConcepts, totals } from '../domain/invoiceDomain'
import {
  exactMoney,
  formatDate,
  issueLabel,
  money,
} from '../presentation/invoiceFormatting'
import { useCategoryEditing } from '../composables/categoryEditingContext'
import Dialog from '../../../shared/ui/dialog/Dialog.vue'
import Button from '../../../shared/ui/button/Button.vue'
import CategoryBadge from './CategoryBadge.vue'
import CategoryEditor from './CategoryEditor.vue'
import CategoryActions from './CategoryActions.vue'
import InvoiceConceptTable from './InvoiceConceptTable.vue'

const {
  open,
  invoice = undefined,
  disabled,
  restoreFocus = true,
} = defineProps<{
  open: boolean
  invoice?: Invoice
  disabled: boolean
  restoreFocus?: boolean
}>()
const emit = defineEmits<{ close: [] }>()

const editing = useCategoryEditing()

const summary = computed(() => (invoice ? totals([invoice]) : {}))
const source = computed(() => {
  if (!invoice) {
    return 'No disponible'
  }

  return invoice.entryPath && invoice.entryPath !== invoice.sourceName
    ? `${invoice.sourceName} → ${invoice.entryPath}`
    : invoice.sourceName
})

let opener: HTMLElement | null = null

watch(
  () => open,
  (value) => {
    if (value) {
      opener =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null
    }
  },
)

function restoreOpener(event: Event) {
  event.preventDefault()

  if (!restoreFocus) {
    return
  }

  void nextTick(() => {
    if (opener?.isConnected) {
      opener.focus()
    } else {
      document.getElementById('invoices-heading')?.focus()
    }
  })
}

function requestClose(event: Event) {
  event.preventDefault()
  emit('close')
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!value) emit('close')
      }
    "
  >
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-ink/35 backdrop-blur-sm" />
      <DialogContent
        class="fixed top-1/2 left-1/2 z-50 grid max-h-[90dvh] w-[min(94vw,1050px)] -translate-x-1/2 -translate-y-1/2 gap-6 overflow-y-auto rounded-lg border border-line bg-white p-5 shadow-[0_16px_48px_rgb(24_36_56/18%)] [scrollbar-width:thin] [scrollbar-color:#a8b5c4_transparent] sm:p-8"
        @pointer-down-outside="requestClose"
        @interact-outside.prevent
        @escape-key-down="requestClose"
        @close-auto-focus="restoreOpener"
      >
        <div
          class="flex items-start justify-between gap-4 border-b border-line pb-6"
        >
          <div>
            <DialogTitle class="text-2xl font-bold">
              Detalle de factura
            </DialogTitle>
            <DialogDescription class="text-xs text-ink-muted">
              {{
                invoice
                  ? 'Revisa los gastos y cambia su categoría si hace falta.'
                  : 'No se encontró la factura seleccionada.'
              }}
            </DialogDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Cerrar detalle"
            :disabled="editing.saving.value"
            @click="emit('close')"
          >
            <X :size="18" />
          </Button>
        </div>
        <template v-if="invoice">
          <div
            class="min-w-0 border-b border-line pb-6 [&_dt]:text-ink-muted [&_dd]:mt-1 [&_dd]:text-ink [&_dd]:wrap-anywhere"
          >
            <dl class="flex min-w-0 flex-wrap gap-x-11 gap-y-3 text-[13px]">
              <div class="min-w-0">
                <dt class="text-xs text-ink-muted">N.º de factura</dt>
                <dd
                  :class="
                    invoice.number === null ? 'font-normal' : 'font-semibold'
                  "
                >
                  {{ invoice.number ?? 'No disponible' }}
                </dd>
              </div>
              <div class="min-w-0">
                <dt class="text-xs text-ink-muted">Fecha</dt>
                <dd
                  :class="
                    invoice.date === null ? 'font-normal' : 'font-semibold'
                  "
                >
                  {{ formatDate(invoice.date) }}
                </dd>
              </div>
            </dl>
            <div class="mt-5 grid min-w-0 gap-6 sm:grid-cols-2 sm:gap-10">
              <dl
                aria-label="Emisor"
                class="min-w-0"
              >
                <div>
                  <dt class="text-sm font-semibold">Emisor</dt>
                  <dd
                    :class="
                      invoice.issuer === null
                        ? 'text-base font-normal'
                        : 'text-lg font-semibold'
                    "
                  >
                    {{ invoice.issuer ?? 'No disponible' }}
                  </dd>
                </div>
                <div class="mt-3">
                  <dt class="text-xs font-medium text-ink-muted">RUC</dt>
                  <dd
                    class="text-base"
                    :class="
                      invoice.issuerRuc == null
                        ? 'font-normal'
                        : 'font-semibold'
                    "
                  >
                    {{ invoice.issuerRuc ?? 'No disponible' }}
                  </dd>
                </div>
              </dl>
              <dl
                aria-label="Comprador"
                class="min-w-0"
              >
                <div>
                  <dt class="text-sm font-semibold">Comprador</dt>
                  <dd
                    :class="
                      invoice.buyerName == null
                        ? 'text-base font-normal'
                        : 'text-lg font-semibold'
                    "
                  >
                    {{ invoice.buyerName ?? 'No disponible' }}
                  </dd>
                </div>
                <div class="mt-3">
                  <dt class="text-xs font-medium text-ink-muted">
                    Identificación
                  </dt>
                  <dd
                    class="text-base"
                    :class="
                      invoice.buyerIdentification == null
                        ? 'font-normal'
                        : 'font-semibold'
                    "
                  >
                    {{ invoice.buyerIdentification ?? 'No disponible' }}
                  </dd>
                </div>
              </dl>
            </div>
            <dl class="mt-5 border-t border-line pt-3">
              <dt class="text-xs text-ink-muted">Archivo de origen</dt>
              <dd class="text-[13px] font-medium">{{ source }}</dd>
            </dl>
          </div>
          <div
            class="flex flex-wrap justify-between gap-6 border-b border-line pb-6"
          >
            <div>
              <h2 class="mb-2.5 text-base font-bold">Categoría principal</h2>
              <div class="flex flex-wrap items-center gap-3">
                <CategoryEditor
                  :label="`factura ${invoice.number ?? 'No disponible'}`"
                  :category="invoice.principal"
                  :active="editing.isEditing(invoice.id)"
                  :draft="editing.draft.value?.category ?? invoice.principal"
                  :base-category="
                    editing.isEditing(invoice.id)
                      ? editing.draft.value?.baseCategory
                      : invoice.principal
                  "
                  :saving="editing.locked.value"
                  :stale="
                    editing.isEditing(invoice.id) && editing.draft.value?.stale
                  "
                  :error="
                    editing.isEditing(invoice.id)
                      ? editing.draft.value?.error
                      : undefined
                  "
                  @change="editing.change"
                  @save="editing.save"
                  @cancel="editing.cancel"
                />
                <CategoryActions
                  v-if="!editing.isEditing(invoice.id)"
                  :label="`factura ${invoice.number ?? 'No disponible'}`"
                  :category="invoice.principal"
                  :original="invoice.originalPrincipal"
                  :manual="invoice.principalMode === SelectionMode.Manual"
                  automatic-invoice
                  :disabled="disabled"
                  @edit="editing.begin(invoice)"
                  @automatic="editing.begin(invoice, undefined, true)"
                />
              </div>
            </div>
            <div class="whitespace-nowrap text-right tabular-nums">
              <span class="text-sm text-ink-muted">Total de factura</span>
              <p class="text-xl font-bold">
                {{ exactMoney(invoice.totalAmount, invoice.currency) }}
              </p>
            </div>
          </div>
          <section
            v-if="
              invoice.issues.length ||
              invoice.automatic.status !== RuleStatus.Resolved
            "
            class="rounded-lg border border-warning/30 bg-warning-soft p-4 text-sm"
            aria-label="Incidencias de la factura"
          >
            <p v-if="invoice.automatic.status === RuleStatus.Provisional">
              La categoría automática es provisional: algunos conceptos no
              pudieron clasificarse.
            </p>
            <p v-if="invoice.automatic.status === RuleStatus.Unassigned">
              Categoría automática no asignada:
              {{
                invoice.automatic.reason === RuleReason.UnavailableTieAmount
                  ? 'falta un importe neto necesario para resolver el empate.'
                  : 'ningún concepto tiene categoría disponible.'
              }}
            </p>
            <ul class="list-inside list-disc">
              <li
                v-for="(issue, index) in invoice.issues"
                :key="index"
              >
                {{ issueLabel(issue) }}
              </li>
            </ul>
          </section>
          <section class="grid gap-3 border-b border-line pb-6">
            <h2 class="text-lg font-semibold">Conceptos</h2>
            <InvoiceConceptTable
              :invoice="invoice"
              :disabled="disabled"
              editable
            />
          </section>
          <section>
            <h2 class="text-lg font-semibold">Resumen por categoría</h2>
            <p class="text-xs text-ink-muted">
              Cuánto gastaste en cada categoría.
            </p>
            <p
              v-if="excludedTotalConcepts([invoice])"
              class="mt-2 text-sm text-warning"
              role="status"
            >
              {{ excludedTotalConcepts([invoice]) }} conceptos excluidos de las
              sumas USD por moneda o importe no disponible.
            </p>
            <div class="mt-5 grid gap-3">
              <div
                v-for="(amount, category) in summary"
                :key="category"
                class="flex items-center justify-between gap-4 text-sm"
              >
                <CategoryBadge :category="String(category)" />
                <span class="whitespace-nowrap text-right tabular-nums">
                  {{ money(amount === undefined ? 0 : amount) }}
                </span>
              </div>
            </div>
          </section>
        </template>
      </DialogContent>
    </DialogPortal>
  </Dialog>
</template>
