import { SaxesParser } from 'saxes'

import { WorkerErrorCode, WorkerStage } from './workerProtocol'
import {
  InvoiceIssueCode,
  InvoiceIssueStage,
} from '../features/invoices/domain/classificationModel'
import type {
  ExactAmount,
  InvoiceIssue,
} from '../features/invoices/domain/classificationModel'
import type { InvoiceRecord } from '../features/invoices/domain/persistenceRecords'
import {
  checkpoint,
  failure,
  type ProcessingLimits,
  type WorkControl,
} from './processingLimits'

export interface ExtractedConcept {
  readonly id: string
  readonly position: number
  readonly description: string | null
  readonly descriptionPresent: boolean
  readonly netAmount: ExactAmount
}

export interface ExtractedInvoice {
  readonly issuer: InvoiceRecord['issuer']
  readonly buyer: NonNullable<InvoiceRecord['buyer']>
  readonly number: InvoiceRecord['number']
  readonly date: InvoiceRecord['date']
  readonly currency: InvoiceRecord['currency']
  readonly total: ExactAmount
  readonly concepts: readonly [ExtractedConcept, ...ExtractedConcept[]]
  readonly issues: readonly InvoiceIssue[]
}

interface RawInvoice {
  root: string
  fields: Map<string, string>
  details: Map<string, string>[]
}

function xmlParser() {
  const result: RawInvoice = { root: '', fields: new Map(), details: [] }
  const path: string[] = []
  let detail: Map<string, string> | null = null

  const parser = new SaxesParser({ xmlns: true })

  parser.on('error', () => {
    throw failure(
      WorkerErrorCode.InvalidXml,
      WorkerStage.Xml,
      'El XML no está bien formado.',
    )
  })
  parser.on('doctype', () => {
    throw failure(
      WorkerErrorCode.InvalidXml,
      WorkerStage.Xml,
      'No se admiten declaraciones DTD.',
    )
  })
  parser.on('xmldecl', (declaration) => {
    if (declaration.encoding && !/^utf-?8$/i.test(declaration.encoding)) {
      throw failure(
        WorkerErrorCode.UnsupportedXml,
        WorkerStage.Xml,
        'La lectura admite XML codificado en UTF-8.',
      )
    }
  })
  parser.on('opentag', (tag) => {
    path.push(tag.local)

    if (path.length === 1) {
      result.root = tag.local
    }

    if (path.join('/') === 'factura/detalles/detalle') {
      detail = new Map()
      result.details.push(detail)
    }

    if (detail && path.length === 4 && path[2] === 'detalle') {
      detail.set(path[3], '')
    }

    const key = path.join('/')

    if (!result.fields.has(key)) {
      result.fields.set(key, '')
    }
  })

  const text = (value: string) => {
    const key = path.join('/')

    if (
      detail &&
      path.length >= 4 &&
      path.slice(0, 3).join('/') === 'factura/detalles/detalle'
    ) {
      const field = path[3]

      detail.set(field, (detail.get(field) ?? '') + value)
    }

    // Solo se acumulan los campos que usa la factura para no duplicar en
    // memoria firmas ni otros textos grandes del XML.
    if (path.length === 3 || key === 'autorizacion/comprobante') {
      result.fields.set(key, (result.fields.get(key) ?? '') + value)
    }
  }

  parser.on('text', text)
  parser.on('cdata', text)
  parser.on('closetag', () => {
    if (path.join('/') === 'factura/detalles/detalle') {
      detail = null
    }

    path.pop()
  })

  return { parser, result }
}

function issue(
  issues: InvoiceIssue[],
  code: InvoiceIssue['code'],
  field: string,
  conceptId: string | null = null,
) {
  issues.push({ code, stage: InvoiceIssueStage.Extract, field, conceptId })
}

export function exactAmount(raw: string | null): ExactAmount {
  if (raw === null) {
    return { raw: null, decimal: null }
  }

  const text = raw.trim()

  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) {
    return { raw, decimal: null }
  }

  const negative = text.startsWith('-')
  const [integer, fraction] = text.replace(/^[+-]/, '').split('.')
  const digits = (integer || '0').replace(/^0+(?=\d)/, '')

  return {
    raw,
    decimal: `${negative ? '-' : ''}${digits}${fraction ? `.${fraction}` : ''}`,
  }
}

function readAmount(
  raw: string | null,
  field: string,
  issues: InvoiceIssue[],
  conceptId: string | null = null,
) {
  const amount = exactAmount(raw)

  if (amount.decimal === null) {
    issue(
      issues,
      raw === null
        ? InvoiceIssueCode.MissingField
        : InvoiceIssueCode.InvalidAmount,
      field,
      conceptId,
    )
  } else {
    const [integer, fraction = ''] = amount.decimal.split('.')
    const cents = BigInt(integer + (fraction + '00').slice(0, 2))

    if (
      /[1-9]/.test(fraction.slice(2)) ||
      cents > BigInt(Number.MAX_SAFE_INTEGER) ||
      cents < BigInt(Number.MIN_SAFE_INTEGER)
    ) {
      issue(issues, InvoiceIssueCode.UnrepresentableCents, field, conceptId)
    }
  }

  return amount
}

function dateValue(raw: string | null): InvoiceRecord['date'] {
  if (raw === null) {
    return { raw: null, iso: null }
  }

  const text = raw.trim()
  const parts = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text)
  const iso = parts ? `${parts[3]}-${parts[2]}-${parts[1]}` : text

  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    return { raw, iso: null }
  }

  const parsed = new Date(`${iso}T00:00:00Z`)

  return {
    raw,
    iso:
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === iso
        ? iso
        : null,
  }
}

