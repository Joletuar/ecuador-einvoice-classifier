import { describe, expect, it } from 'vitest'
import {
  canonicalCategories,
  invoiceRulesVersion,
  type CanonicalCategory,
  type CategoryIndex,
  type InvoiceClassification,
  type ModelClasses,
} from '../src/features/invoices/domain/classificationModel'
import {
  classifyInvoice,
  effectiveConceptCategory,
  effectiveInvoiceCategory,
  type InvoiceRuleConcept,
} from '../src/features/invoices/domain/invoiceRules'

function concept(
  position: number,
  category: CanonicalCategory,
  amount: string | null = '10',
): InvoiceRuleConcept {
  const index = canonicalCategories.indexOf(category)

  if (index < 0 || index > 6) {
    throw new Error('Invalid fixture category')
  }

  return {
    id: `concept-${position}`,
    position,
    netAmount:
      amount === null
        ? { raw: null, decimal: null }
        : { raw: amount, decimal: amount },
    prediction: {
      status: 0,
      categoryIndex: index as CategoryIndex,
      probabilities: [0, 0, 0, 0, 0, 0, 0],
    },
    selection: { mode: 'model' },
  }
}

function manual(
  original: InvoiceRuleConcept,
  category: CanonicalCategory | null,
): InvoiceRuleConcept {
  return { ...original, selection: { mode: 'manual', category } }
}

