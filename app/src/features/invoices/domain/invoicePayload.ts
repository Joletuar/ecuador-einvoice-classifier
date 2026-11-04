import { SelectionMode } from './classificationModel'
import { SourceEntryMode } from '../../../workers/workerProtocol'
import { isCategory } from './categoryModel'
import type { Concept, Invoice } from './invoiceModel'
import {
  canonicalDate,
  cloneIssue,
  clonePrediction,
  cloneRuleResult,
  fields,
  validateExactAmount,
  validateIssue,
  validatePrediction,
  validateRuleResult,
} from './persistenceValidation'

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0
const nullableText = (value: unknown) =>
  value === null || typeof value === 'string'
const cents = (value: unknown) => value === null || Number.isSafeInteger(value)
const category = (value: unknown) =>
  typeof value === 'string' && isCategory(value)

function validateConcept(value: unknown): value is Concept {
  return (
    fields(value, [
      'id',
      'name',
      'cents',
      'original',
      'category',
      'selectionMode',
      'descriptionPresent',
      'netAmount',
      'prediction',
    ]) &&
    nonempty(value.id) &&
    nullableText(value.name) &&
    cents(value.cents) &&
    category(value.original) &&
    category(value.category) &&
    (value.selectionMode === SelectionMode.Model ||
      value.selectionMode === SelectionMode.Manual) &&
    validateExactAmount(value.netAmount) &&
    validatePrediction(value.prediction) &&
    ((value.descriptionPresent === false &&
      value.name === null &&
      value.prediction.status === 1) ||
      (value.descriptionPresent === true &&
        typeof value.name === 'string' &&
        value.prediction.status !== 1))
  )
}

export function validateInvoicePayload(value: unknown): value is Invoice {
  if (
    !fields(
      value,
      [
        'id',
        'issuer',
        'number',
        'date',
        'principal',
        'originalPrincipal',
        'principalMode',
        'total',
        'concepts',
        'revision',
        'importId',
        'entryIndex',
        'entryPath',
        'sourceName',
        'modelPackageId',
        'currency',
        'dateRaw',
        'totalAmount',
        'issues',
        SelectionMode.Automatic,
        SourceEntryMode.Initial,
      ],
      ['issuerRuc', 'buyerName', 'buyerIdentification'],
    )
  ) {
    return false
  }

  if (
    !nonempty(value.id) ||
    !nullableText(value.issuer) ||
    ['issuerRuc', 'buyerName', 'buyerIdentification'].some(
      (key) => Object.hasOwn(value, key) && !nullableText(value[key]),
    ) ||
    !nullableText(value.number) ||
    !(value.date === null || canonicalDate(value.date)) ||
    !category(value.principal) ||
    !category(value.originalPrincipal) ||
    (value.principalMode !== SelectionMode.Automatic &&
      value.principalMode !== SelectionMode.Manual) ||
    !cents(value.total)
  ) {
    return false
  }

  if (
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    !nonempty(value.importId) ||
    !Number.isSafeInteger(value.entryIndex) ||
    Number(value.entryIndex) < 0 ||
    !nullableText(value.entryPath) ||
    !nonempty(value.sourceName) ||
    !nonempty(value.modelPackageId) ||
    !nullableText(value.dateRaw) ||
    !validateExactAmount(value.totalAmount)
  ) {
    return false
  }

  if (
    !fields(value.currency, ['raw', 'code']) ||
    !nullableText(value.currency.raw) ||
    (value.currency.code !== 'USD' && value.currency.code !== null) ||
    (value.currency.raw === null && value.currency.code !== null)
  ) {
    return false
  }

  if (
    !validateRuleResult(value.automatic) ||
    !validateRuleResult(value.initial) ||
    !Array.isArray(value.issues) ||
    !value.issues.every(validateIssue) ||
    !Array.isArray(value.concepts) ||
    !value.concepts.length ||
    !value.concepts.every(validateConcept)
  ) {
    return false
  }

  return (
    new Set(value.concepts.map((concept) => concept.id)).size ===
    value.concepts.length
  )
}

export function cloneInvoice(invoice: Invoice): Invoice {
  return {
    id: invoice.id,
    issuer: invoice.issuer,
    ...(invoice.issuerRuc !== undefined
      ? { issuerRuc: invoice.issuerRuc }
      : {}),
    ...(invoice.buyerName !== undefined
      ? { buyerName: invoice.buyerName }
      : {}),
    ...(invoice.buyerIdentification !== undefined
      ? { buyerIdentification: invoice.buyerIdentification }
      : {}),
    number: invoice.number,
    date: invoice.date,
    principal: invoice.principal,
    originalPrincipal: invoice.originalPrincipal,
    principalMode: invoice.principalMode,
    total: invoice.total,
    concepts: invoice.concepts.map((concept) => ({
      id: concept.id,
      name: concept.name,
      cents: concept.cents,
      original: concept.original,
      category: concept.category,
      selectionMode: concept.selectionMode,
      descriptionPresent: concept.descriptionPresent,
      netAmount: { ...concept.netAmount },
      prediction: clonePrediction(concept.prediction),
    })),
    revision: invoice.revision,
    importId: invoice.importId,
    entryIndex: invoice.entryIndex,
    entryPath: invoice.entryPath,
    sourceName: invoice.sourceName,
    modelPackageId: invoice.modelPackageId,
    currency: { raw: invoice.currency.raw, code: invoice.currency.code },
    dateRaw: invoice.dateRaw,
    totalAmount: { ...invoice.totalAmount },
    issues: invoice.issues.map(cloneIssue),
    automatic: cloneRuleResult(invoice.automatic),
    initial: cloneRuleResult(invoice.initial),
  }
}
