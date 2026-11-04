import { computed, onScopeDispose, shallowRef } from 'vue'
import { toast } from 'vue-sonner'

import { InvoiceSnapshotKind } from '../domain/invoiceSnapshot'
import { useInvoiceService } from '../services/invoiceService'
import { useInvoiceStore } from '../stores/useInvoiceStore'
import { useInvoiceListStore } from '../stores/useInvoiceListStore'
import { useUpdateInteraction } from '../../../app/updateCoordinator'

export function useStoredDataRemoval(isBlocked: () => boolean) {
  const service = useInvoiceService()
  const invoices = useInvoiceStore()
  const preferences = useInvoiceListStore()
  const interaction = useUpdateInteraction()

  const pending = shallowRef(false)
  const busy = shallowRef(false)
  const error = shallowRef('')
  let active = true

  onScopeDispose(() => {
    active = false
  })

  const disabled = computed(
    () =>
      isBlocked() ||
      Boolean(interaction?.blocked.value) ||
      busy.value ||
      invoices.snapshot.kind !== InvoiceSnapshotKind.Ready ||
      invoices.snapshot.usage.files === 0,
  )
  const description = computed(() => {
    if (invoices.snapshot.kind !== InvoiceSnapshotKind.Ready) {
      return undefined
    }

    const count = invoices.snapshot.invoices.length
    const files = invoices.snapshot.usage.files

    return {
      action: count === 1 ? 'Se eliminará' : 'Se eliminarán',
      invoices: `${count} ${count === 1 ? 'factura' : 'facturas'}`,
      files: `${files} ${files === 1 ? 'archivo almacenado' : 'archivos almacenados'}`,
      bytes: invoices.snapshot.usage.bytes,
    }
  })

  function request() {
    if (!active || disabled.value) {
      return
    }

    error.value = ''
    pending.value = true
  }

  function cancel() {
    if (busy.value) {
      return
    }

    pending.value = false
    error.value = ''
  }

  async function confirm(): Promise<boolean> {
    if (!active || !pending.value || disabled.value) {
      return false
    }

    busy.value = true
    error.value = ''
    invoices.invalidateReads()

    try {
      const result = await service.clearAll()

      if (!active) {
        return false
      }

      if (!result.ok) {
        error.value = result.message

        return false
      }

      preferences.resetCollection()
      pending.value = false
      busy.value = false
      invoices.publish(result.value)
      toast.success('Datos almacenados eliminados.')

      return true
    } catch {
      if (active) {
        error.value =
          'No se pudieron borrar los datos almacenados. Los datos anteriores se mantienen.'
      }

      return false
    } finally {
      if (active) {
        busy.value = false
      }
    }
  }

  return {
    pending,
    busy,
    error,
    disabled,
    description,
    request,
    cancel,
    confirm,
  }
}
