import { inject, type InjectionKey } from 'vue'

import {
  CommitStatus,
  WorkerMessageType,
} from '../../../workers/workerProtocol'
import type { Awaitable, Result } from '../../../shared/lib/result'
import type { InvoiceData, StorageUsage } from '../domain/storageModel'
import type {
  ConceptSelection,
  InvoiceSelection,
} from '../domain/classificationModel'
import type {
  ImportRecord,
  InvoiceRecord,
  ModelPackageRecord,
} from '../domain/persistenceRecords'
import type { Invoice } from '../domain/invoiceModel'
import type {
  WorkerEvent,
  WorkerRequest,
} from '../../../workers/workerProtocol'

export type RecalculationInput = Omit<
  Extract<WorkerRequest, { type: typeof WorkerMessageType.Recalculate }>,
  'type' | 'requestId' | 'attemptId'
>

export type InvoiceRecalculator = (
  input: RecalculationInput,
) => Promise<
  Extract<WorkerEvent, { type: typeof WorkerMessageType.Recalculated }>
>

export interface InvoiceCommit {
  source: ImportRecord
  modelPackage: ModelPackageRecord
  invoice: InvoiceRecord
}

export interface CommittedInvoice {
  status:
    | typeof CommitStatus.Saved
    | typeof CommitStatus.AlreadySaved
    | typeof CommitStatus.Duplicate
  invoice: Invoice
  revision: number
  usage: StorageUsage
}

// commit usa el bloqueo de la sesión para que la importación no intente
// competir consigo misma por el turno de escritura.
export interface InvoiceImportSession {
  readonly sourceIds: readonly string[]
  readonly sourceNames: readonly string[]
  commit(input: InvoiceCommit): Promise<Result<CommittedInvoice>>
  findSaved(importId: string, entryIndex: number): Invoice | null
  // La vista completa se construye al terminar el lote para no copiar todas las
  // facturas después de cada XML.
  snapshot(): InvoiceData
}

export interface InvoiceService {
  read(): Awaitable<Result<InvoiceData>>
  withImportSession<T>(
    work: (session: InvoiceImportSession) => Promise<T>,
  ): Promise<Result<T>>
  correct(input: {
    invoiceId: string
    conceptId: string
    selection: ConceptSelection
    expectedRevision?: number
  }): Awaitable<Result<InvoiceData>>
  correctInvoiceCategory(input: {
    invoiceId: string
    selection: InvoiceSelection
    expectedRevision?: number
  }): Awaitable<Result<InvoiceData>>
  remove(id: string): Awaitable<Result<InvoiceData>>
  clearAll(): Awaitable<Result<InvoiceData>>
  dispose?(): void
}

export const invoiceServiceKey: InjectionKey<InvoiceService> =
  Symbol('invoiceService')

export function useInvoiceService(): InvoiceService {
  const service = inject(invoiceServiceKey)

  if (!service) {
    throw new Error('InvoiceService must be provided by the application.')
  }

  return service
}
