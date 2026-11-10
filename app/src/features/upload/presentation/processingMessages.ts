import { FileResultStatus } from '../model/processingStatus'
import {
  ActivityOperation,
  ActivityPhase,
  type BatchActivity,
} from '../model/activity'
import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import type { FileProcessingResult } from '../services/processingService'

export const pendingFileMessage =
  'El procesamiento quedó pendiente y puedes volver a intentarlo.'

export function fileResultMessage(result: FileProcessingResult): string {
  if (result.status === FileResultStatus.Pending) {
    return pendingFileMessage
  }

  if (result.status === FileResultStatus.Error) {
    return result.retryable
      ? 'No se pudo procesar este archivo. Puedes volver a intentarlo.'
      : 'Hubo un problema al procesar este archivo.'
  }

  if (
    result.issues?.length ||
    result.counts?.failedXml ||
    result.counts?.omittedEntries
  ) {
    return 'Se guardaron facturas, pero hubo inconvenientes durante el procesamiento.'
  }

  if (result.retryable) {
    return pendingFileMessage
  }

  if (result.status === FileResultStatus.Duplicate) {
    return 'Las facturas de este archivo ya estaban guardadas.'
  }

  return result.invoices.length === 1
    ? 'La factura se guardó correctamente.'
    : 'Las facturas se guardaron correctamente.'
}

export function batchActivityMessage(
  activity: BatchActivity,
): string | undefined {
  if (
    activity.operation === ActivityOperation.Processing &&
    activity.phase === ActivityPhase.Failed &&
    activity.tone !== FeedbackTone.Warning
  ) {
    return 'Hubo un problema al procesar los archivos.'
  }

  return activity.message
}
