import {
  AvailableResultKind,
  CommitStatus,
  SourceEntryMode,
  WorkerErrorCode,
  WorkerMessageType,
  WorkerPreparationState,
  WorkerStage,
} from './workerProtocol'
import {
  InvoiceIssueCode,
  RuleStatus,
  SelectionMode,
} from '../features/invoices/domain/classificationModel'
import { SourceKind } from '../features/invoices/domain/persistenceRecords'
import { classifyInvoice } from '../features/invoices/domain/invoiceRules'
import type {
  ConceptRecord,
  InvoiceIssue,
} from '../features/invoices/domain/classificationModel'
import {
  createOnnxConceptClassifier,
  ConceptClassificationFailure,
} from './onnxConceptClassifier'
import {
  blobChunks,
  checkCancellation,
  checkpoint,
  failure,
  ProcessingCancelled,
  ProcessingFailure,
  validateLimits,
  type ProcessingLimits,
  type WorkControl,
} from './processingLimits'
import { readInvoiceXml } from './xmlInvoiceReader'
import { readZipInvoices, type ZipReadState } from './zipInvoiceReader'
import { countZipXml } from './zipContainer'
import type {
  CommitOutcome,
  EntryIdentity,
  InvoiceResult,
  SourceCounts,
  WorkerError,
  WorkerEvent,
  WorkerRequest,
  WorkerSource,
} from './workerProtocol'

type ProcessRequest = Extract<
  WorkerRequest,
  { type: typeof WorkerMessageType.Process }
>

type Classifier = ReturnType<typeof createOnnxConceptClassifier>

type EventPayload<T = WorkerEvent> = T extends WorkerEvent
  ? Omit<T, 'requestId' | 'attemptId'>
  : never

type MutableCounts = {
  -readonly [Key in keyof SourceCounts]: SourceCounts[Key]
}

interface Attempt {
  request: ProcessRequest
  cancelled: boolean
  sourceIndex: number
  sourceStarted: boolean
  currentEntry: EntryIdentity | null
  lastEmittedResultId: string | null
  unconfirmed: Map<
    string,
    {
      entry: EntryIdentity
      resolve(outcome: CommitOutcome): void
    }
  >
  done: Promise<void>
}

function detail(error: unknown, stage: WorkerError['stage']): WorkerError {
  return error instanceof ProcessingFailure
    ? error.detail
    : {
        code: WorkerErrorCode.WorkerFailed,
        stage,
        message: 'No se pudo completar el procesamiento.',
        retryable: true,
      }
}

