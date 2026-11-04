import { onScopeDispose, shallowRef } from 'vue'
import { toast } from 'vue-sonner'
import { useInvoiceService } from '../services/invoiceService'
import { useInvoiceStore } from '../stores/useInvoiceStore'
import { useInvoiceListStore } from '../stores/useInvoiceListStore'
import { useUpdateInteraction } from '../../../app/updateCoordinator'

export function useInvoiceRemoval() {
  const service = useInvoiceService()
  const store = useInvoiceStore()
  const interaction = useUpdateInteraction()
  const preferences = useInvoiceListStore()

  const pendingId = shallowRef<string | null>(null)
  const busy = shallowRef(false)
  const error = shallowRef('')
  let alive = true

  onScopeDispose(() => {
    alive = false
  })

  function request(id: string) {
    if (busy.value || interaction?.blocked.value) {
      return
    }

    error.value = ''
    pendingId.value = id
  }

  function cancel() {
    if (!busy.value) {
      pendingId.value = null
    }
  }

  async function confirm(): Promise<boolean> {
    const id = pendingId.value

    if (!id || busy.value || !alive || interaction?.blocked.value) {
      return false
    }

    busy.value = true
    store.invalidateReads()

    try {
      const result = await service.remove(id)

      if (!alive) {
        return false
      }

      if (!result.ok) {
        error.value = result.message
        toast.error(error.value)

        return false
      }

      preferences.forgetInvoice(id)

      // Se libera el bloqueo de navegación antes de publicar el resultado. Si
      // se borró la última factura, la aplicación debe poder volver a Cargar.
      busy.value = false
      pendingId.value = null
      store.publish(result.value)
      toast.success('Factura eliminada.')

      return true
    } catch {
      if (alive) {
        error.value = 'No se pudo eliminar la factura.'
        toast.error(error.value)
      }

      return false
    } finally {
      if (alive) {
        busy.value = false
        pendingId.value = null
      }
    }
  }

  return { pendingId, busy, error, request, cancel, confirm }
}
