<script setup lang="ts">
import { computed, nextTick, onScopeDispose, shallowRef } from 'vue'
import { useRouter } from 'vue-router'

import { InvoiceSnapshotKind } from '../domain/invoiceSnapshot'
import { StorageErrorCode } from '../domain/storageErrors'
import { RouteName } from '../../../app/router/routeNames'
import { useInvoiceStore } from '../stores/useInvoiceStore'
import { useInvoiceList } from '../composables/useInvoiceList'
import { useCategoryDraft } from '../composables/useCategoryDraft'
import { provideCategoryEditing } from '../composables/categoryEditingContext'
import { useInvoiceRemoval } from '../composables/useInvoiceRemoval'
import type { Filter } from '../domain/invoiceFilters'
import Button from '../../../shared/ui/button/Button.vue'
import ConfirmDialog from '../../../shared/ui/ConfirmDialog.vue'
import InvoiceSummary from '../components/InvoiceSummary.vue'
import InvoiceFilters from '../components/InvoiceFilters.vue'
import InvoiceTable from '../components/InvoiceTable.vue'
import InvoicePagination from '../components/InvoicePagination.vue'
import InvoiceDetailDialog from '../components/InvoiceDetailDialog.vue'
import { useLeaveProtection } from '../../../app/composables/useLeaveProtection'

const ConfirmationAction = {
  Discard: 'discard',
  Remove: 'remove',
} as const

type ConfirmationActionValue =
  (typeof ConfirmationAction)[keyof typeof ConfirmationAction]

const router = useRouter()
const store = useInvoiceStore()
const { invoices, list, preferences } = useInvoiceList()

const confirmation = shallowRef<ConfirmationActionValue | null>(null)
const provisionalLeave = shallowRef(false)
const restoreConfirmationFocus = shallowRef(true)
const restoreDetailFocus = shallowRef(true)
const selectedId = shallowRef<string | null>(null)
const removalIdentity = shallowRef<{
  number: string
  issuer: string
} | null>(null)

const removal = useInvoiceRemoval()
const editing = useCategoryDraft(
  () => !!confirmation.value || provisionalLeave.value || removal.busy.value,
)

provideCategoryEditing(editing)

const blocked = editing.locked
const controlsDisabled = computed(
  () =>
    blocked.value ||
    !!editing.draft.value ||
    store.snapshot.kind !== InvoiceSnapshotKind.Ready,
)
const selected = computed(() =>
  invoices.value.find((invoice) => invoice.id === selectedId.value),
)
const tableScrollKey = computed(() =>
  JSON.stringify([
    list.value.pagination.page,
    preferences.pageSize,
    preferences.appliedFilters,
  ]),
)

let resolveDiscard: ((consent: boolean) => void) | undefined
let discardOpener: HTMLElement | null = null
let removalOpener: HTMLElement | null = null

async function restoreRemovalFocus() {
  await nextTick()

  if (removalOpener?.isConnected) {
    removalOpener.focus({ preventScroll: true })
  }
}

function requestDiscard(): Promise<boolean> {
  if (blocked.value) {
    return Promise.resolve(false)
  }

  if (!editing.draft.value) {
    return Promise.resolve(true)
  }

  discardOpener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  restoreConfirmationFocus.value = true
  confirmation.value = ConfirmationAction.Discard

  return new Promise((resolve) => {
    resolveDiscard = resolve
  })
}

function commitLeave() {
  restoreDetailFocus.value = false
  editing.discard()
  selectedId.value = null
  provisionalLeave.value = false
}

function cancelLeave() {
  provisionalLeave.value = false
  void nextTick(() => {
    if (discardOpener?.isConnected) {
      discardOpener.focus()
    }
  })
}

const unregister = useLeaveProtection().register({
  isBlocked: () => blocked.value,

  isUpdateBlocked: () =>
    editing.saving.value ||
    removal.busy.value ||
    Boolean(removal.pendingId.value) ||
    Boolean(confirmation.value),

  isDirty: () => !!editing.draft.value,

  confirmDiscard: requestDiscard,
  commitLeave,
  cancelLeave,
})

onScopeDispose(() => {
  unregister()
  resolveDiscard?.(false)
})

function cancelConfirmation() {
  const deleting = confirmation.value === ConfirmationAction.Remove

  confirmation.value = null
  removal.cancel()
  removalIdentity.value = null

  if (deleting) {
    void restoreRemovalFocus()
  }

  resolveDiscard?.(false)
  resolveDiscard = undefined
}

async function confirmAction() {
  const action = confirmation.value

  restoreConfirmationFocus.value = false
  confirmation.value = null

  if (action === ConfirmationAction.Discard) {
    provisionalLeave.value = true
    resolveDiscard?.(true)
    resolveDiscard = undefined

    return
  }

  if (action !== ConfirmationAction.Remove) {
    return
  }

  const removed = await removal.confirm()

  removalIdentity.value = null

  if (!removed) {
    await restoreRemovalFocus()

    return
  }

  selectedId.value = null

  await nextTick()

  document.getElementById('invoices-heading')?.focus({ preventScroll: true })
}

function openDetail(id: string) {
  if (controlsDisabled.value) {
    return
  }

  restoreDetailFocus.value = true
  selectedId.value = id
}

