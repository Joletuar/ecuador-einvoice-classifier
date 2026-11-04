import type { Invoice } from './invoiceModel'
import type {
  ImportRecord,
  InvoiceRecord,
  LocalPersistenceSnapshot,
  ModelPackageRecord,
} from './persistenceRecords'
import {
  cloneImportRecord,
  cloneInvoiceRecord,
  cloneModelPackageRecord,
} from './persistenceValidation'
import { projectInvoice } from './invoiceProjection'

export interface StorageUsage {
  files: number
  bytes: number
}

export interface InvoiceData {
  invoices: Invoice[]
  sourceIds: string[]
  sourceNames: string[]
  usage: StorageUsage
}

const encoder = new TextEncoder()

export function serializedRecordBytes(
  record: ImportRecord | InvoiceRecord | ModelPackageRecord,
): number {
  const canonical =
    'importId' in record
      ? cloneInvoiceRecord(record)
      : 'classes' in record
        ? cloneModelPackageRecord(record)
        : cloneImportRecord(record)

  return encoder.encode(JSON.stringify(canonical)).byteLength
}

export function persistenceUsage(
  snapshot: LocalPersistenceSnapshot,
): StorageUsage {
  let bytes = 0

  for (const record of [
    ...snapshot.imports,
    ...snapshot.invoices,
    ...snapshot.modelPackages,
  ]) {
    bytes += serializedRecordBytes(record)

    if (!Number.isSafeInteger(bytes)) {
      throw new Error('El tamaño guardado no es válido.')
    }
  }

  return { files: snapshot.imports.length, bytes }
}

export function createInvoiceData(
  snapshot: LocalPersistenceSnapshot,
  usage = persistenceUsage(snapshot),
): InvoiceData {
  const imports = new Map(snapshot.imports.map((source) => [source.id, source]))
  const packs = new Map(snapshot.modelPackages.map((pack) => [pack.id, pack]))

  const orderedSources = [...snapshot.imports].sort((a, b) =>
    a.id.localeCompare(b.id),
  )
  const invoices = [...snapshot.invoices].sort(
    (a, b) =>
      a.importId.localeCompare(b.importId) ||
      a.entryIndex - b.entryIndex ||
      a.id.localeCompare(b.id),
  )

  return {
    invoices: invoices.map((invoice) => {
      const source = imports.get(invoice.importId)
      const pack = packs.get(invoice.modelPackageId)

      if (!source || !pack) {
        throw new Error('La factura no tiene origen o paquete.')
      }

      return projectInvoice(invoice, source, pack)
    }),
    sourceIds: orderedSources.map((source) => source.id),
    sourceNames: orderedSources.map((source) => source.name),
    usage: { ...usage },
  }
}

export function permitsStorageChange(
  before: StorageUsage,
  after: StorageUsage,
  limits: {
    maxFiles: number
    maxTotalBytes: number
  },
): boolean {
  if (after.files <= limits.maxFiles && after.bytes <= limits.maxTotalBytes) {
    return true
  }

  return after.files <= before.files && after.bytes <= before.bytes
}