function extract(raw: RawInvoice, invoiceId: string): ExtractedInvoice {
  if (raw.root !== 'factura') {
    throw failure(
      WorkerErrorCode.UnsupportedXml,
      WorkerStage.Xml,
      'El XML no contiene una factura SRI.',
    )
  }

  if (!raw.details.length) {
    throw failure(
      WorkerErrorCode.EmptyInvoice,
      WorkerStage.Xml,
      'La factura no contiene detalles.',
    )
  }

  const issues: InvoiceIssue[] = []
  const field = (key: string) => raw.fields.get(`factura/${key}`) ?? null
  const presentation = (key: string, location: string) => {
    const value = field(key)?.trim() || null

    if (value === null) {
      issue(issues, InvoiceIssueCode.MissingField, location)
    }

    return value
  }
  const date = dateValue(field('infoFactura/fechaEmision'))

  if (!date.iso) {
    issue(
      issues,
      date.raw === null
        ? InvoiceIssueCode.MissingField
        : InvoiceIssueCode.InvalidField,
      '/date',
    )
  }

  const currencyRaw = field('infoFactura/moneda')
  const currencyName = currencyRaw
    ?.trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toUpperCase()
  const usd = [
    'USD',
    'DOLAR',
    'DOLARES',
    'DOLAR AMERICANO',
    'DOLARES AMERICANOS',
    'DOLAR DE LOS ESTADOS UNIDOS',
    'DOLARES DE LOS ESTADOS UNIDOS',
  ].includes(currencyName ?? '')
  const currency: InvoiceRecord['currency'] =
    currencyRaw === null
      ? { raw: null, code: null }
      : { raw: currencyRaw, code: usd ? 'USD' : null }

  if (!usd) {
    issue(
      issues,
      currencyRaw === null
        ? InvoiceIssueCode.MissingCurrency
        : InvoiceIssueCode.UnknownCurrency,
      '/currency',
    )
  }

  const concepts = raw.details.map((detail, position): ExtractedConcept => {
    const id = `${invoiceId}:concept:${position}`
    const descriptionPresent = detail.has('descripcion')

    if (!descriptionPresent) {
      issue(
        issues,
        InvoiceIssueCode.MissingDescription,
        `/concepts/${position}/description`,
        id,
      )
    }

    return {
      id,
      position,
      descriptionPresent,
      description: descriptionPresent ? detail.get('descripcion')! : null,
      netAmount: readAmount(
        detail.get('precioTotalSinImpuesto') ?? null,
        `/concepts/${position}/netAmount`,
        issues,
        id,
      ),
    }
  })

  return {
    issuer: {
      legalName: presentation(
        'infoTributaria/razonSocial',
        '/issuer/legalName',
      ),
      tradeName: field('infoTributaria/nombreComercial')?.trim() || null,
      ruc: field('infoTributaria/ruc')?.trim() || null,
    },
    buyer: {
      name: field('infoFactura/razonSocialComprador')?.trim() || null,
      identification:
        field('infoFactura/identificacionComprador')?.trim() || null,
    },
    number: {
      establishment: presentation(
        'infoTributaria/estab',
        '/number/establishment',
      ),
      pointOfIssue: presentation(
        'infoTributaria/ptoEmi',
        '/number/pointOfIssue',
      ),
      sequential: presentation(
        'infoTributaria/secuencial',
        '/number/sequential',
      ),
    },
    date,
    currency,
    total: readAmount(field('infoFactura/importeTotal'), '/total', issues),
    concepts: concepts as [ExtractedConcept, ...ExtractedConcept[]],
    issues,
  }
}

export async function readInvoiceXml(
  chunks: AsyncIterable<Uint8Array>,
  invoiceId: string,
  limits: ProcessingLimits,
  control: WorkControl,
): Promise<ExtractedInvoice> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let total = 0
  const outer = xmlParser()

  for await (const chunk of chunks) {
    total += chunk.byteLength

    if (total > limits.maxXmlBytes) {
      throw failure(
        WorkerErrorCode.LimitExceeded,
        WorkerStage.Xml,
        'El XML supera el límite de lectura.',
      )
    }

    // Un bloque comprimido puede producir mucho texto. Se limita el trabajo del
    // analizador por separado para que la descompresión no bloquee el Worker.
    for (
      let offset = 0;
      offset < chunk.byteLength;
      offset += limits.chunkBytes
    ) {
      await checkpoint(control)

      let text: string

      try {
        text = decoder.decode(
          chunk.subarray(offset, offset + limits.chunkBytes),
          { stream: true },
        )
      } catch {
        throw failure(
          WorkerErrorCode.InvalidXml,
          WorkerStage.Xml,
          'El XML contiene bytes UTF-8 inválidos.',
        )
      }

      outer.parser.write(text)
    }
  }

  try {
    outer.parser.write(decoder.decode())
  } catch (error) {
    if (error instanceof TypeError) {
      throw failure(
        WorkerErrorCode.InvalidXml,
        WorkerStage.Xml,
        'El XML contiene bytes UTF-8 inválidos.',
      )
    }

    throw error
  }

  outer.parser.close()

  if (outer.result.root !== 'autorizacion') {
    return extract(outer.result, invoiceId)
  }

  const inner = xmlParser()
  const text = (
    outer.result.fields.get('autorizacion/comprobante') ?? ''
  ).trim()

  for (let offset = 0; offset < text.length; offset += limits.chunkBytes) {
    await checkpoint(control)

    inner.parser.write(text.slice(offset, offset + limits.chunkBytes))
  }

  inner.parser.close()

  return extract(inner.result, invoiceId)
}