async function closeDetail() {
  if (!(await requestDiscard())) {
    return
  }

  editing.discard()
  provisionalLeave.value = false
  selectedId.value = null
}

function requestRemoval(id: string) {
  if (controlsDisabled.value) {
    return
  }

  const invoice = invoices.value.find((item) => item.id === id)

  if (!invoice) {
    return
  }

  removalIdentity.value = {
    number: invoice.number ?? 'No disponible',
    issuer: invoice.issuer ?? 'No disponible',
  }

  removalOpener =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null

  removal.request(id)
  restoreConfirmationFocus.value = false
  confirmation.value = ConfirmationAction.Remove
}

function setFilter(key: keyof Filter, value: string) {
  if (!controlsDisabled.value) {
    preferences.setFilter(key, value)
  }
}
</script>

<template>
  <section
    class="grid min-w-0 gap-6 rounded-lg border border-line bg-white p-6 text-sm shadow-card sm:p-8"
  >
    <div
      class="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-6"
    >
      <div>
        <h1
          id="invoices-heading"
          tabindex="-1"
          class="text-2xl font-bold"
        >
          Mis facturas
        </h1>
        <p class="text-xs text-ink-muted">
          Revisa tus gastos y ajusta sus categorías.
        </p>
      </div>
      <Button
        class="w-full sm:w-auto"
        @click="router.push({ name: RouteName.Upload })"
      >
        Cargar facturas
      </Button>
    </div>
    <template v-if="store.snapshot.kind === InvoiceSnapshotKind.Ready">
      <InvoiceSummary :cards="list.cards" />
      <p
        v-if="list.excludedConcepts"
        role="status"
        class="text-xs text-warning"
      >
        {{ list.excludedConcepts }} conceptos excluidos de las sumas por
        incidencias
      </p>
      <p
        v-if="list.unavailableTotals"
        role="status"
        class="text-sm text-warning"
      >
        No podemos mostrar uno de los totales en USD porque supera el importe
        admitido. Aparece como «No disponible».
      </p>
      <InvoiceFilters
        :filters="preferences.filters"
        :year-options="list.yearOptions"
        :disabled="controlsDisabled"
        @change="setFilter"
        @clear="!controlsDisabled && preferences.clearFilters()"
      />
      <p
        v-if="!list.rows.length"
        class="p-6"
      >
        No encontramos facturas con estos filtros.
      </p>
      <InvoiceTable
        v-else
        :rows="list.rows"
        :expanded="preferences.expanded"
        :disabled="controlsDisabled"
        :scroll-reset-key="tableScrollKey"
        @toggle="!controlsDisabled && preferences.toggleExpanded($event)"
        @open="openDetail"
        @remove="requestRemoval"
      />
      <InvoicePagination
        :pagination="list.pagination"
        :page-size="preferences.pageSize"
        :disabled="controlsDisabled"
        @page="!controlsDisabled && preferences.setPage($event)"
        @page-size="!controlsDisabled && preferences.setPageSize($event)"
      />
    </template>
    <div
      v-else-if="store.snapshot.kind === InvoiceSnapshotKind.Error"
      role="alert"
      class="grid justify-items-start gap-3 rounded-lg border border-line bg-canvas p-5"
    >
      <p class="font-semibold">
        {{
          store.snapshot.code === StorageErrorCode.NotAvailable
            ? 'El almacenamiento local no está disponible'
            : 'No se pudieron cargar las facturas'
        }}
      </p>
      <p class="text-ink-muted">{{ store.snapshot.message }}</p>
      <Button
        variant="outline"
        :disabled="blocked"
        @click="store.refresh()"
      >
        Reintentar
      </Button>
    </div>
    <p
      v-else
      role="status"
      class="py-6 text-ink-muted"
    >
      Cargando facturas…
    </p>
    <p
      v-if="removal.busy.value"
      role="status"
    >
      Eliminando factura…
    </p>
    <p
      v-if="removal.error.value"
      role="alert"
      class="text-danger"
    >
      {{ removal.error.value }}
    </p>
    <InvoiceDetailDialog
      :open="!!selectedId"
      :invoice="selected"
      :disabled="controlsDisabled"
      :restore-focus="restoreDetailFocus"
      @close="closeDetail"
    />
    <ConfirmDialog
      :open="!!confirmation"
      :title="
        confirmation === ConfirmationAction.Remove
          ? 'Eliminar factura'
          : 'Descartar corrección'
      "
      :confirm-label="
        confirmation === ConfirmationAction.Remove ? 'Eliminar' : 'Descartar'
      "
      :restore-focus="restoreConfirmationFocus"
      @cancel="cancelConfirmation"
      @confirm="confirmAction"
    >
      <template
        v-if="confirmation === ConfirmationAction.Remove && removalIdentity"
      >
        ¿Deseas eliminar la factura
        <strong class="font-bold text-ink">{{ removalIdentity.number }}</strong>
        de
        <strong class="font-bold text-ink">{{ removalIdentity.issuer }}</strong>
        ?
      </template>
      <template v-else>
        Hay una corrección sin guardar. ¿Deseas descartarla?
      </template>
    </ConfirmDialog>
  </section>
</template>
