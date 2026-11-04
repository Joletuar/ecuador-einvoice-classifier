import {
  ProcessingErrorCode,
  FileResultStatus,
  ProcessingOutcomeKind,
} from './processingStatus'
import type { Result } from '../../../shared/lib/result'
import { validateInvoicePayload } from '../../invoices/domain/invoicePayload'
import type {
  FileProcessingResult,
  ProcessingOutcome,
  ProcessingSummary,
  SelectedProcessingFile,
} from '../services/processingService'

export function summarizeResults(
  results: readonly FileProcessingResult[],
): ProcessingSummary {
  return {
    added: results.filter((result) => result.status === FileResultStatus.Added)
      .length,
    duplicates: results.filter(
      (result) => result.status === FileResultStatus.Duplicate,
    ).length,
    failed: results.filter(
      (result) =>
        result.status === FileResultStatus.Error ||
        Boolean(result.issues?.length),
    ).length,
    saved: new Set(
      results.flatMap((result) =>
        result.status === FileResultStatus.Added
          ? result.invoices.map((invoice) => invoice.id)
          : [],
      ),
    ).size,
  }
}

export function createProcessingLedger(
  inputs: readonly SelectedProcessingFile[],
) {
  const selected = new Map(inputs.map((input) => [input.id, input]))
  const confirmed = new Map<string, FileProcessingResult>()
  let failure: string | undefined

  function fail(message: string): Result<void> {
    failure = message

    return { ok: false, code: ProcessingErrorCode.Unresolved, message }
  }

  function record(result: FileProcessingResult): Result<void> {
    if (failure) {
      return {
        ok: false,
        code: ProcessingErrorCode.Unresolved,
        message: failure,
      }
    }

    const input = selected.get(result?.id)

    if (
      !input ||
      result.name !== input.file.name ||
      typeof result.message !== 'string' ||
      (result.status === FileResultStatus.Added &&
        (!result.invoices.length ||
          !result.invoices.every(validateInvoicePayload)))
    ) {
      return fail(
        'El resultado recibido no corresponde a los archivos seleccionados.',
      )
    }

    const previous = confirmed.get(result.id)

    if (previous && JSON.stringify(previous) !== JSON.stringify(result)) {
      return fail('El procesador cambió un resultado ya confirmado.')
    }

    confirmed.set(result.id, structuredClone(result))

    return { ok: true, value: undefined }
  }

  function complete(
    outcome: Extract<
      ProcessingOutcome,
      { kind: typeof ProcessingOutcomeKind.Completed }
    >,
  ): Result<void> {
    if (
      outcome.files.length !== selected.size ||
      new Set(outcome.files.map((file) => file.id)).size !== selected.size
    ) {
      return fail('No se pudieron confirmar todos los resultados por archivo.')
    }

    for (const result of outcome.files) {
      const accepted = record(result)

      if (!accepted.ok) {
        return accepted
      }
    }

    if (
      JSON.stringify(summarizeResults(outcome.files)) !==
      JSON.stringify(outcome.summary)
    ) {
      return fail('El resumen no coincide con las facturas guardadas.')
    }

    return { ok: true, value: undefined }
  }

  function notStarted(ids: readonly string[] = []): Result<Set<string>> {
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !selected.has(id))
    ) {
      return {
        ok: false,
        code: ProcessingErrorCode.Unresolved,
        message: 'No se pudieron confirmar los archivos pendientes.',
      }
    }

    return { ok: true, value: new Set(ids) }
  }

  return {
    record,
    complete,
    notStarted,

    results: () =>
      [...confirmed.values()].map((result) => structuredClone(result)),

    error: () => failure,
  }
}