describe('invoice category rule DN-0001', () => {
  it('counts lines before amounts, including Otros and ignoring unknown net', () => {
    const result = classifyInvoice(
      [
        concept(0, 'Otros', null),
        concept(1, 'Otros', '1'),
        concept(2, 'Salud', '999999'),
      ],
      canonicalCategories,
    )

    expect(result).toEqual({
      result: {
        rulesVersion: invoiceRulesVersion,
        status: 'resolved',
        category: 'Otros',
        criterion: 'concept_count',
        reason: null,
      },
      issues: [],
    })
  })

  it.each([
    { first: '0.3000000000000000001', second: '0.3' },
    { first: '9007199254740993.01', second: '9007199254740993.00' },
    { first: '-1.001', second: '-1.002' },
  ])(
    'compares exact declared decimals: $first > $second',
    ({ first, second }) => {
      expect(
        classifyInvoice(
          [concept(0, 'Salud', second), concept(1, 'Alimentación', first)],
          canonicalCategories,
        ).result,
      ).toMatchObject({ category: 'Alimentación', criterion: 'net_amount' })
    },
  )

  it('sums every tied line at equal scale before comparing', () => {
    const result = classifyInvoice(
      [
        concept(0, 'Alimentación', '0.1'),
        concept(1, 'Salud', '0.15'),
        concept(2, 'Salud', '0.15000000000000000001'),
        concept(3, 'Alimentación', '0.2'),
        concept(4, 'Otros', null),
      ],
      canonicalCategories,
    )

    expect(result.result).toMatchObject({
      category: 'Salud',
      criterion: 'net_amount',
    })
    expect(result.issues).toEqual([])
  })

  it('uses original position only among categories still tied on known sums', () => {
    const result = classifyInvoice(
      [
        concept(2, 'Salud', '0.300'),
        concept(0, 'Otros', '0.1'),
        concept(1, 'Alimentación', '0.3'),
      ],
      canonicalCategories,
    )

    expect(result.result).toMatchObject({
      category: 'Alimentación',
      criterion: 'first_occurrence',
    })
  })

  it.each([null, '', 'NaN', '1e3', 'Infinity', '01.2', ' 2 ', '1\n'])(
    'leaves a needed unavailable tie amount unresolved: %s',
    (amount) => {
      const missing = concept(0, 'Salud', amount)
      const result = classifyInvoice(
        [missing, concept(1, 'Alimentación', '1')],
        canonicalCategories,
      )

      expect(result.result).toEqual({
        rulesVersion: invoiceRulesVersion,
        status: 'unassigned',
        category: null,
        criterion: null,
        reason: 'UNAVAILABLE_TIE_AMOUNT',
      })
      expect(result.issues).toEqual([
        {
          code: amount === null ? 'MISSING_FIELD' : 'INVALID_AMOUNT',
          stage: 'invoice_rules',
          field: '/concepts/0/netAmount',
          conceptId: 'concept-0',
        },
      ])
    },
  )

  it('preserves invalid raw amounts and never mutates prediction or selection', () => {
    const invalid = {
      ...concept(1, 'Salud'),
      netAmount: { raw: 'incorrecto', decimal: null },
    }
    const inputs = [manual(concept(0, 'Otros'), 'Alimentación'), invalid]
    const before = JSON.stringify(inputs)

    classifyInvoice(inputs, canonicalCategories)

    expect(JSON.stringify(inputs)).toBe(before)
    expect(invalid.netAmount.raw).toBe('incorrecto')
  })

  it('marks a result provisional when effective null concepts are excluded', () => {
    const failed: InvoiceRuleConcept = {
      ...concept(0, 'Otros'),
      prediction: {
        status: 1,
        categoryIndex: -1,
        probabilities: [0, 0, 0, 0, 0, 0, 0],
      },
    }
    const inputs = [
      failed,
      concept(1, 'Salud'),
      manual(concept(2, 'Alimentación'), null),
    ]

    expect(classifyInvoice(inputs, canonicalCategories).result).toMatchObject({
      status: 'provisional',
      category: 'Salud',
    })

    const repaired = [manual(failed, 'Salud'), concept(1, 'Salud')]

    expect(classifyInvoice(repaired, canonicalCategories).result).toMatchObject(
      {
        status: 'resolved',
        category: 'Salud',
      },
    )
    expect(failed.prediction.status).toBe(1)
  })

  it('returns no category if none of the current concepts is classified', () => {
    expect(
      classifyInvoice([manual(concept(0, 'Salud'), null)], canonicalCategories)
        .result,
    ).toMatchObject({
      status: 'unassigned',
      reason: 'NO_CLASSIFIED_CONCEPTS',
      category: null,
    })
    expect(classifyInvoice([], canonicalCategories).result.reason).toBe(
      'NO_CLASSIFIED_CONCEPTS',
    )
  })

  it('resolves model indices using the stored package classes order', () => {
    const reordered: ModelClasses = [
      'Salud',
      'Otros',
      'Vivienda',
      'Vestimenta',
      'Turismo Nacional',
      'Educación, Arte y Cultura',
      'Alimentación',
    ]

    expect(
      classifyInvoice([concept(0, 'Alimentación')], reordered).result.category,
    ).toBe('Salud')
  })

  it('retains explicit manual mode even when its category matches the model', () => {
    const original = concept(0, 'Salud')
    const selected = manual(original, 'Salud')

    expect(effectiveConceptCategory(selected, canonicalCategories)).toBe(
      'Salud',
    )
    expect(selected.selection).toEqual({ mode: 'manual', category: 'Salud' })
    expect(selected.prediction).toBe(original.prediction)

    const initial = classifyInvoice([original], canonicalCategories).result
    const current = classifyInvoice(
      [manual(original, 'Alimentación')],
      canonicalCategories,
    ).result
    const classification: InvoiceClassification = {
      initial,
      automatic: current,
      selection: { mode: 'manual', category: 'Salud' },
    }

    expect(effectiveInvoiceCategory(classification)).toBe('Salud')
    expect(
      effectiveInvoiceCategory({
        ...classification,
        selection: { mode: 'automatic' },
      }),
    ).toBe('Alimentación')
    expect(
      effectiveInvoiceCategory({
        ...classification,
        selection: { mode: 'manual', category: null },
      }),
    ).toBeNull()
    expect(classification.initial).toBe(initial)
  })
})
