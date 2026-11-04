import { describe, expect, it } from 'vitest'
import {
  cloneInvoice,
  validateInvoicePayload,
} from '../src/features/invoices/domain/invoicePayload'
import { invoiceFixture } from './fixtures/invoices'

describe('invoice payload contract', () => {
  it('preserves optional identity fields in snapshots and accepts their older absence', () => {
    const current = invoiceFixture({
      issuerRuc: '0012345678001',
      buyerName: 'Ana & José',
      buyerIdentification: '00AB-09/XYZ',
    })
    const older = Object.fromEntries(
      Object.entries(current).filter(
        ([key]) =>
          !['issuerRuc', 'buyerName', 'buyerIdentification'].includes(key),
      ),
    )

    expect(validateInvoicePayload(current)).toBe(true)
    expect(cloneInvoice(current)).toEqual(current)
    expect(validateInvoicePayload(older)).toBe(true)

    if (!validateInvoicePayload(older)) {
      throw new Error('Expected the earlier invoice shape to remain valid.')
    }

    expect(cloneInvoice(older)).toEqual(older)
    expect(
      validateInvoicePayload({ ...current, buyerIdentification: 123 }),
    ).toBe(false)
    expect(validateInvoicePayload({ ...current, issuerRuc: undefined })).toBe(
      false,
    )
  })

  it('accepts the existing canonical domain model without extra financial rules', () => {
    expect(validateInvoicePayload(invoiceFixture())).toBe(true)
    expect(validateInvoicePayload(invoiceFixture({ total: 0 }))).toBe(true)
    expect(validateInvoicePayload(invoiceFixture({ total: -100 }))).toBe(true)
  })

  it.each([
    ['null', null],
    ['array', []],
    ['nonplain record', Object.assign(new Date(), invoiceFixture())],
    ['empty ID', invoiceFixture({ id: '' })],
    ['invalid date', invoiceFixture({ date: '2026-02-30' })],
    ['noncanonical date', invoiceFixture({ date: '2026-10-20T00:00:00Z' })],
    ['fractional cents', invoiceFixture({ total: 1500.25 })],
    ['unsafe cents', invoiceFixture({ total: Number.MAX_SAFE_INTEGER + 1 })],
    ['nonfinite cents', invoiceFixture({ total: Number.NaN })],
    ['invalid category', { ...invoiceFixture(), principal: 'Not a category' }],
    ['invalid mode', { ...invoiceFixture(), principalMode: 'legacy' }],
    ['extra executable field', { ...invoiceFixture(), execute() {} }],
  ])('rejects %s', (_label, value) => {
    expect(validateInvoicePayload(value)).toBe(false)
  })

  it('rejects duplicate concept identities and invalid concept amounts', () => {
    const original = invoiceFixture()
    const concept = original.concepts[0]!

    expect(
      validateInvoicePayload({
        ...original,
        concepts: [concept, { ...concept }],
      }),
    ).toBe(false)
    expect(
      validateInvoicePayload({
        ...original,
        concepts: [{ ...concept, cents: 1.5 }],
      }),
    ).toBe(false)
    expect(
      validateInvoicePayload({
        ...original,
        concepts: [{ ...concept, id: '' }],
      }),
    ).toBe(false)
  })

  it('produces independent canonical snapshots with stable field ordering', () => {
    const original = invoiceFixture()
    const reordered: unknown = {
      ...Object.fromEntries(Object.entries(original).reverse()),
      concepts: original.concepts.map((concept) =>
        Object.fromEntries(Object.entries(concept).reverse()),
      ),
    }

    if (!validateInvoicePayload(reordered)) {
      throw new Error('Expected a valid reordered payload.')
    }

    const cloned = cloneInvoice(original)

    expect(JSON.stringify(cloned)).toBe(JSON.stringify(cloneInvoice(reordered)))
    expect(cloned).not.toBe(original)
    expect(cloned.concepts[0]).not.toBe(original.concepts[0])
    expect(cloned).toEqual(original)
  })
})
