<script setup lang="ts">
import {
  computed,
  nextTick,
  onScopeDispose,
  shallowRef,
  useTemplateRef,
  watch,
} from 'vue'
import { ChevronDown, HardDrive } from 'lucide-vue-next'
import {
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger,
} from 'reka-ui'

import { InvoiceSnapshotKind } from '../domain/invoiceSnapshot'
import { useStorageLimits } from '../../../app/config/storageLimits'
import { useLeaveProtection } from '../../../app/composables/useLeaveProtection'
import ConfirmDialog from '../../../shared/ui/ConfirmDialog.vue'
import StorageCapacity from '../../upload/components/StorageCapacity.vue'
import { useStoredDataRemoval } from '../composables/useStoredDataRemoval'
import { useInvoiceStore } from '../stores/useInvoiceStore'

const invoices = useInvoiceStore()
const limits = useStorageLimits()
const protection = useLeaveProtection()

const open = shallowRef(false)
const trigger =
  useTemplateRef<InstanceType<typeof PopoverTrigger>>('storageTrigger')

const pageBlocked = () => protection.isPageBlocked() || protection.isDirty()
const removal = useStoredDataRemoval(pageBlocked)

const unregister = protection.registerGlobalBlocker(
  () => removal.pending.value || removal.busy.value,
)

onScopeDispose(unregister)

const usage = computed(() =>
  invoices.snapshot.kind === InvoiceSnapshotKind.Ready
    ? invoices.snapshot.usage
    : undefined,
)

let closingForConfirmation = false

function focusTrigger() {
  const element = trigger.value?.$el

  if (element instanceof HTMLElement) {
    element.focus()
  }
}

async function requestRemoval() {
  if (removal.disabled.value) {
    return
  }

  closingForConfirmation = open.value
  open.value = false

  await nextTick()

  focusTrigger()

  removal.request()
}

function closePopoverFocus(event: Event) {
  if (!closingForConfirmation) {
    return
  }

  event.preventDefault()
  closingForConfirmation = false
}

watch(
  removal.pending,
  async (pending, wasPending) => {
    if (pending || !wasPending) {
      return
    }

    await nextTick()

    focusTrigger()
  },
  { flush: 'post' },
)
</script>

<template>
  <PopoverRoot v-model:open="open">
    <PopoverTrigger
      ref="storageTrigger"
      as-child
    >
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded-full border border-line bg-surface px-2 py-1 text-xs font-semibold whitespace-nowrap text-ink hover:bg-primary-soft sm:gap-1.5 sm:px-3"
      >
        <HardDrive
          :size="14"
          aria-hidden="true"
        />
        Almacenamiento
        <ChevronDown
          :size="14"
          aria-hidden="true"
        />
      </button>
    </PopoverTrigger>
    <PopoverPortal>
      <PopoverContent
        align="end"
        :side-offset="8"
        :collision-padding="16"
        class="z-60 max-h-[min(36rem,var(--reka-popover-content-available-height))] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-card border border-line bg-surface p-4 text-left shadow-lg"
        @close-auto-focus="closePopoverFocus"
      >
        <h2 class="mb-4 text-sm font-bold text-ink">
          Almacenamiento del navegador
        </h2>
        <StorageCapacity
          :usage="usage"
          :limits="limits"
          :unavailable="invoices.snapshot.kind === InvoiceSnapshotKind.Error"
          :clear-disabled="removal.disabled.value || removal.pending.value"
          :clearing="removal.busy.value"
          @clear="requestRemoval"
        />
        <p
          v-if="invoices.snapshot.kind === InvoiceSnapshotKind.Error"
          role="alert"
          class="mt-3 text-sm text-danger"
        >
          {{ invoices.snapshot.message }}
        </p>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
  <ConfirmDialog
    :open="removal.pending.value"
    title="Borrar datos almacenados"
    :confirm-label="
      removal.busy.value ? 'Borrando datos…' : 'Borrar todos los datos'
    "
    :busy="removal.busy.value"
    :confirm-disabled="removal.disabled.value"
    :restore-focus="false"
    @cancel="removal.cancel"
    @confirm="removal.confirm"
  >
    <template v-if="removal.description.value">
      <span>
        {{ removal.description.value.action }}
        <strong class="font-bold text-ink">
          {{ removal.description.value.invoices }}
        </strong>
        de
        <strong class="font-bold text-ink">
          {{ removal.description.value.files }}
        </strong>
        junto con las correcciones que haz hecho.
      </span>
    </template>
    <strong class="mt-5 block font-bold text-black text-base">
      Esta acción no se puede deshacer.
    </strong>
    <template #feedback>
      <p
        v-if="removal.error.value"
        role="alert"
        class="mt-4 text-sm text-danger"
      >
        {{ removal.error.value }}
      </p>
    </template>
  </ConfirmDialog>
</template>
