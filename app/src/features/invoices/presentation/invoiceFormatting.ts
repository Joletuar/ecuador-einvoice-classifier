import { InvoiceIssueCode } from '../domain/classificationModel'
import type { ExactAmount, InvoiceIssue } from '../domain/classificationModel'
import type { Concept, Invoice } from '../domain/invoiceModel'

export const money = (cents: number | null): string => {
  if (cents === null || !Number.isSafeInteger(cents)) {
    return 'No disponible'
  }

  const absolute = BigInt(cents < 0 ? -cents : cents)
  const sign = cents < 0 ? '-' : ''
  const fraction = String(absolute % 100n).padStart(2, '0')
  const decimal = `${sign}${absolute / 100n}.${fraction}`

  return exactMoney({ raw: decimal, decimal }, { raw: 'USD', code: 'USD' })
}

export const formatDate = (value: string | null): string => {
  if (value === null) {
    return 'No disponible'
  }

  const date = new Date(`${value}T00:00:00`)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return new Intl.DateTimeFormat('es-EC', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(date)
}

export function exactMoney(
  amount: ExactAmount,
  _currency: {
    raw: string | null
    code: 'USD' | null
  },
): string {
  void _currency

  if (amount.decimal === null) {
    return 'No disponible'
  }

  const negative = amount.decimal.startsWith('-')
  const [integer = '0', fraction = ''] = amount.decimal
    .replace(/^-/, '')
    .split('.')

  const cents =
    BigInt(integer) * 100n +
    BigInt(fraction.padEnd(2, '0').slice(0, 2)) +
    (fraction[2] && fraction[2] >= '5' ? 1n : 0n)

  const grouped = String(cents / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const sign = negative && cents !== 0n ? '-' : ''
  const centLabel = String(cents % 100n).padStart(2, '0')
  const decimal = `${sign}${grouped},${centLabel}`

  return decimal
}

export function conceptDescription(concept: Concept): string {
  if (!concept.descriptionPresent) {
    return 'No disponible (descripción ausente)'
  }

  if (concept.name === '') {
    return 'Descripción vacía'
  }

  return concept.name ?? 'No disponible'
}

const issueLabels: Record<InvoiceIssue['code'], string> = {
  [InvoiceIssueCode.MissingField]: 'Dato ausente',
  [InvoiceIssueCode.InvalidField]: 'Dato inválido',
  [InvoiceIssueCode.InvalidAmount]: 'Importe ausente o inválido',
  [InvoiceIssueCode.UnrepresentableCents]:
    'El importe exacto no puede sumarse en centavos',
  [InvoiceIssueCode.MissingCurrency]:
    'Sin moneda. No se incluye en los totales en USD',
  [InvoiceIssueCode.UnknownCurrency]:
    'Moneda no reconocida. No se incluye en los totales en USD',
  [InvoiceIssueCode.MissingDescription]: 'Descripción ausente',
  [InvoiceIssueCode.InvalidUnicode]: 'Descripción con Unicode inválido',
  [InvoiceIssueCode.UnresolvedInvoiceCategory]:
    'No se pudo asignar la categoría principal',
}

export function issueLabel(issue: InvoiceIssue): string {
  return `${issueLabels[issue.code]}: ${issue.field}${issue.conceptId ? ` (${issue.conceptId})` : ''}.`
}

export function conceptExclusionReasons(invoice: Invoice): Map<string, string> {
  const amountIssues = new Map<string, string[]>()
  const currencyIssues: string[] = []

  for (const issue of invoice.issues) {
    if (
      issue.conceptId !== null &&
      (issue.code === InvoiceIssueCode.InvalidAmount ||
        issue.code === InvoiceIssueCode.UnrepresentableCents)
    ) {
      const reasons = amountIssues.get(issue.conceptId) ?? []

      reasons.push(issueLabels[issue.code])
      amountIssues.set(issue.conceptId, reasons)
    } else if (
      issue.conceptId === null &&
      (issue.code === InvoiceIssueCode.MissingCurrency ||
        issue.code === InvoiceIssueCode.UnknownCurrency)
    ) {
      currencyIssues.push(issueLabels[issue.code])
    }
  }

  const inheritedCurrency =
    invoice.currency.code === 'USD'
      ? []
      : currencyIssues.length
        ? currencyIssues
        : [
            issueLabels[
              invoice.currency.raw === null
                ? InvoiceIssueCode.MissingCurrency
                : InvoiceIssueCode.UnknownCurrency
            ],
          ]
  const excluded = new Map<string, string>()

  for (const concept of invoice.concepts) {
    if (invoice.currency.code === 'USD' && concept.cents !== null) {
      continue
    }

    const reasons = [...inheritedCurrency]

    if (concept.cents === null) {
      reasons.push(
        ...(amountIssues.get(concept.id) ?? [
          issueLabels[
            concept.netAmount.decimal === null
              ? InvoiceIssueCode.InvalidAmount
              : InvoiceIssueCode.UnrepresentableCents
          ],
        ]),
      )
    }

    excluded.set(concept.id, [...new Set(reasons)].join('. '))
  }

  return excluded
}
