import { describe, expect, it, vi } from 'vitest'
import {
  InvoiceIssueCode,
  InvoiceIssueStage,
} from '../src/features/invoices/domain/classificationModel'
import { conceptFixture, invoiceFixture } from './fixtures/invoices'
import {
  excludedTotalConcepts,
  filterInvoices,
  totals,
} from '../src/features/invoices/domain/invoiceDomain'
import { presentInvoiceList } from '../src/features/invoices/presentation/invoiceListPresenter'
import {
  conceptDescription,
  conceptExclusionReasons,
  exactMoney,
  formatDate,
  money,
} from '../src/features/invoices/presentation/invoiceFormatting'

const filters = { query: '', year: '', category: '' }

describe('canonical invoice presentation', () => {
  it('marks the excluded concept by identity despite duplicate names and unrelated incidents', () => {
    const invoice = invoiceFixture({
      concepts: [
        conceptFixture({ id: 'healthy', name: 'Producto repetido' }),
        conceptFixture({
          id: 'bad',
          name: 'Producto repetido',
          cents: null,
          netAmount: { raw: 'inválido', decimal: null },
        }),
        conceptFixture({
          id: 'description',
          name: null,
          descriptionPresent: false,
        }),
      ],
      issues: [
        {
          code: InvoiceIssueCode.InvalidAmount,
          stage: InvoiceIssueStage.Extract,
          field: '/concepts/bad/netAmount',
          conceptId: 'bad',
        },
        {
          code: InvoiceIssueCode.MissingDescription,
          stage: InvoiceIssueStage.Extract,
          field: '/concepts/description/description',
          conceptId: 'description',
        },
        {
          code: InvoiceIssueCode.InvalidAmount,
          stage: InvoiceIssueStage.Extract,
          field: '/total',
          conceptId: null,
        },
        {
          code: InvoiceIssueCode.MissingField,
          stage: InvoiceIssueStage.Extract,
          field: '/issuer',
          conceptId: null,
        },
      ],
    })
    const reasons = conceptExclusionReasons(invoice)

    expect([...reasons.keys()]).toEqual(['bad'])
    expect(reasons.get('bad')).toBe('Importe ausente o inválido')
    expect(reasons.size).toBe(excludedTotalConcepts([invoice]))
  })

  it.each([
    ['EUR', InvoiceIssueCode.UnknownCurrency, 'Moneda no reconocida'],
    [null, InvoiceIssueCode.MissingCurrency, 'Sin moneda'],
  ])(
    'inherits the actual %s currency exclusion for every affected concept',
    (raw, code, expected) => {
      const invoice = invoiceFixture({
        currency: { raw, code: null },
        concepts: [
          conceptFixture({ id: 'first' }),
          conceptFixture({ id: 'second' }),
        ],
        issues: [
          {
            code,
            stage: InvoiceIssueStage.Extract,
            field: '/currency',
            conceptId: null,
          },
        ],
      })
      const reasons = conceptExclusionReasons(invoice)

      expect([...reasons.keys()]).toEqual(['first', 'second'])
      expect(
        [...reasons.values()].every((reason) => reason.startsWith(expected!)),
      ).toBe(true)
      expect(reasons.size).toBe(excludedTotalConcepts([invoice]))
    },
  )

  it('applies 2→3→2→empty search consistently while preserving year and category filters', () => {
    const invoices = [
      invoiceFixture({
        id: 'pan',
        issuer: 'Panadería Alba',
        date: '2024-01-01',
      }),
      invoiceFixture({ id: 'cafe', issuer: 'Café Centro', date: '2024-02-01' }),
      invoiceFixture({
        id: 'older',
        issuer: 'Panadería Antigua',
        date: '2023-01-01',
      }),
    ]
    const filters = { year: '2024', category: 'Alimentación', query: '' }

    for (const [query, ids] of [
      ['pa', ['pan', 'cafe']],
      [' PAN ', ['pan']],
      ['pa', ['pan', 'cafe']],
      ['', ['pan', 'cafe']],
    ] as const) {
      const view = presentInvoiceList(invoices, { ...filters, query }, 1)

      expect(view.rows.map((row) => row.invoice.id)).toEqual(ids)
    }
  })

  it('does not read searchable invoice text for a short query', () => {
    const invoice = invoiceFixture()
    const issuer = vi.fn(() => 'Panadería')

    Object.defineProperty(invoice, 'issuer', { get: issuer })
    presentInvoiceList([invoice], { ...filters, query: 'pa' }, 1)
    expect(issuer).not.toHaveBeenCalled()
    presentInvoiceList([invoice], { ...filters, query: 'pan' }, 1)
    expect(issuer).toHaveBeenCalled()
  })

  it('retains unknown fields without fabricating a date, a year option or a zero amount', () => {
    const invoice = invoiceFixture({
      issuer: null,
      number: null,
      date: null,
      total: null,
      totalAmount: { raw: null, decimal: null },
    })
    const view = presentInvoiceList([invoice], filters, 1)

    expect(view.yearOptions).toEqual([])
    expect(view.rows[0]).toMatchObject({
      dateLabel: 'No disponible',
      totalLabel: 'No disponible',
    })
    expect(filterInvoices([invoice], { ...filters, year: '2026' })).toEqual([])
    expect(formatDate(null)).toBe('No disponible')
  })
  it('rounds displayed amounts to two decimals while preserving exact source values', () => {
    const amount = { raw: '00012.3456', decimal: '12.3456' }

    expect(exactMoney(amount, { raw: 'USD', code: 'USD' })).toBe('12,35')
    expect(amount).toEqual({ raw: '00012.3456', decimal: '12.3456' })
    expect(money(Number.MAX_SAFE_INTEGER)).toBe('90.071.992.547.409,91')
    expect(money(0)).toBe('0,00')
    expect(money(null)).toBe('No disponible')
  })
  it.each([
    ['1.005', '1,01'],
    ['9.999999', '10,00'],
    [
      '123456789012345678901234567890.995',
      '123.456.789.012.345.678.901.234.567.891,00',
    ],
    ['-1.005', '-1,01'],
    ['-0.000001', '0,00'],
    ['0.005', '0,01'],
    ['0.004999', '0,00'],
    ['12', '12,00'],
  ])(
    'displays %s without floating-point precision loss',
    (decimal, expected) => {
      expect(
        exactMoney({ raw: decimal, decimal }, { raw: 'USD', code: 'USD' }),
      ).toBe(expected)
    },
  )
  it('shows numeric values only without changing declared or unknown currency', () => {
    const amount = { raw: '12.345678', decimal: '12.345678' }

    expect(exactMoney(amount, { raw: 'EUR', code: null })).toBe('12,35')
    expect(exactMoney(amount, { raw: null, code: null })).toBe('12,35')
    expect(
      exactMoney(
        { raw: 'invalid', decimal: null },
        { raw: 'USD', code: 'USD' },
      ),
    ).toBe('No disponible')
  })
  it('excludes unknown currency and amount from USD sums while preserving classified concepts and exact display', () => {
    const unknownCurrency = invoiceFixture({
      currency: { raw: 'EUR', code: null },
    })
    const missing = invoiceFixture({
      concepts: [
        conceptFixture({
          cents: null,
          netAmount: { raw: 'invalid', decimal: null },
        }),
        conceptFixture({ id: 'zero', cents: 0 }),
      ],
    })

    expect(totals([unknownCurrency, missing])).toEqual({ Alimentación: 0 })
    expect(excludedTotalConcepts([unknownCurrency, missing])).toBe(3)
    expect(
      exactMoney(unknownCurrency.totalAmount, unknownCurrency.currency),
    ).toBe('15,00')
    expect(unknownCurrency.concepts[0]?.category).toBe('Alimentación')
    expect(
      presentInvoiceList([unknownCurrency, missing], filters, 1)
        .excludedConcepts,
    ).toBe(3)
  })
  it('marks an unrepresentable USD aggregate unavailable without returning zero or rounding', () => {
    const invoice = invoiceFixture({
      concepts: [
        conceptFixture({ cents: Number.MAX_SAFE_INTEGER }),
        conceptFixture({ id: 'another', cents: 1 }),
      ],
    })

    expect(totals([invoice])).toEqual({ Alimentación: null })

    const view = presentInvoiceList([invoice], filters, 1)

    expect(
      view.cards.find((card) => card.category === 'Alimentación'),
    ).toMatchObject({ cents: null, amountLabel: 'No disponible' })
    expect(view.unavailableTotals).toBe(true)
  })
  it('distinguishes absent and empty descriptions without changing their values', () => {
    const absent = conceptFixture({ name: null, descriptionPresent: false })
    const empty = conceptFixture({ name: '' })

    expect(conceptDescription(absent)).toBe(
      'No disponible (descripción ausente)',
    )
    expect(conceptDescription(empty)).toBe('Descripción vacía')
    expect(absent.name).toBeNull()
    expect(empty.name).toBe('')
  })
})
