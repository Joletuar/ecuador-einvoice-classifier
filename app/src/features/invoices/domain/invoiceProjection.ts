import { SelectionMode } from './classificationModel'
import { canonicalToCategory } from './categoryModel'
import type { ExactAmount } from './classificationModel'
import type { Invoice } from './invoiceModel'
import type {
  ImportRecord,
  InvoiceRecord,
  ModelPackageRecord,
} from './persistenceRecords'
import {
  cloneIssue,
  clonePrediction,
  cloneRuleResult,
} from './persistenceValidation'

// Un importe desconocido o con fracciones de centavo no se puede redondear ni
// convertir en cero para mostrarlo.
export function amountToCents(amount: ExactAmount): number | null {
  if (amount.decimal === null) {
    return null
  }

  const match = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/.exec(amount.decimal)

  if (!match) {
    return null
  }

  const fraction = match[3] ?? ''

  if (/[1-9]/.test(fraction.slice(2))) {
    return null
  }

  const digits =
    (match[2] + fraction.slice(0, 2).padEnd(2, '0')).replace(/^0+/, '') || '0'

  if (digits.length > 16) {
    return null
  }

  const cents = Number(match[1] + digits)

  return Number.isSafeInteger(cents) ? cents : null
}

export function projectInvoice(
  record: InvoiceRecord,
  source: ImportRecord,
  pack: ModelPackageRecord,
): Invoice {
  const principal =
    record.classification.selection.mode === SelectionMode.Manual
      ? record.classification.selection.category
      : record.classification.automatic.category
  const parts = [
    record.number.establishment,
    record.number.pointOfIssue,
    record.number.sequential,
  ]

  return {
    id: record.id,
    issuer: record.issuer.tradeName ?? record.issuer.legalName,
    issuerRuc: record.issuer.ruc ?? null,
    buyerName: record.buyer?.name ?? null,
    buyerIdentification: record.buyer?.identification ?? null,
    number: parts.every((part) => part !== null) ? parts.join('-') : null,
    date: record.date.iso,
    principal: canonicalToCategory(principal),
    originalPrincipal: canonicalToCategory(
      record.classification.initial.category,
    ),
    principalMode: record.classification.selection.mode,
    total: amountToCents(record.total),
    concepts: record.concepts.map((concept) => {
      const original =
        concept.prediction.status === 0
          ? pack.classes[concept.prediction.categoryIndex]
          : null

      return {
        id: concept.id,
        name: concept.description,
        cents: amountToCents(concept.netAmount),
        original: canonicalToCategory(original),
        category: canonicalToCategory(
          concept.selection.mode === SelectionMode.Manual
            ? concept.selection.category
            : original,
        ),
        selectionMode: concept.selection.mode,
        descriptionPresent: concept.descriptionPresent,
        netAmount: { ...concept.netAmount },
        prediction: clonePrediction(concept.prediction),
      }
    }),
    revision: record.revision,
    importId: record.importId,
    entryIndex: record.entryIndex,
    entryPath: record.entryPath,
    sourceName: source.name,
    modelPackageId: record.modelPackageId,
    currency: { raw: record.currency.raw, code: record.currency.code },
    dateRaw: record.date.raw,
    totalAmount: { ...record.total },
    issues: record.issues.map(cloneIssue),
    automatic: cloneRuleResult(record.classification.automatic),
    initial: cloneRuleResult(record.classification.initial),
  }
}
