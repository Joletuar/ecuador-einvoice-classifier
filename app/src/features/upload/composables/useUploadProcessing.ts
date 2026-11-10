import { computed, onScopeDispose, shallowRef } from 'vue'

import { ProcessingOutcomeKind } from '../model/processingStatus'
import {
  ActivityMetric,
  ActivityOperation,
  ActivityPhase,
} from '../model/activity'
import type { InvoiceData } from '../../invoices/domain/storageModel'
import type { BatchActivity } from '../model/activity'
import {
  createProcessingLedger,
  summarizeResults,
} from '../model/processingLedger'
import type {
  FileProcessingResult,
  ProcessingOutcome,
  ProcessingService,
  ProcessingSummary,
  SelectedProcessingFile,
} from '../services/processingService'
import { usePaintYield } from './usePaintYield'

type CompletedOutcome = Extract<
  ProcessingOutcome,
  { kind: typeof ProcessingOutcomeKind.Completed }
>

interface ProcessingEffects {
  publish(data: InvoiceData): void
  reconcileSelection(
    results: FileProcessingResult[],
    pending: ReadonlySet<string>,
  ): void
  finished?(savedInvoices: number): void
}

export function useUploadProcessing(
  service: ProcessingService,
  effects: ProcessingEffects,
) {
  const activity = shallowRef<BatchActivity>({
    operation: ActivityOperation.Processing,
    phase: ActivityPhase.Idle,
    metric: ActivityMetric.Finished,
    completed: 0,
    total: 0,
  })

  const results = shallowRef<FileProcessingResult[]>([])
  const outcome = shallowRef<CompletedOutcome>()
  const confirmedSummary = shallowRef<ProcessingSummary>()
  const notice = shallowRef<string>()
  const attemptId = shallowRef(0)

  const busy = shallowRef(false)
  const cancelling = shallowRef(false)
  const canCancel = computed(() => busy.value && !cancelling.value)

  const paint = usePaintYield()
  let controller: AbortController | undefined
  let progressFrame: number | undefined

  function stopProgress() {
    if (progressFrame === undefined) {
      return
    }

    cancelAnimationFrame(progressFrame)
    progressFrame = undefined
  }

  let alive = true

  onScopeDispose(() => {
    alive = false
    controller?.abort()
    stopProgress()
    service.forgetSelection?.()
  })

  async function start(selected: readonly SelectedProcessingFile[]) {
    if (busy.value || !selected.length) {
      return
    }

    const inputs = selected.map(({ id, file }) => Object.freeze({ id, file }))
    const ledger = createProcessingLedger(inputs)

    controller = new AbortController()
    busy.value = true
    cancelling.value = false
    attemptId.value++
    outcome.value = undefined
    results.value = []
    confirmedSummary.value = undefined
    notice.value = undefined
    activity.value = {
      operation: ActivityOperation.Processing,
      phase: ActivityPhase.Processing,
      metric: ActivityMetric.Finished,
      completed: 0,
      total: inputs.length,
    }

    try {
      await paint()

      const response = await service.process(inputs, {
        signal: controller.signal,

        onData(data) {
          if (alive) {
            effects.publish(data)
          }
        },

        onProgress(progress) {
          if (!alive) {
            return
          }

          activity.value = {
            ...activity.value,
            completed: progress.completed,
            total: progress.total,
            xml: progress.xml,
            xmlProgress: progress.xmlProgress,
            sourceName: progress.name,
            stage: progress.stage,
          }
        },

        onFileResult(result) {
          const accepted = ledger.record(result)

          if (!accepted.ok) {
            controller?.abort()
          }

          if (!alive) {
            return
          }

          if (progressFrame === undefined) {
            progressFrame = requestAnimationFrame(() => {
              progressFrame = undefined

              if (!alive) {
                return
              }

              results.value = ledger.results()
              confirmedSummary.value = summarizeResults(results.value)
              activity.value = {
                ...activity.value,
                completed: Math.max(
                  activity.value.completed,
                  results.value.filter((file) => !file.retryable).length,
                ),
                summary: confirmedSummary.value,
              }
            })
          }
        },
      })

      if (!alive) {
        return
      }

      stopProgress()

      if (!response.ok) {
        notice.value = response.message
        activity.value = {
          ...activity.value,
          phase: ActivityPhase.Failed,
          message: response.message,
        }

        return
      }

      const value = response.value

      if (value.kind === ProcessingOutcomeKind.Unavailable) {
        notice.value = value.message
        activity.value = {
          ...activity.value,
          phase: ActivityPhase.Unavailable,
          message: value.message,
        }

        return
      }

      const files = value.files ?? ledger.results()

      if (value.kind === ProcessingOutcomeKind.Completed) {
        const checked = ledger.complete(value)

        if (!checked.ok) {
          notice.value = checked.message
        } else {
          outcome.value = value
        }
      }

      results.value = files
      confirmedSummary.value = summarizeResults(files)

      const pending = new Set(
        files.filter((file) => file.retryable).map((file) => file.id),
      )

      for (const id of value.kind !== ProcessingOutcomeKind.Completed
        ? (value.notStartedIds ?? [])
        : []) {
        pending.add(id)
      }

      effects.reconcileSelection(files, pending)
      effects.finished?.(confirmedSummary.value.saved)
      notice.value ??=
        value.kind === ProcessingOutcomeKind.Failed
          ? value.message
          : value.kind === ProcessingOutcomeKind.Cancelled
            ? 'Procesamiento cancelado, las facturas procesadas se guardaron correctamente.'
            : undefined
      activity.value = {
        ...activity.value,
        phase: ledger.error() ? ActivityPhase.Failed : value.kind,
        completed: files.filter((file) => !file.retryable).length,
        summary: confirmedSummary.value,
        message: notice.value,
      }
    } catch (error) {
      if (!alive) {
        return
      }

      notice.value =
        error instanceof Error
          ? error.message
          : 'No se pudo completar el procesamiento.'
      activity.value = {
        ...activity.value,
        phase: ActivityPhase.Failed,
        message: notice.value,
      }
    } finally {
      stopProgress()
      busy.value = false
      cancelling.value = false
      controller = undefined
    }
  }

  function cancel() {
    if (!canCancel.value) {
      return
    }

    cancelling.value = true
    controller?.abort()
    activity.value = {
      ...activity.value,
      phase: ActivityPhase.Finalizing,
      message: 'Terminando de guardar antes de cancelar…',
    }
  }

  function clear() {
    if (busy.value) {
      return
    }

    service.forgetSelection?.()
    results.value = []
    outcome.value = undefined
    confirmedSummary.value = undefined
    notice.value = undefined
    activity.value = {
      operation: ActivityOperation.Processing,
      phase: ActivityPhase.Idle,
      metric: ActivityMetric.Finished,
      completed: 0,
      total: 0,
    }
  }

  return {
    activity,
    results,
    outcome,
    confirmedSummary,
    notice,
    attemptId,
    busy,
    canCancel,
    start,
    cancel,
    clear,
  }
}
