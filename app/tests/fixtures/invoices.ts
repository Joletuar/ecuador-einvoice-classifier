import {
  RuleCriterion,
  RuleStatus,
  SelectionMode,
} from '../../src/features/invoices/domain/classificationModel'
import { SourceKind } from '../../src/features/invoices/domain/persistenceRecords'
import type {
  Concept,
  Invoice,
} from '../../src/features/invoices/domain/invoiceModel'
import type {
  InvoiceCommit,
  InvoiceService,
} from '../../src/features/invoices/services/invoiceService'
import type { InvoiceRecord } from '../../src/features/invoices/domain/persistenceRecords'
import type { InvoiceData } from '../../src/features/invoices/domain/storageModel'
import { cloneInvoice } from '../../src/features/invoices/domain/invoicePayload'
import { projectInvoice } from '../../src/features/invoices/domain/invoiceProjection'
import { storagePackage, accessKeyFixture } from './storageFixtures'

export const canonicalPackage = storagePackage()

const modelPackage = canonicalPackage

export function conceptFixture(overrides: Partial<Concept> = {}): Concept {
  return {
    id: 'concept-1',
    name: 'Fruta',
    cents: 1000,
    original: 'Alimentación',
    category: 'Alimentación',
    selectionMode: 'model',
    descriptionPresent: true,
    netAmount: { raw: '10.00', decimal: '10' },
    prediction: {
      status: 0,
      categoryIndex: 0,
      probabilities: [1, 0, 0, 0, 0, 0, 0],
    },
    ...overrides,
  }
}

export function invoiceCommitFixture(
  overrides: Partial<InvoiceRecord> = {},
): InvoiceCommit {
  const rule = {
    rulesVersion: 'DN-0001@2026-11-03' as const,
    status: RuleStatus.Resolved,
    category: 'Alimentación' as const,
    criterion: RuleCriterion.NetAmount,
    reason: null,
  }

  return {
    source: {
      schemaVersion: 1,
      id: 'source-invoice-1',
      name: 'factura.xml',
      kind: SourceKind.Xml,
      originalBytes: 128,
      createdAt: '2026-11-03T00:00:00Z',
    },
    modelPackage,
    invoice: {
      schemaVersion: 1,
      accessKey: accessKeyFixture(overrides.id ?? 'invoice-1'),
      id: 'invoice-1',
      importId: 'source-invoice-1',
      entryIndex: 0,
      entryPath: null,
      modelPackageId: modelPackage.id,
      revision: 1,
      createdAt: '2026-11-03T00:00:00Z',
      updatedAt: '2026-11-03T00:00:00Z',
      issuer: { legalName: 'Comercio del barrio', tradeName: null },
      number: {
        establishment: '001',
        pointOfIssue: '001',
        sequential: '000000001',
      },
      date: { raw: '20/10/2026', iso: '2026-10-20' },
      currency: { raw: 'USD', code: 'USD' },
      total: { raw: '15.00', decimal: '15' },
      concepts: [
        {
          id: 'concept-1',
          position: 0,
          descriptionPresent: true,
          description: 'Fruta',
          netAmount: { raw: '10.00', decimal: '10' },
          selection: { mode: SelectionMode.Model },
          prediction: {
            status: 0,
            categoryIndex: 0,
            probabilities: [1, 0, 0, 0, 0, 0, 0],
          },
        },
        {
          id: 'concept-2',
          position: 1,
          descriptionPresent: true,
          description: 'Vitaminas',
          netAmount: { raw: '5.00', decimal: '5' },
          selection: { mode: SelectionMode.Model },
          prediction: {
            status: 0,
            categoryIndex: 3,
            probabilities: [0, 0, 0, 1, 0, 0, 0],
          },
        },
      ],
      classification: {
        initial: rule,
        automatic: rule,
        selection: { mode: SelectionMode.Automatic },
      },
      issues: [],
      ...overrides,
    },
  }
}

export async function seedInvoice(service: InvoiceService) {
  return service.withImportSession(async (session) =>
    session.commit(invoiceCommitFixture()),
  )
}

export function invoiceFixture(overrides: Partial<Invoice> = {}): Invoice {
  const commit = invoiceCommitFixture()

  return {
    ...projectInvoice(commit.invoice, commit.source, commit.modelPackage),
    ...overrides,
  }
}

export const sampleInvoice = invoiceFixture()

export function invoiceDataFixture(
  invoices: readonly Invoice[] = [],
): InvoiceData {
  const sourceIds = [...new Set(invoices.map((invoice) => invoice.importId))]

  return {
    invoices: invoices.map(cloneInvoice),
    sourceIds,
    sourceNames: sourceIds.map(
      (id) => invoices.find((invoice) => invoice.importId === id)!.sourceName,
    ),
    usage: {
      files: sourceIds.length,
      bytes: new TextEncoder().encode(JSON.stringify(invoices)).byteLength,
    },
  }
}
