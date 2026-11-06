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
      return invoices.snapshot.kind === InvoiceSnapshotKind.Ready
        ? undefined
        : 'Consultando tus facturas…'
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
  const admissionIssue = computed(() =>
    interaction?.blocked.value
      ? interaction.message.value || 'Esperando verificar esta pestaña…'
      : undefined,
  )
  const status = computed<OfflineView>(() => {
    const items = [...offline.value.items]
    const classificationIssue =
      admissionIssue.value || storageIssue.value || processing.issue

    items.push({
      label: 'Clasificación de facturas',
      detail: classificationIssue || 'Listo para procesar tus archivos.',
      tone: classificationIssue ? FeedbackTone.Warning : FeedbackTone.Success,
    })

    const blocked = (label: string, detail: string) => {
      items.push({ label, detail, tone: FeedbackTone.Warning })
    }

    const pageIssue = admissionIssue.value || storageIssue.value

    if (pageIssue) {
      blocked('Seleccionar archivos', pageIssue)
    }

    const processingIssue = classificationIssue

    if (processingIssue) {
      blocked('Procesar archivos', processingIssue)
    }

    if (pageIssue) {
      for (const label of [
        'Consultar facturas',
        'Editar categorías',
        'Eliminar facturas',
        'Consultar capacidad',
        'Borrar datos almacenados',
      ]) {
        blocked(label, pageIssue)
      }
    }

    const limited = items.some((item) => item.tone !== FeedbackTone.Success)

    return {
      ...offline.value,
      label: admissionIssue.value
        ? admissionIssue.value
        : storageIssue.value
          ? storageIssue.value
          : limited && offline.value.cacheReady
            ? processing.state.kind === PreparationKind.Loading
              ? 'Preparando el clasificador de facturas…'
              : 'Algunas funciones todavía no están disponibles.'
            : offline.value.label,
      tone:
        offline.value.tone === FeedbackTone.Danger
          ? FeedbackTone.Danger
          : limited || !offline.value.cacheReady
            ? FeedbackTone.Warning
            : offline.value.tone,
      items,
    }
  })

  const recovering = shallowRef(false)
  const preparationNeedsRetry = computed(
    () =>
      Boolean(offline.value.canRetry) ||
      processing.state.kind === PreparationKind.Error ||
      Boolean(interaction?.blocked.value),
  )
  const retrying = computed(
    () =>
      recovering.value ||
      invoices.snapshot.kind === InvoiceSnapshotKind.Loading ||
      Boolean(offline.value.preparing) ||
      (processing.state.kind === PreparationKind.Loading &&
        !interaction?.blocked.value),
  )
  const canRetry = computed(
    () => Boolean(storageIssue.value) || preparationNeedsRetry.value,
  )

  async function retry() {
    if (retrying.value || offline.value.updatePending || !canRetry.value) {
      return
    }

    const refreshStorage = Boolean(storageIssue.value)
    const prepareProcessing = preparationNeedsRetry.value

    recovering.value = true

    try {
      const recovery: Promise<unknown>[] = []

      if (refreshStorage) {
        recovery.push(invoices.refresh())
      }

      if (prepareProcessing) {
        recovery.push(
          (async () => {
            await service.retry()

            if (!interaction?.blocked.value && !processing.available) {
              await processing.retry()
            }
          })(),
        )
      }

      // Cada capacidad publica su estado; el fallo de una no cancela la otra.
      await Promise.allSettled(recovery)
    } finally {
      recovering.value = false
    }
  }

  return {
    status,
    canRetry,
    retrying,
    retry,
    applyUpdate: service.applyUpdate,
  }
}
