import type { ProcessingLimits } from './processingLimits'
import type {
  AssignedRuleResult,
  ConceptRecord,
  InvoiceClassification,
  ModelClasses,
  UnassignedRuleResult,
} from '../features/invoices/domain/classificationModel'
import type {
  ImportRecord,
  InvoiceRecord,
  ModelPackageRecord,
} from '../features/invoices/domain/persistenceRecords'
import type {
  InvoiceRuleConcept,
  InvoiceRuleEvaluation,
} from '../features/invoices/domain/invoiceRules'

export const WorkerMessageType = {
  Prepare: 'prepare',
  Process: 'process',
  Cancel: 'cancel',
  Dispose: 'dispose',
  CommitResult: 'commit_result',
  Recalculate: 'recalculate',
  Disposed: 'disposed',
  Preparation: 'preparation',
  Progress: 'progress',
  InvoiceResult: 'invoice_result',
  SourceResult: 'source_result',
  Cancelled: 'cancelled',
  Completed: 'completed',
  Failed: 'failed',
  Recalculated: 'recalculated',
} as const

export type WorkerMessageType =
  (typeof WorkerMessageType)[keyof typeof WorkerMessageType]

export const WorkerPreparationState = {
  Loading: 'loading',
  Ready: 'ready',
  Failed: 'failed',
} as const

export type WorkerPreparationState =
  (typeof WorkerPreparationState)[keyof typeof WorkerPreparationState]

export const WorkerStage = {
  Read: 'read',
  Zip: 'zip',
  Xml: 'xml',
  Model: 'model',
  InvoiceRules: 'invoice_rules',
  Persistence: 'persistence',
  AwaitingCommit: 'awaiting_commit',
} as const

export type WorkerStage = (typeof WorkerStage)[keyof typeof WorkerStage]

export const WorkerErrorCode = {
  ReadFailed: 'READ_FAILED',
  InvalidZip: 'INVALID_ZIP',
  InvalidXml: 'INVALID_XML',
  UnsupportedXml: 'UNSUPPORTED_XML',
  EmptyInvoice: 'EMPTY_INVOICE',
  ModelUnavailable: 'MODEL_UNAVAILABLE',
  ModelFailed: 'MODEL_FAILED',
  NoClassifiedConcepts: 'NO_CLASSIFIED_CONCEPTS',
  UnavailableTieAmount: 'UNAVAILABLE_TIE_AMOUNT',
  WriteFailed: 'WRITE_FAILED',
  WorkerFailed: 'WORKER_FAILED',
  LimitExceeded: 'LIMIT_EXCEEDED',
} as const

export type WorkerErrorCode =
  (typeof WorkerErrorCode)[keyof typeof WorkerErrorCode]

export const CommitStatus = {
  Saved: 'saved',
  AlreadySaved: 'already_saved',
  Duplicate: 'duplicate',
  Rejected: 'rejected',
  Uncertain: 'uncertain',
} as const

export type CommitStatus = (typeof CommitStatus)[keyof typeof CommitStatus]

export const SourceEntryStatus = {
  Saved: 'saved',
  PermanentFailure: 'permanent_failure',
  Duplicate: 'duplicate',
} as const

export type SourceEntryStatus =
  (typeof SourceEntryStatus)[keyof typeof SourceEntryStatus]

export const SourceEntryMode = {
  Initial: 'initial',
  Retry: 'retry',
} as const

export type SourceEntryMode =
  (typeof SourceEntryMode)[keyof typeof SourceEntryMode]

export const AvailableResultKind = {
  Invoice: 'invoice',
  Concepts: 'concepts',
} as const

export type AvailableResultKind =
  (typeof AvailableResultKind)[keyof typeof AvailableResultKind]

export const ArchiveOmissionReason = {
  UnsupportedFile: 'unsupported_file',
  NestedZip: 'nested_zip',
} as const

export type ArchiveOmissionReason =
  (typeof ArchiveOmissionReason)[keyof typeof ArchiveOmissionReason]

interface RequestIdentity {
  readonly requestId: string
  readonly attemptId: string
}

export interface EntryIdentity {
  readonly selectionId: string
  readonly importId: string
  readonly entryIndex: number
  readonly entryPath: string | null
}

export interface ModelAsset {
  readonly path: string
  readonly url: string
  readonly sha256: string
}

export type SourceEntryIdentity = Pick<
  EntryIdentity,
  'entryIndex' | 'entryPath'
>

export type SettledSourceEntry = SourceEntryIdentity &
  (
    | {
        readonly status:
          typeof SourceEntryStatus.Saved | typeof SourceEntryStatus.Duplicate
        readonly invoiceId: string
      }
    | { readonly status: typeof SourceEntryStatus.PermanentFailure }
  )

export type SourceEntrySelection =
  | { readonly mode: typeof SourceEntryMode.Initial }
  | {
      readonly mode: typeof SourceEntryMode.Retry
      // Se excluyen las entradas ya guardadas y las que fallaron de forma
      // definitiva. Las entradas que no llegaron a descubrirse deben seguir
      // disponibles tras reiniciar el Worker. Una lista vacía no excluye
      // ninguna entrada.
      readonly settledEntries: readonly SettledSourceEntry[]
    }

export interface WorkerSource {
  readonly selectionId: string
  readonly source: ImportRecord

  readonly file: File
  // La selección permite reintentar después de reiniciar el Worker, pero se
  // pierde al recargar la página porque los archivos solo viven en memoria.
  readonly entries: SourceEntrySelection
}