export function createWorkerController(
  emit: (event: WorkerEvent) => void,
  classifier: Classifier = createOnnxConceptClassifier(),
) {
  let active: Attempt | null = null
  let preparing: Promise<void> | null = null
  let disposed = false
  const event = (request: WorkerRequest, value: EventPayload) =>
    emit({
      ...value,
      requestId: request.requestId,
      attemptId: request.attemptId,
    } as WorkerEvent)

  async function entryResult(
    source: WorkerSource,
    entry: EntryIdentity,
    chunks: AsyncIterable<Uint8Array>,
    limits: ProcessingLimits,
    control: WorkControl,
    onStage: (stage: typeof WorkerStage.Xml | typeof WorkerStage.Model) => void,
  ): Promise<InvoiceResult> {
    try {
      const id = `${source.source.id}:entry:${entry.entryIndex}`

      onStage(WorkerStage.Xml)

      const parsed = await readInvoiceXml(chunks, id, limits, control)

      onStage(WorkerStage.Model)

      const concepts = (await classifier.classify(
        parsed.concepts,
        limits.batchSize,
        control,
      )) as [ConceptRecord, ...ConceptRecord[]]

      const evaluation = classifyInvoice(
        concepts,
        classifier.currentPackage()!.classes,
      )
      const issues: InvoiceIssue[] = [...parsed.issues, ...evaluation.issues]

      for (const concept of concepts) {
        if (concept.prediction.status === 2) {
          issues.push({
            code: InvoiceIssueCode.InvalidUnicode,
            stage: WorkerStage.Model,
            field: `/concepts/${concept.position}/description`,
            conceptId: concept.id,
          })
        }
      }

      if (evaluation.result.status === RuleStatus.Unassigned) {
        issues.push({
          code: InvoiceIssueCode.UnresolvedInvoiceCategory,
          stage: WorkerStage.InvoiceRules,
          field: '/classification/automatic',
          conceptId: null,
        })
      }

      const now = new Date().toISOString()
      const invoice = {
        schemaVersion: 1,
        id,
        importId: source.source.id,
        entryIndex: entry.entryIndex,
        entryPath: entry.entryPath,
        modelPackageId: classifier.currentPackage()!.id,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        issuer: parsed.issuer,
        buyer: parsed.buyer,
        number: parsed.number,
        date: parsed.date,
        currency: parsed.currency,
        total: parsed.total,
        concepts,
        issues,
      }
      const classification = {
        initial: evaluation.result,
        automatic: evaluation.result,
        selection: { mode: SelectionMode.Automatic },
      }

      if (evaluation.result.status === RuleStatus.Unassigned) {
        return {
          ok: false,
          error: {
            code: evaluation.result.reason,
            stage: WorkerStage.InvoiceRules,
            message:
              'No se pudo asignar la categoría de factura. Se conservan los resultados disponibles.',
            retryable: false,
          },
          available: {
            kind: AvailableResultKind.Invoice,
            invoice: {
              ...invoice,
              schemaVersion: 1,
              classification: {
                ...classification,
                automatic: evaluation.result,
              },
            },
          },
        }
      }

      return {
        ok: true,
        invoice: {
          ...invoice,
          schemaVersion: 1,
          classification: { ...classification, automatic: evaluation.result },
        },
      }
    } catch (error) {
      if (error instanceof ProcessingCancelled) {
        throw error
      }

      return {
        ok: false,
        error: detail(error, WorkerStage.Xml),
        available:
          error instanceof ConceptClassificationFailure && error.concepts.length
            ? { kind: AvailableResultKind.Concepts, concepts: error.concepts }
            : null,
      }
    }
  }

  async function confirm(
    attempt: Attempt,
    entry: EntryIdentity,
    result: InvoiceResult,
    counts: MutableCounts,
  ) {
    const resultId = `${attempt.request.attemptId}:${entry.selectionId}:${entry.entryIndex}`

    attempt.lastEmittedResultId = resultId

    const acknowledgment = new Promise<CommitOutcome>((resolve) =>
      attempt.unconfirmed.set(resultId, { entry, resolve }),
    )

    event(attempt.request, {
      type: WorkerMessageType.InvoiceResult,
      entry,
      resultId,
      result,
    })

    const outcome = await acknowledgment

    if (outcome.status === CommitStatus.Uncertain) {
      throw new ProcessingFailure(outcome.error)
    }

    attempt.unconfirmed.delete(resultId)

    const saved =
      outcome.status === CommitStatus.Saved ||
      outcome.status === CommitStatus.AlreadySaved

    if (
      saved &&
      !result.ok &&
      result.available?.kind !== AvailableResultKind.Invoice
    ) {
      throw failure(
        WorkerErrorCode.WriteFailed,
        WorkerStage.Persistence,
        'No puede confirmarse una factura sin datos completos.',
        true,
      )
    }

    if (saved) {
      counts.savedXml++
    }

    if (!result.ok || !saved) {
      counts.failedXml++
    }

    counts.finishedXml++

    if (outcome.status === CommitStatus.Rejected && outcome.error.retryable) {
      throw new ProcessingFailure(outcome.error)
    }

    if (!result.ok && result.error.retryable) {
      throw new ProcessingFailure(result.error)
    }

    attempt.currentEntry = null
  }

  async function process(attempt: Attempt) {
    const request = attempt.request
    const control: WorkControl = {
      cancelled: () => attempt.cancelled || disposed,

      yield: () => new Promise((resolve) => setTimeout(resolve, 0)),
    }
    let terminal: WorkerError | null = null

    try {
      if (request.sources.length) {
        validateLimits(request.limits!)

        if (classifier.currentPackage()?.id !== request.modelPackageId) {
          throw failure(
            WorkerErrorCode.ModelUnavailable,
            WorkerStage.Model,
            'El paquete solicitado no está preparado.',
            true,
          )
        }
      }

      const limits = request.limits!

      for (
        ;
        attempt.sourceIndex < request.sources.length;
        attempt.sourceIndex++
      ) {
        attempt.sourceStarted = false
        checkCancellation(control)
        attempt.sourceStarted = true

        const source = request.sources[attempt.sourceIndex]
        const counts: MutableCounts = {
          knownXml: source.source.kind === SourceKind.Xml ? 1 : null,
          finishedXml: 0,
          savedXml: 0,
          failedXml: 0,
          omittedEntries: 0,
        }
        const zip: ZipReadState = { knownXml: 0, omissions: [] }
        let totalXml: number | null =
          source.source.kind === SourceKind.Xml ? 1 : null
        const progress = (
          stage: Extract<
            WorkerEvent,
            { type: typeof WorkerMessageType.Progress }
          >['stage'],
        ) =>
          event(request, {
            type: WorkerMessageType.Progress,
            selectionId: source.selectionId,
            importId: source.source.id,
            stage,
            totalXml,
            outerFiles: {
              total: request.sources.length,
              finished: attempt.sourceIndex,
            },
            xml: { ...counts },
          })
        let sourceError: WorkerError | null = null

        try {
          progress(WorkerStage.Read)

          if (source.source.kind === SourceKind.Xml) {
            const settled =
              source.entries.mode === SourceEntryMode.Retry &&
              source.entries.settledEntries.some(
                (entry) => entry.entryIndex === 0 && entry.entryPath === null,
              )

            if (!settled) {
              const entry = {
                selectionId: source.selectionId,
                importId: source.source.id,
                entryIndex: 0,
                entryPath: null,
              }

              attempt.currentEntry = entry

              const result = await entryResult(
                source,
                entry,
                blobChunks(source.file, limits, control),
                limits,
                control,
                progress,
              )

              checkCancellation(control)
              progress(WorkerStage.AwaitingCommit)

              await confirm(attempt, entry, result, counts)
            }
          } else {
            progress(WorkerStage.Zip)

            totalXml = await countZipXml(source.file, limits, control)

            progress(WorkerStage.Zip)

            for await (const extracted of readZipInvoices(
              source.file,
              source.entries,
              limits,
              control,
              zip,
            )) {
              counts.knownXml = zip.knownXml

              const entry = {
                selectionId: source.selectionId,
                importId: source.source.id,
                entryIndex: extracted.entryIndex,
                entryPath: extracted.entryPath,
              }

              attempt.currentEntry = entry

              const chunks = async function* () {
                for (const chunk of extracted.chunks) {
                  yield chunk
                }
              }

              progress(WorkerStage.Xml)

              const result: InvoiceResult = extracted.error
                ? { ok: false, error: extracted.error, available: null }
                : await entryResult(
                    source,
                    entry,
                    chunks(),
                    limits,
                    control,
                    progress,
                  )

              checkCancellation(control)
              progress(WorkerStage.AwaitingCommit)

              await confirm(attempt, entry, result, counts)
              await checkpoint(control)
            }

            counts.knownXml = zip.knownXml
          }

          checkCancellation(control)
        } catch (error) {
          if (error instanceof ProcessingCancelled) {
            throw error
          }

          sourceError = detail(error, WorkerStage.Read)

          if (sourceError.retryable || attempt.unconfirmed.size) {
            throw error
          }
        } finally {
          counts.omittedEntries = zip.omissions.length
          event(request, {
            type: WorkerMessageType.SourceResult,
            selectionId: source.selectionId,
            importId: source.source.id,
            counts,
            omissions: zip.omissions,
            error: sourceError,
          })
        }
      }
    } catch (error) {
      if (!(error instanceof ProcessingCancelled)) {
        terminal = detail(error, WorkerStage.Read)
      }
    } finally {
      const remainder = {
        notStartedSelectionIds: request.sources
          .slice(attempt.sourceIndex + Number(attempt.sourceStarted))
          .map((source) => source.selectionId),
        pendingEntries: attempt.currentEntry ? [attempt.currentEntry] : [],
        lastEmittedResultId: attempt.lastEmittedResultId,
        unconfirmedResultIds: [...attempt.unconfirmed.keys()],
      }

      if (terminal) {
        event(request, {
          type: WorkerMessageType.Failed,
          error: terminal,
          ...remainder,
        })
      } else {
        event(request, {
          type:
            attempt.cancelled || disposed
              ? WorkerMessageType.Cancelled
              : WorkerMessageType.Completed,
          ...remainder,
        })
      }

      if (active === attempt) {
        active = null
      }
    }
  }

  async function handle(request: WorkerRequest) {
    if (request.type === WorkerMessageType.CommitResult) {
      const pending = active?.unconfirmed.get(request.resultId)

      if (
        active &&
        request.requestId === active.request.requestId &&
        request.attemptId === active.request.attemptId &&
        pending &&
        Object.keys(pending.entry).every(
          (key) =>
            pending.entry[key as keyof EntryIdentity] ===
            request.entry[key as keyof EntryIdentity],
        )
      ) {
        pending.resolve(request.outcome)
      }

      return
    }

    if (request.type === WorkerMessageType.Cancel) {
      if (
        active?.request.requestId === request.requestId &&
        active.request.attemptId === request.attemptId
      ) {
        active.cancelled = true
      }

      return
    }

    if (request.type === WorkerMessageType.Recalculate) {
      event(request, {
        type: WorkerMessageType.Recalculated,
        invoiceId: request.invoiceId,
        expectedRevision: request.expectedRevision,
        evaluation: classifyInvoice(request.concepts, request.classes),
        selection: request.selection,
      })

      return
    }

    if (request.type === WorkerMessageType.Dispose) {
      disposed = true

      if (active) {
        active.cancelled = true

        await active.done
      }

      await preparing?.catch(() => undefined)
      await classifier.dispose()

      event(request, { type: WorkerMessageType.Disposed })

      return
    }

    if (request.type === WorkerMessageType.Prepare) {
      if (active || preparing || disposed) {
        event(request, {
          type: WorkerMessageType.Preparation,
          modelPackageId: request.modelPackage.id,
          state: WorkerPreparationState.Failed,
          error: {
            code: WorkerErrorCode.ModelUnavailable,
            stage: WorkerStage.Model,
            message: 'El Worker está ocupado.',
            retryable: true,
          },
        })

        return
      }

      event(request, {
        type: WorkerMessageType.Preparation,
        modelPackageId: request.modelPackage.id,
        state: WorkerPreparationState.Loading,
      })
      preparing = classifier.prepare(request.modelPackage, request.assets)

      try {
        await preparing

        event(request, {
          type: WorkerMessageType.Preparation,
          modelPackageId: request.modelPackage.id,
          state: WorkerPreparationState.Ready,
        })
      } catch (error) {
        event(request, {
          type: WorkerMessageType.Preparation,
          modelPackageId: request.modelPackage.id,
          state: WorkerPreparationState.Failed,
          error: detail(error, WorkerStage.Model),
        })
      } finally {
        preparing = null
      }

      return
    }

    if (active || disposed) {
      event(request, {
        type: WorkerMessageType.Failed,
        error: {
          code: WorkerErrorCode.WorkerFailed,
          stage: WorkerStage.Read,
          message: 'El Worker está ocupado.',
          retryable: true,
        },
        notStartedSelectionIds: request.sources.map(
          (source) => source.selectionId,
        ),
        pendingEntries: [],
        lastEmittedResultId: null,
        unconfirmedResultIds: [],
      })

      return
    }

    const attempt: Attempt = {
      request,
      cancelled: false,
      sourceIndex: 0,
      sourceStarted: false,
      currentEntry: null,
      lastEmittedResultId: null,
      unconfirmed: new Map(),
      done: Promise.resolve(),
    }

    active = attempt
    attempt.done = process(attempt)

    await attempt.done
  }

  return { handle }
}
