import type { InvoiceData } from '../src/features/invoices/domain/storageModel'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { describe, expect, it, vi } from 'vitest'
import { useInvoiceStore } from '../src/features/invoices/stores/useInvoiceStore'
import { useInvoiceListStore } from '../src/features/invoices/stores/useInvoiceListStore'
import {
  invoiceServiceKey,
  type InvoiceService,
} from '../src/features/invoices/services/invoiceService'
import { createUnavailableInvoiceService } from '../src/features/invoices/services/unavailableInvoiceService'
import type { Result } from '../src/shared/lib/result'
import { presentInvoiceList } from '../src/features/invoices/presentation/invoiceListPresenter'
import { categories } from '../src/features/invoices/domain/categoryModel'
import {
  conceptFixture,
  invoiceFixture,
  invoiceDataFixture,
} from './fixtures/invoices'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })

  return { promise, resolve }
}

function createStores(
  service: InvoiceService = createUnavailableInvoiceService(),
) {
  const app = createApp({ render: () => null })
  const pinia = createPinia()

  app.provide(invoiceServiceKey, service)
  app.use(pinia)

  return {
    invoices: app.runWithContext(() => useInvoiceStore(pinia)),
    list: useInvoiceListStore(pinia),
  }
}

describe('invoice application state', () => {
  it('shares one initialization request while it is pending', async () => {
    const request = deferred<Result<InvoiceData>>()
    const read = vi.fn(() => request.promise)
    const { invoices } = createStores({
      ...createUnavailableInvoiceService(),
      read,
    })
    const first = invoices.initialize()
    const second = invoices.initialize()

    expect(read).toHaveBeenCalledTimes(1)
    expect(invoices.snapshot.kind).toBe('loading')
    request.resolve({
      ok: true,
      value: invoiceDataFixture([invoiceFixture()]),
    })
    expect(await first).toEqual(await second)
    expect(invoices.snapshot.kind).toBe('ready')

    await invoices.initialize()

    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps separate application instances independent', () => {
    const first = createStores()
    const second = createStores()

    first.invoices.publish(invoiceDataFixture([invoiceFixture()]))
    first.list.setFilter('query', 'Comercio')
    first.list.toggleExpanded('invoice-1')
    expect(second.invoices.snapshot.kind).toBe('unknown')
    expect(second.list.filters.query).toBe('')
    expect(second.list.expanded).toEqual([])
  })

  it('applies search at three trimmed characters without resetting for unapplied typing', () => {
    const { list } = createStores()

    list.setFilter('year', '2024')
    list.setFilter('category', 'Salud')
    list.setPage(4)

    const initial = list.appliedFilters

    list.setFilter('query', 'p')
    list.setFilter('query', ' pa ')
    expect(list.filters.query).toBe(' pa ')
    expect(list.appliedFilters).toBe(initial)
    expect(list.page).toBe(4)
    list.setFilter('query', ' PAN ')
    expect(list.appliedFilters).toEqual({
      query: 'pan',
      year: '2024',
      category: 'Salud',
    })
    expect(list.page).toBe(1)
    list.setPage(2)

    const applied = list.appliedFilters

    list.setFilter('query', 'pan')
    expect(list.appliedFilters).toBe(applied)
    expect(list.page).toBe(2)
    list.setFilter('query', 'pa')
    expect(list.appliedFilters.query).toBe('')
    expect(list.page).toBe(1)
    list.setPage(3)

    const short = list.appliedFilters

    list.setFilter('query', '')
    expect(list.appliedFilters).toBe(short)
    expect(list.page).toBe(3)
    expect(list.filters).toEqual({ query: '', year: '2024', category: 'Salud' })
  })

  it('opens only one invoice concept row and closes it when toggled again', () => {
    const { list } = createStores()

    list.toggleExpanded('first')
    expect(list.expanded).toEqual(['first'])
    list.toggleExpanded('second')
    expect(list.expanded).toEqual(['second'])
    list.toggleExpanded('second')
    expect(list.expanded).toEqual([])
  })

  it('ignores an older refresh when a more recent read completes first', async () => {
    const earlier = deferred<Result<InvoiceData>>()
    const later = deferred<Result<InvoiceData>>()
    const read = vi
      .fn<InvoiceService['read']>()
      .mockImplementationOnce(() => earlier.promise)
      .mockImplementationOnce(() => later.promise)
    const { invoices } = createStores({
      ...createUnavailableInvoiceService(),
      read,
    })
    const one = invoices.refresh()
    const two = invoices.refresh()

    later.resolve({
      ok: true,
      value: invoiceDataFixture([invoiceFixture({ issuer: 'Más reciente' })]),
    })

    await two

    earlier.resolve({ ok: true, value: invoiceDataFixture([]) })

    await one

    expect(invoices.snapshot).toMatchObject({
      kind: 'ready',
      invoices: [{ issuer: 'Más reciente' }],
    })
  })

  it('preserves a declared unavailable response instead of publishing empty data', async () => {
    const { invoices } = createStores()

    await invoices.initialize()

    expect(invoices.snapshot).toMatchObject({
      kind: 'error',
      code: 'unavailable',
    })
    expect('invoices' in invoices.snapshot).toBe(false)
  })

  it('converts a thrown read into an explicit failure', async () => {
    const { invoices } = createStores({
      ...createUnavailableInvoiceService(),

      read: () => {
        throw new Error('Network')
      },
    })

    await invoices.initialize()

    expect(invoices.snapshot).toEqual({
      kind: 'error',
      message: 'No se pudieron cargar las facturas.',
    })
  })

  it('does not publish a response after its store is disposed', async () => {
    const request = deferred<Result<InvoiceData>>()
    const { invoices } = createStores({
      ...createUnavailableInvoiceService(),

      read: () => request.promise,
    })
    const reading = invoices.initialize()

    invoices.$dispose()
    request.resolve({
      ok: true,
      value: invoiceDataFixture([invoiceFixture()]),
    })

    await reading

    expect(invoices.snapshot.kind).toBe('loading')
  })

  it('keeps list preferences across consumers while resetting the page on filter changes', () => {
    const { list } = createStores()

    list.setPage(4)
    list.setFilter('category', 'Salud')
    list.toggleExpanded('invoice-1')
    expect(list.page).toBe(1)
    expect(list.filters.category).toBe('Salud')
    expect(list.expanded).toEqual(['invoice-1'])
    list.setPageSize(30)
    expect(list.pageSize).toBe(30)
    list.setPageSize(7)
    expect(list.pageSize).toBe(30)
  })

  it('shows a zero category total when a principal matches without matching concepts', () => {
    const invoice = invoiceFixture({ principal: 'Vivienda' })
    const view = presentInvoiceList(
      [invoice],
      { category: 'Vivienda', year: '', query: '' },
      1,
    )

    expect(view.rows).toHaveLength(1)
    expect(
      view.cards.find((card) => card.category === 'Vivienda'),
    ).toMatchObject({
      cents: 0,
      invoiceCount: 1,
      conceptCount: 0,
      hasAssociations: true,
    })
    expect(view.cards.map((card) => card.category)).toEqual(categories)
  })

  it('includes uncategorized amounts in the complete category summary', () => {
    const invoice = invoiceFixture({
      concepts: [
        conceptFixture({
          id: 'unknown',
          name: 'Pendiente',
          cents: 250,
          category: 'Sin clasificar',
          original: 'Sin clasificar',
        }),
      ],
    })
    const view = presentInvoiceList(
      [invoice],
      { category: '', year: '', query: '' },
      10,
    )

    expect(view.cards.map((card) => card.category)).toEqual(categories)
    expect(
      view.cards.find((card) => card.category === 'Sin clasificar'),
    ).toMatchObject({
      cents: 250,
      invoiceCount: 1,
      conceptCount: 1,
      hasAssociations: true,
    })
    expect(view.pagination.page).toBe(1)
  })

  it('counts associated invoices once while retaining zero-value concepts', () => {
    const invoice = invoiceFixture({
      concepts: [
        conceptFixture({
          id: 'one',
          name: 'Uno',
          cents: 0,
          category: 'Salud',
          original: 'Salud',
        }),
        conceptFixture({
          id: 'two',
          name: 'Dos',
          cents: 0,
          category: 'Salud',
          original: 'Salud',
        }),
      ],
    })
    const view = presentInvoiceList(
      [invoice],
      { category: '', year: '', query: '' },
      1,
    )

    expect(view.cards.find((card) => card.category === 'Salud')).toMatchObject({
      cents: 0,
      invoiceCount: 1,
      conceptCount: 2,
      hasAssociations: true,
    })
    expect(
      view.cards.find((card) => card.category === 'Turismo'),
    ).toMatchObject({
      cents: 0,
      invoiceCount: 0,
      conceptCount: 0,
      hasAssociations: false,
    })
  })

  it('summarizes every concept category within the filtered invoices', () => {
    const view = presentInvoiceList(
      [invoiceFixture(), invoiceFixture({ id: 'older', date: '2025-10-20' })],
      { category: 'Alimentación', year: '2026', query: 'Comercio' },
      1,
    )

    expect(view.cards.map((card) => card.category)).toEqual(categories)
    expect(
      view.cards.find((card) => card.category === 'Alimentación'),
    ).toMatchObject({
      cents: 1000,
      invoiceCount: 1,
      conceptCount: 1,
    })
    expect(view.cards.find((card) => card.category === 'Salud')).toMatchObject({
      cents: 500,
      invoiceCount: 1,
      conceptCount: 1,
      hasAssociations: true,
    })
  })

  it.each([
    { category: 'Turismo', year: '', query: '' },
    { category: '', year: '2024', query: '' },
    { category: '', year: '', query: 'Sin coincidencias' },
  ])(
    'retains all empty summaries when filters match no invoices: %j',
    (filters) => {
      const view = presentInvoiceList([invoiceFixture()], filters, 1)

      expect(view.rows).toEqual([])
      expect(view.cards.map((card) => card.category)).toEqual(categories)
      expect(
        view.cards.every((card) => !card.hasAssociations && card.cents === 0),
      ).toBe(true)
    },
  )

  it('retains all categories for an empty collection', () => {
    const view = presentInvoiceList(
      [],
      { category: '', year: '', query: '' },
      1,
    )

    expect(view.cards.map((card) => card.category)).toEqual(categories)
    expect(view.cards.every((card) => !card.hasAssociations)).toBe(true)
  })
})
