import { inject, type InjectionKey } from 'vue'

import {
  FileResultStatus,
  PreparationKind,
  ProcessingOutcomeKind,
} from '../model/processingStatus'
import type { Awaitable, Result } from '../../../shared/lib/result'
import type { Invoice } from '../../invoices/domain/invoiceModel'
import type { InvoiceData } from '../../invoices/domain/storageModel'
import type { SourceCounts } from '../../../workers/workerProtocol'

export interface SelectedProcessingFile {
  id: string
  file: File
}

interface FileProcessingResultBase {
  id: string
  name: string
  message: string
  counts?: SourceCounts
  issues?: readonly string[]
  retryable?: boolean
}

export type FileProcessingResult = FileProcessingResultBase &
  (
    | {
        status: typeof FileResultStatus.Added
        invoices: Invoice[]
      }
    | {
        status: typeof FileResultStatus.Duplicate
        invoiceIds: string[]
      }
    | { status: typeof FileResultStatus.Pending; retryable: true }
    // Un resultado solo se puede reintentar si se confirmó que no se guardó. Si
    // la escritura es incierta, el lote debe comprobarla antes de ofrecer otro
    // intento.
    | { status: typeof FileResultStatus.Error }
  )

export interface ProcessingSummary {
  added: number
  duplicates: number
  failed: number
  saved: number
}

export type ProcessingOutcome =
  | {
      kind: typeof ProcessingOutcomeKind.Unavailable
      message: string
    }
  | {
      kind: typeof ProcessingOutcomeKind.Completed
      files: FileProcessingResult[]
      summary: ProcessingSummary
    }
  // Solo el adaptador conoce qué archivos nunca llegaron al Worker. La interfaz
  // no debe deducirlo a partir de los resultados que recibió.
  | {
      kind: typeof ProcessingOutcomeKind.Cancelled
      files?: FileProcessingResult[]
      notStartedIds?: string[]
    }
  | {
      kind: typeof ProcessingOutcomeKind.Failed
      files?: FileProcessingResult[]
      message: string
      notStartedIds?: string[]
    }

export type PreparationState =
  | { kind: typeof PreparationKind.Loading }
  | { kind: typeof PreparationKind.Ready }
  | {
      kind: typeof PreparationKind.Error
      message: string
    }

export interface XmlProgress {
  completed: number
  total: number | null
}

export interface ProcessingProgress {
  name: string
  completed: number
  total: number
  stage: string
  xml: SourceCounts
  xmlProgress?: XmlProgress
}

export interface ProcessingOptions {
  signal: AbortSignal
  onFileResult(result: FileProcessingResult): void
  onProgress?(progress: ProcessingProgress): void
  onData?(data: InvoiceData): void
}

export interface ProcessingService {
  readonly available: boolean
  readonly state: PreparationState
  prepare(): Promise<void>
  subscribe(listener: (state: PreparationState) => void): () => void
  forgetSelection?(): void
  dispose?(): void
  process(
    inputs: readonly SelectedProcessingFile[],
    options: ProcessingOptions,
  ): Awaitable<Result<ProcessingOutcome>>
}

export const processingServiceKey: InjectionKey<ProcessingService> =
  Symbol('processingService')

export function useProcessingService(): ProcessingService {
  const service = inject(processingServiceKey)

  if (!service) {
    throw new Error('ProcessingService must be provided by the application')
  }

  return service
}
