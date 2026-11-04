import type { Invoice } from './invoiceModel'
import { cloneInvoice } from './invoicePayload'

export function normalizeInvoices(invoices: Invoice[]): Invoice[] {
  return invoices.map(cloneInvoice)
}
