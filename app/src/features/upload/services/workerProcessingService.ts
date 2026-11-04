import {
  ArchiveOmissionReason,
  AvailableResultKind,
  CommitStatus,
  SourceEntryMode,
  SourceEntryStatus,
  WorkerErrorCode,
  WorkerMessageType,
  WorkerStage,
} from '../../../workers/workerProtocol'
import {
  FileResultStatus,
  PreparationKind,
  ProcessingOutcomeKind,
} from '../model/processingStatus'
import { SourceKind } from '../../invoices/domain/persistenceRecords'
import type { Invoice } from '../../invoices/domain/invoiceModel'
import type { ImportRecord } from '../../invoices/domain/persistenceRecords'
import type {
  InvoiceImportSession,
  InvoiceService,
} from '../../invoices/services/invoiceService'
import type {
  ClassifierPackage,
  createClassificationWorkerClient,
} from '../../../workers/workerClient'
import type { ProcessingLimits } from '../../../workers/processingLimits'
import type {
  CommitOutcome,
  EntryIdentity,
  SettledSourceEntry,
  SourceCounts,
  WorkerError,
  WorkerSource,
} from '../../../workers/workerProtocol'
import type {
  FileProcessingResult,
  PreparationState,
  ProcessingOptions,
  ProcessingOutcome,
  ProcessingService,
  SelectedProcessingFile,
} from './processingService'
import { summarizeResults } from '../model/processingLedger'

type Client = Pick<
  ReturnType<typeof createClassificationWorkerClient>,
  'prepare' | 'process' | 'subscribeFailure'
>

interface FileContext {
  file: File
  source: ImportRecord
  settled: Map<number, SettledSourceEntry>
  attempted: boolean
  pending: boolean
}

interface SourceResult {
  saved: Map<string, Invoice>
  issues: Set<string>
  counts?: SourceCounts
  error?: WorkerError | null
  emitted: Map<number, EntryIdentity>
  initialSettled: number
  totalXml: number | null
  finished: boolean
  completedXml: number
}

const writeError = (message: string): WorkerError => ({
  code: WorkerErrorCode.WriteFailed,
  stage: WorkerStage.Persistence,
  message,
  retryable: true,
})

