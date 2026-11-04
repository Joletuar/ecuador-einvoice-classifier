import type { InvoiceData } from '../src/features/invoices/domain/storageModel'
import { describe, expect, it } from 'vitest'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import {
  filterInvoices,
  totals,
} from '../src/features/invoices/domain/invoiceDomain'
import { normalizeInvoices } from '../src/features/invoices/domain/invoiceNormalization'
import { useInvoiceStore } from '../src/features/invoices/stores/useInvoiceStore'
import {
  invoiceServiceKey,
  type InvoiceService,
} from '../src/features/invoices/services/invoiceService'
import type { Result } from '../src/shared/lib/result'
import { invoiceFixture, invoiceDataFixture } from './fixtures/invoices'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })

  return { promise, resolve }
}

function service(read: InvoiceService['read']): InvoiceService {
  const unavailable = () => ({
    ok: false as const,
    code: 'unavailable' as const,
    message: 'Unavailable',
  })

  return {
    read,

    withImportSession: async () => unavailable(),

    correct: unavailable,
    correctInvoiceCategory: unavailable,
    remove: unavailable,
    clearAll: unavailable,
  }
}

function invoiceStore(adapter: InvoiceService) {
  const app = createApp({ render: () => null })
  const pinia = createPinia()

  app.provide(invoiceServiceKey, adapter)
  app.use(pinia)

  return app.runWithContext(() => useInvoiceStore(pinia))
}

describe('invoice business invariants', () => {
  it('matches categories from the principal or any concept and combines filters', () => {
    const invoice = invoiceFixture()

    expect(
      filterInvoices([invoice], {
        category: 'Salud',
        year: '2026',
        query: ' BARRIO ',
      }),
    ).toEqual([invoice])
    expect(
      filterInvoices([invoice], { category: 'Salud', year: '2025', query: '' }),
    ).toEqual([])
  })

  it('sums integer concept amounts by category without changing the principal', () => {
    const invoice = invoiceFixture()

    expect(totals([invoice])).toEqual({ Alimentación: 1000, Salud: 500 })
    expect(invoice.principal).toBe('Alimentación')
  })

  it('clones canonical unknowns and exact amounts without rounding or inventing values', () => {
    const invoice = invoiceFixture({
      date: null,
      total: null,
      totalAmount: { raw: '15.004', decimal: '15.004' },
    })
    const result = normalizeInvoices([invoice])

    expect(result[0]).toMatchObject({
      id: invoice.id,
      date: null,
      total: null,
      totalAmount: { raw: '15.004', decimal: '15.004' },
    })
    expect(result[0]?.concepts[0]?.id).toBe('concept-1')
    expect(result[0]).not.toBe(invoice)
  })

  it('does not let an earlier read overwrite an authoritative mutation', async () => {
    const pending = deferred<Result<InvoiceData>>()
    const coordinator = invoiceStore(service(() => pending.promise))
    const reading = coordinator.refresh()
    const changed = invoiceFixture({ issuer: 'Actualizado' })

    coordinator.publish(invoiceDataFixture([changed]))
    pending.resolve({
      ok: true,
      value: invoiceDataFixture([invoiceFixture()]),
    })

    await reading

    expect(coordinator.snapshot).toMatchObject({
      kind: 'ready',
      invoices: [changed],
    })
  })

  it('distinguishes unavailable from empty and claims first success only once', async () => {
    const coordinator = invoiceStore(
      service(() => ({
        ok: false,
        code: 'unavailable',
        message: 'Pending integration',
      })),
    )

    await coordinator.refresh()

    expect(coordinator.snapshot.kind).toBe('error')
    expect(coordinator.claimFirstCelebration(true, 1)).toBe(false)
    coordinator.publish(invoiceDataFixture([invoiceFixture()]))
    expect(coordinator.claimFirstCelebration(true, 1)).toBe(true)
    expect(coordinator.claimFirstCelebration(true, 1)).toBe(false)
  })
})
