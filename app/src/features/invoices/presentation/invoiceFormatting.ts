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

const missingFieldMessages: Record<string, string> = {
  '/date': 'La factura no tiene fecha de emisión.',
  '/issuer/legalName': 'Falta el nombre del emisor.',
  '/number/establishment': 'El número de factura está incompleto.',
  '/number/pointOfIssue': 'El número de factura está incompleto.',
  '/number/sequential': 'El número de factura está incompleto.',
  '/total': 'La factura no tiene importe total.',
}

const missingCurrencyMessage =
  'Esta factura no se suma al resumen porque no tiene moneda.'
const unknownCurrencyMessage =
  'Esta factura no se suma al resumen porque no se reconoce su moneda.'

function amountLimitReason(amount: ExactAmount): string {
  const fraction = amount.decimal?.split('.')[1] ?? ''

  return /[1-9]/.test(fraction.slice(2))
    ? 'tiene más de dos decimales'
    : 'es demasiado grande'
}

export function issueLabel(issue: InvoiceIssue, invoice: Invoice): string {
  const conceptIndex = invoice.concepts.findIndex(
    (concept) => concept.id === issue.conceptId,
  )
  const concept = invoice.concepts[conceptIndex]
  const conceptName =
    conceptIndex >= 0 ? `concepto ${conceptIndex + 1}` : 'concepto'
  const amountName = `El importe del ${conceptName}`

  switch (issue.code) {
    case InvoiceIssueCode.MissingField:
      if (issue.conceptId !== null) {
        return `El ${conceptName} no tiene importe.`
      }

      return missingFieldMessages[issue.field] ?? 'La factura está incompleta.'
    case InvoiceIssueCode.InvalidField:
      return 'La fecha de emisión no es válida.'
    case InvoiceIssueCode.InvalidAmount:
      return issue.field === '/total'
        ? 'El total de la factura no es un número válido.'
        : `${amountName} no es un número válido.`
    case InvoiceIssueCode.UnrepresentableCents:
      if (issue.field === '/total') {
        return `El total de la factura ${amountLimitReason(invoice.totalAmount)}.`
      }

      if (!concept) {
        return `${amountName} no se puede sumar al resumen.`
      }

      return `${amountName} no se suma porque ${amountLimitReason(concept.netAmount)}.`
    case InvoiceIssueCode.MissingCurrency:
      return missingCurrencyMessage
    case InvoiceIssueCode.UnknownCurrency:
      return unknownCurrencyMessage
    case InvoiceIssueCode.MissingDescription:
      return `El ${conceptName} no tiene descripción.`
    case InvoiceIssueCode.InvalidUnicode:
      return `No se pudo leer la descripción del ${conceptName}.`
    case InvoiceIssueCode.UnresolvedInvoiceCategory:
      return 'No se pudo elegir la categoría principal.'
  }
}

export function conceptExclusionReasons(invoice: Invoice): Map<string, string> {
  const excluded = new Map<string, string>()

  for (const concept of invoice.concepts) {
    const reasons: string[] = []

    if (invoice.currency.code !== 'USD') {
      reasons.push(
        invoice.currency.raw === null
          ? missingCurrencyMessage
          : unknownCurrencyMessage,
      )
    }

    if (concept.cents === null) {
      if (concept.netAmount.decimal === null) {
        reasons.push(
          concept.netAmount.raw === null
            ? 'Este concepto no se suma porque no tiene importe.'
            : 'Este concepto no se suma porque su importe no es un número válido.',
        )
      } else {
        reasons.push(
          `Este importe no se suma porque ${amountLimitReason(concept.netAmount)}.`,
        )
      }
    }

    if (reasons.length) {
      excluded.set(concept.id, reasons.join(' '))
    }
  }

  return excluded
}
