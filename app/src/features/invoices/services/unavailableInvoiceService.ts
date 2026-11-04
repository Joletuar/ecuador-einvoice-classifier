import { StorageErrorCode } from '../domain/storageErrors'
import type { InvoiceService } from './invoiceService'

export function createUnavailableInvoiceService(): InvoiceService {
  const unavailable = () => ({
    ok: false as const,
    code: StorageErrorCode.NotAvailable,
    message: 'El almacenamiento de facturas no está disponible.',
  })

  return {
    read: unavailable,

    withImportSession: async () => unavailable(),

    correct: unavailable,
    correctInvoiceCategory: unavailable,
    remove: unavailable,
    clearAll: unavailable,
  }
}