export function createWorkerProcessingService(options: {
  client: Client
  invoices: InvoiceService
  pack: ClassifierPackage
  limits: ProcessingLimits
}): ProcessingService {
  let state: PreparationState = { kind: PreparationKind.Loading }
  let preparing: Promise<void> | undefined

  const listeners = new Set<(state: PreparationState) => void>()
  const contexts = new Map<string, FileContext>()
  let engineFailure = 0

  function publish(next: PreparationState) {
    state = next

    for (const listener of listeners) {
      try {
        listener(next)
      } catch {
        // Un fallo al actualizar la vista no debe interrumpir el Worker ni
        // las escrituras pendientes.
      }
    }
  }

  const stopFailures = options.client.subscribeFailure((error) => {
    engineFailure++
    publish({ kind: PreparationKind.Error, message: error.message })
  })

  async function prepare() {
    if (preparing) {
      return preparing
    }

    if (state.kind === PreparationKind.Ready) {
      return
    }

    publish({ kind: PreparationKind.Loading })
    preparing = options.client
      .prepare(options.pack)
      .then(
        () => publish({ kind: PreparationKind.Ready }),
        (error: unknown) =>
          publish({
            kind: PreparationKind.Error,
            message:
              error instanceof Error
                ? error.message
                : 'No se pudo preparar el modelo de clasificación.',
          }),
      )
      .finally(() => {
        preparing = undefined
      })

    return preparing
  }

  async function processSession(
    inputs: readonly SelectedProcessingFile[],
    hooks: ProcessingOptions,
    session: InvoiceImportSession,
  ): Promise<ProcessingOutcome> {
    const failureAtStart = engineFailure
    const files = new Map<string, FileProcessingResult>()
    const results = new Map<string, SourceResult>()
    const active = new Map<string, FileContext>()
    const seen = new Set(session.sourceNames)
    const sources: WorkerSource[] = []

    let completedXml = 0
    let knownXmlTotal = 0
    let unknownXmlSources = 0
    let completedSources = 0

    for (const input of inputs) {
      const prior = contexts.get(input.id)
      const retry = prior?.file === input.file && prior.pending

      if (!retry && seen.has(input.file.name)) {
        const duplicate: FileProcessingResult = {
          id: input.id,
          name: input.file.name,
          status: FileResultStatus.Duplicate,
          duplicateFileName: input.file.name,
          message: 'Ya existe un archivo con este nombre.',
        }

        files.set(input.id, duplicate)
        hooks.onFileResult(duplicate)
        continue
      }

      seen.add(input.file.name)

      const context = retry
        ? prior
        : {
            file: input.file,
            source: {
              schemaVersion: 1 as const,
              id: crypto.randomUUID(),
              name: input.file.name,
              kind: /\.zip$/i.test(input.file.name)
                ? SourceKind.Zip
                : SourceKind.Xml,
              originalBytes: input.file.size,
              createdAt: new Date().toISOString(),
            },
            settled: new Map<number, SettledSourceEntry>(),
            attempted: false,
            pending: true,
          }

      contexts.set(input.id, context)
      active.set(input.id, context)
      results.set(input.id, {
        saved: new Map(),
        issues: new Set(),
        emitted: new Map(),
        initialSettled: context.settled.size,
        totalXml:
          context.source.kind === SourceKind.Xml
            ? 1 - context.settled.size
            : null,
        finished: false,
        completedXml: 0,
      })

      if (context.source.kind === SourceKind.Xml) {
        knownXmlTotal += 1 - context.settled.size
      } else {
        unknownXmlSources++
      }

      sources.push({
        selectionId: input.id,
        source: context.source,
        file: input.file,
        entries: context.attempted
          ? {
              mode: SourceEntryMode.Retry,
              settledEntries: [...context.settled.values()],
            }
          : { mode: SourceEntryMode.Initial },
      })
      context.attempted = true
    }

    const duplicateFiles = files.size

    function publishProgress(id: string, stage: string) {
      const context = active.get(id)!
      const result = results.get(id)!
      const settled = context.settled.size - result.initialSettled

      completedXml += settled - result.completedXml
      result.completedXml = settled
      hooks.onProgress?.({
        name: context.file.name,
        completed: duplicateFiles + completedSources,
        total: inputs.length,
        stage,
        xml: result.counts ?? {
          knownXml: null,
          finishedXml: 0,
          savedXml: 0,
          failedXml: 0,
          omittedEntries: 0,
        },
        xmlProgress: {
          completed: completedXml,
          total: unknownXmlSources ? null : knownXmlTotal,
        },
      })
    }

    function finishSource(id: string, pending: boolean) {
      const context = active.get(id)!
      const result = results.get(id)!

      context.pending = pending

      const saved = [...result.saved.values()]
      const issues = [...result.issues]
      const savedLabel =
        saved.length === 1 ? 'factura guardada' : 'facturas guardadas'
      const message = [
        saved.length
          ? `${saved.length} ${savedLabel}.`
          : 'No se guardaron facturas nuevas.',
        ...issues,
        pending
          ? 'Quedan entradas pendientes. Puedes volver a Procesar con esta selección.'
          : '',
      ]
        .filter(Boolean)
        .join(' ')
      const file: FileProcessingResult = {
        id,
        name: context.file.name,
        message,
        counts: result.counts,
        issues,
        retryable: pending,
        ...(saved.length
          ? { status: FileResultStatus.Added, invoices: saved }
          : { status: FileResultStatus.Error }),
      }

      files.set(id, file)
      hooks.onFileResult(file)
    }

    let terminal: Awaited<ReturnType<Client['process']>> | undefined
    let failure: string | undefined

    try {
      if (sources.length) {
        terminal = await options.client.process(
          sources,
          options.pack.modelPackage.id,
          {
            signal: hooks.signal,
            limits: options.limits,

            onEvent(event) {
              if (event.type === WorkerMessageType.Progress) {
                const context = active.get(event.selectionId)
                const result = results.get(event.selectionId)

                if (context && result) {
                  result.counts = event.xml

                  if (event.totalXml !== undefined) {
                    if (result.totalXml === null) {
                      unknownXmlSources--
                    } else {
                      knownXmlTotal -= result.totalXml
                    }

                    result.totalXml =
                      event.totalXml === null
                        ? null
                        : Math.max(0, event.totalXml - result.initialSettled)

                    if (result.totalXml === null) {
                      unknownXmlSources++
                    } else {
                      knownXmlTotal += result.totalXml
                    }
                  }

                  publishProgress(event.selectionId, event.stage)
                }
              } else if (event.type === WorkerMessageType.SourceResult) {
                const result = results.get(event.selectionId)

                if (!result) {
                  return
                }

                result.counts = event.counts
                result.error = event.error

                if (event.error) {
                  result.issues.add(
                    `${event.error.code}: ${event.error.message}`,
                  )
                }

                for (const omission of event.omissions) {
                  const reason =
                    omission.reason === ArchiveOmissionReason.NestedZip
                      ? 'ZIP interior omitido.'
                      : 'Archivo no XML omitido.'

                  result.issues.add(`${omission.entryPath}: ${reason}`)
                }

                const context = active.get(event.selectionId)!
                const finished =
                  event.error !== null
                    ? !event.error.retryable
                    : result.totalXml !== null &&
                      context.settled.size - result.initialSettled >=
                        result.totalXml

                if (finished && !result.finished) {
                  result.finished = true
                  completedSources++
                }

                publishProgress(event.selectionId, WorkerStage.Read)
              }
            },

            async onInvoice(event): Promise<CommitOutcome> {
              const context = active.get(event.entry.selectionId)
              const result = results.get(event.entry.selectionId)

              if (!context || !result) {
                return {
                  status: CommitStatus.Rejected,
                  error: writeError(
                    'El resultado no corresponde a la selección actual.',
                  ),
                }
              }

              result.emitted.set(event.entry.entryIndex, event.entry)

              const invoice = event.result.ok
                ? event.result.invoice
                : event.result.available?.kind === AvailableResultKind.Invoice
                  ? event.result.available.invoice
                  : null

              if (!event.result.ok) {
                result.issues.add(
                  `${event.entry.entryPath ?? context.file.name}: ${event.result.error.code}: ${event.result.error.message}`,
                )
              }

              if (!invoice) {
                const error = !event.result.ok
                  ? event.result.error
                  : writeError('No se recibieron datos de factura.')

                if (!error.retryable) {
                  context.settled.set(event.entry.entryIndex, {
                    entryIndex: event.entry.entryIndex,
                    entryPath: event.entry.entryPath,
                    status: SourceEntryStatus.PermanentFailure,
                  })
                }

                publishProgress(
                  event.entry.selectionId,
                  WorkerStage.AwaitingCommit,
                )

                return { status: CommitStatus.Rejected, error }
              }

              try {
                const committed = await session.commit({
                  source: context.source,
                  modelPackage: options.pack.modelPackage,
                  invoice,
                })

                if (!committed.ok) {
                  result.issues.add(committed.message)

                  return {
                    status: CommitStatus.Rejected,
                    error: writeError(committed.message),
                  }
                }

                context.settled.set(event.entry.entryIndex, {
                  entryIndex: event.entry.entryIndex,
                  entryPath: event.entry.entryPath,
                  status: SourceEntryStatus.Saved,
                  invoiceId: committed.value.invoice.id,
                })

                if (committed.value.status === SourceEntryStatus.Saved) {
                  result.saved.set(
                    committed.value.invoice.id,
                    committed.value.invoice,
                  )
                }

                publishProgress(
                  event.entry.selectionId,
                  WorkerStage.AwaitingCommit,
                )

                return {
                  status: committed.value.status,
                  invoiceId: committed.value.invoice.id,
                  revision: committed.value.revision,
                }
              } catch (error) {
                result.issues.add(
                  error instanceof Error
                    ? error.message
                    : 'No se pudo confirmar la escritura.',
                )

                return {
                  status: CommitStatus.Uncertain,
                  error: writeError(
                    'No se pudo confirmar la escritura de la factura.',
                  ),
                }
              }
            },
          },
        )
      }
    } catch (error) {
      failure =
        error instanceof Error ? error.message : 'El Worker se interrumpió.'
    }

    const terminalErrorCode =
      terminal?.type === WorkerMessageType.Failed
        ? terminal.error.code
        : undefined

    if (
      engineFailure === failureAtStart &&
      (failure ||
        (terminal?.type === WorkerMessageType.Failed &&
          [
            WorkerErrorCode.WorkerFailed,
            WorkerErrorCode.ModelUnavailable,
            WorkerErrorCode.ModelFailed,
          ].some((code) => code === terminalErrorCode)))
    ) {
      publish({
        kind: PreparationKind.Error,
        message:
          failure ??
          (terminal?.type === WorkerMessageType.Failed
            ? terminal.error.message
            : 'El modelo dejó de estar disponible.'),
      })
    }

    // Se comprueban las escrituras inciertas antes de reintentar sus entradas
    // para evitar guardar una factura dos veces.
    const notStartedSet = new Set(terminal?.notStartedSelectionIds ?? [])
    const firstNotStarted = sources.findIndex((source) =>
      notStartedSet.has(source.selectionId),
    )
    const interrupted =
      sources[firstNotStarted < 0 ? sources.length - 1 : firstNotStarted - 1]
        ?.selectionId

    for (const [id, context] of active) {
      const result = results.get(id)!

      for (const entry of result.emitted.values()) {
        const saved = session.findSaved(context.source.id, entry.entryIndex)

        if (saved && !context.settled.has(entry.entryIndex)) {
          context.settled.set(entry.entryIndex, {
            entryIndex: entry.entryIndex,
            entryPath: entry.entryPath,
            status: SourceEntryStatus.Saved,
            invoiceId: saved.id,
          })
          result.saved.set(saved.id, saved)
        }
      }

      const notStarted = notStartedSet.has(id)
      const pending = Boolean(
        failure ||
        result.error?.retryable ||
        notStarted ||
        (terminal?.type !== WorkerMessageType.Completed &&
          (!result.counts || (id === interrupted && !result.error))),
      )

      if (terminal?.type === WorkerMessageType.Failed && pending) {
        result.issues.add(terminal.error.message)
      }

      if (failure) {
        result.issues.add(failure)
      }

      publishProgress(id, WorkerStage.AwaitingCommit)
      finishSource(id, pending)
    }

    hooks.onData?.(session.snapshot())

    const confirmed = inputs.flatMap((input) => files.get(input.id) ?? [])
    const notStartedIds = [...(terminal?.notStartedSelectionIds ?? [])]

    if (failure || terminal?.type === WorkerMessageType.Failed) {
      return {
        kind: ProcessingOutcomeKind.Failed,
        files: confirmed,
        notStartedIds,
        message:
          failure ??
          (terminal?.type === WorkerMessageType.Failed
            ? terminal.error.message
            : 'El procesamiento falló.'),
      }
    }

    if (terminal?.type === WorkerMessageType.Cancelled) {
      return {
        kind: ProcessingOutcomeKind.Cancelled,
        files: confirmed,
        notStartedIds,
      }
    }

    return {
      kind: ProcessingOutcomeKind.Completed,
      files: confirmed,
      summary: summarizeResults(confirmed),
    }
  }

  return {
    get available() {
      return state.kind === PreparationKind.Ready
    },

    get state() {
      return state
    },

    prepare,

    subscribe(listener) {
      listeners.add(listener)
      listener(state)

      return () => listeners.delete(listener)
    },

    forgetSelection() {
      contexts.clear()
    },

    dispose() {
      stopFailures()
      listeners.clear()
      contexts.clear()
    },

    async process(inputs, hooks) {
      if (state.kind !== PreparationKind.Ready) {
        return {
          ok: true,
          value: {
            kind: ProcessingOutcomeKind.Unavailable,
            message:
              state.kind === PreparationKind.Error
                ? state.message
                : 'El modelo de clasificación se está preparando.',
          },
        }
      }

      return options.invoices.withImportSession((session) =>
        processSession(inputs, hooks, session),
      )
    },
  }
}