export interface WorkerError {
  readonly code:
    | typeof WorkerErrorCode.ReadFailed
    | typeof WorkerErrorCode.InvalidZip
    | typeof WorkerErrorCode.InvalidXml
    | typeof WorkerErrorCode.UnsupportedXml
    | typeof WorkerErrorCode.EmptyInvoice
    | typeof WorkerErrorCode.ModelUnavailable
    | typeof WorkerErrorCode.ModelFailed
    | typeof WorkerErrorCode.NoClassifiedConcepts
    | typeof WorkerErrorCode.UnavailableTieAmount
    | typeof WorkerErrorCode.WriteFailed
    | typeof WorkerErrorCode.WorkerFailed
    | typeof WorkerErrorCode.LimitExceeded
  readonly stage:
    | typeof WorkerStage.Read
    | typeof WorkerStage.Zip
    | typeof WorkerStage.Xml
    | typeof WorkerStage.Model
    | typeof WorkerStage.InvoiceRules
    | typeof WorkerStage.Persistence
  readonly message: string
  readonly retryable: boolean
}

type ClassifiedInvoice = InvoiceRecord & {
  readonly classification: InvoiceClassification & {
    readonly automatic: AssignedRuleResult
  }
}

type UnassignedInvoice = InvoiceRecord & {
  readonly classification: InvoiceClassification & {
    readonly automatic: UnassignedRuleResult
  }
}

// Terminar la clasificación no confirma que la factura se haya guardado. El
// resultado de la escritura llega en un mensaje independiente.
export type InvoiceResult =
  | {
      readonly ok: true
      readonly invoice: ClassifiedInvoice
    }
  | {
      readonly ok: false
      readonly error: WorkerError
      readonly available:
        | {
            readonly kind: typeof AvailableResultKind.Invoice
            readonly invoice: UnassignedInvoice
          }
        | {
            readonly kind: typeof AvailableResultKind.Concepts
            readonly concepts: readonly ConceptRecord[]
          }
        | null
    }

export type CommitOutcome =
  | {
      readonly status:
        | typeof CommitStatus.Saved
        | typeof CommitStatus.AlreadySaved
        | typeof CommitStatus.Duplicate
      readonly invoiceId: string
      readonly revision: number
    }
  | {
      readonly status:
        typeof CommitStatus.Rejected | typeof CommitStatus.Uncertain
      readonly error: WorkerError
    }

export type WorkerRequest = RequestIdentity &
  (
    | {
        readonly type: typeof WorkerMessageType.Prepare
        readonly modelPackage: ModelPackageRecord

        readonly assets: readonly ModelAsset[]
      }
    | {
        readonly type: typeof WorkerMessageType.Process
        readonly modelPackageId: string
        readonly sources: readonly WorkerSource[]
        readonly limits?: ProcessingLimits
      }
    | { readonly type: typeof WorkerMessageType.Cancel }
    | { readonly type: typeof WorkerMessageType.Dispose }
    | {
        readonly type: typeof WorkerMessageType.CommitResult
        readonly entry: EntryIdentity
        readonly resultId: string
        readonly outcome: CommitOutcome
      }
    | {
        readonly type: typeof WorkerMessageType.Recalculate
        readonly invoiceId: string
        readonly expectedRevision: number
        readonly classes: ModelClasses
        readonly concepts: readonly InvoiceRuleConcept[]
        readonly selection: InvoiceClassification['selection']
      }
  )

export interface SourceCounts {
  readonly knownXml: number | null
  readonly finishedXml: number
  readonly savedXml: number
  readonly failedXml: number
  readonly omittedEntries: number
}

export interface AttemptRemainder {
  readonly notStartedSelectionIds: readonly string[]
  readonly pendingEntries: readonly EntryIdentity[]
  readonly lastEmittedResultId: string | null

  readonly unconfirmedResultIds: readonly string[]
}

export type WorkerEvent = RequestIdentity &
  (
    | { readonly type: typeof WorkerMessageType.Disposed }
    | {
        readonly type: typeof WorkerMessageType.Preparation
        readonly modelPackageId: string
        readonly state:
          | typeof WorkerPreparationState.Loading
          | typeof WorkerPreparationState.Ready
      }
    | {
        readonly type: typeof WorkerMessageType.Preparation
        readonly modelPackageId: string
        readonly state: typeof WorkerPreparationState.Failed
        readonly error: WorkerError
      }
    | {
        readonly type: typeof WorkerMessageType.Progress
        readonly selectionId: string
        readonly importId: string
        readonly stage:
          | typeof WorkerStage.Read
          | typeof WorkerStage.Zip
          | typeof WorkerStage.Xml
          | typeof WorkerStage.Model
          | typeof WorkerStage.AwaitingCommit
        readonly totalXml?: number | null
        readonly outerFiles: {
          readonly total: number
          readonly finished: number
        }
        readonly xml: SourceCounts
      }
    | {
        readonly type: typeof WorkerMessageType.InvoiceResult
        readonly entry: EntryIdentity
        readonly resultId: string
        readonly result: InvoiceResult
      }
    | {
        readonly type: typeof WorkerMessageType.SourceResult
        readonly selectionId: string
        readonly importId: string
        readonly counts: SourceCounts
        readonly omissions: readonly {
          readonly entryPath: string
          readonly reason:
            | typeof ArchiveOmissionReason.UnsupportedFile
            | typeof ArchiveOmissionReason.NestedZip
        }[]
        readonly error: WorkerError | null
      }
    | ({
        readonly type:
          | typeof WorkerMessageType.Cancelled
          | typeof WorkerMessageType.Completed
      } & AttemptRemainder)
    | ({
        readonly type: typeof WorkerMessageType.Failed
        readonly error: WorkerError
      } & AttemptRemainder)
    | {
        readonly type: typeof WorkerMessageType.Recalculated
        readonly invoiceId: string
        readonly expectedRevision: number
        readonly evaluation: InvoiceRuleEvaluation
        readonly selection: InvoiceClassification['selection']
      }
  )
