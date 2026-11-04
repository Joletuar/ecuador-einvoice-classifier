import { computed, onScopeDispose, shallowRef } from 'vue'

import { InvoiceSnapshotKind } from '../../invoices/domain/invoiceSnapshot'
import { StorageErrorCode } from '../../invoices/domain/storageErrors'
import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import { PreparationKind } from '../../upload/model/processingStatus'
import { useOfflineService, type OfflineView } from '../services/offlineService'
import { useInvoiceStore } from '../../invoices/stores/useInvoiceStore'
import { useProcessingAvailability } from '../../upload/stores/useProcessingAvailability'
import { useUpdateInteraction } from '../../../app/updateCoordinator'

export function useOfflineStatus() {
  const service = useOfflineService()
  const invoices = useInvoiceStore()
  const processing = useProcessingAvailability()
  const interaction = useUpdateInteraction()

  const offline = shallowRef(service.current())
  const unsubscribe = service.subscribe((next) => {
    offline.value = next
  })

  onScopeDispose(unsubscribe)

  const storageIssue = computed(() => {
    if (invoices.snapshot.kind !== InvoiceSnapshotKind.Error) {
      return undefined
    }

    const issueCode = invoices.snapshot.code
    const storageUnavailable = [
      StorageErrorCode.NotAvailable,
      StorageErrorCode.Unavailable,
    ].some((code) => code === issueCode)

    return storageUnavailable
      ? 'El almacenamiento local no está disponible.'
      : invoices.snapshot.message
  })
  const status = computed<OfflineView>(() => {
    const items = [...offline.value.items]

    items.push({
      label: 'Clasificación de facturas',
      detail: processing.available
        ? 'Listo para procesar tus archivos.'
        : processing.issue,
      tone: processing.available ? FeedbackTone.Success : FeedbackTone.Warning,
    })

    const blocked = (label: string, detail: string) => {
      items.push({ label, detail, tone: FeedbackTone.Warning })
    }

    if (storageIssue.value) {
      blocked('Seleccionar archivos', storageIssue.value)
    }

    const processingIssue = processing.issue || storageIssue.value

    if (processingIssue) {
      blocked('Procesar archivos', processingIssue)
    }

    if (storageIssue.value) {
      for (const label of [
        'Consultar facturas',
        'Editar categorías',
        'Eliminar facturas',
        'Consultar capacidad',
        'Borrar datos almacenados',
      ]) {
        blocked(label, storageIssue.value)
      }
    }

    const limited = items.some((item) => item.tone !== FeedbackTone.Success)

    return {
      ...offline.value,
      tone:
        offline.value.tone === FeedbackTone.Danger
          ? FeedbackTone.Danger
          : limited || !offline.value.cacheReady
            ? FeedbackTone.Warning
            : offline.value.tone,
      items,
    }
  })

  return {
    status,
    storageIssue,
    processingState: computed(() => processing.state),
    canRetryPreparation: computed(
      () =>
        Boolean(offline.value.canRetry) ||
        processing.state.kind === PreparationKind.Error ||
        Boolean(interaction?.blocked.value),
    ),
    retryingPreparation: computed(
      () =>
        Boolean(offline.value.preparing) ||
        (processing.state.kind === PreparationKind.Loading &&
          !interaction?.blocked.value),
    ),

    async retryProcessing() {
      await service.retry()

      if (!interaction?.blocked.value) {
        await processing.retry()
      }
    },

    applyUpdate: service.applyUpdate,
  }
}
