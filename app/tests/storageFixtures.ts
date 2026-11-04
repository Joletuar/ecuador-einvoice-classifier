import {
  canonicalCategories,
  type ConceptRecord,
  type ModelClasses,
} from '../src/features/invoices/domain/classificationModel'
import type {
  ImportRecord,
  InvoiceRecord,
  ModelPackageRecord,
} from '../src/features/invoices/domain/persistenceRecords'
import { classifyInvoice } from '../src/features/invoices/domain/invoiceRules'
import type { InvoiceRecalculator } from '../src/features/invoices/services/invoiceService'
import {
  CoordinationFailure,
  type TabCoordinator,
  type TabCoordinationEvent,
} from '../src/app/tabCoordination'

export const createdAt = '2026-11-03T12:00:00.000Z'

export function storagePackage(
  classes: ModelClasses = canonicalCategories,
): ModelPackageRecord {
  return {
    schemaVersion: 1,
    id: 'a'.repeat(64),
    modelFile: 'concept_pipeline.onnx',
    modelSha256: 'b'.repeat(64),
    sourceModelSha256: 'c'.repeat(64),
    runtimeSignature: 'runtime-signature',
    ortVersion: '1.25.0',
    unicodeVersion: '14.0.0',
    featureCount: 112,
    classes,
  }
}

export function storageSource(
  overrides: Partial<ImportRecord> = {},
): ImportRecord {
  return {
    schemaVersion: 1,
    id: 'source-1',
    name: 'invoice.xml',
    kind: 'xml',
    originalBytes: 120,
    createdAt,
    ...overrides,
  }
}

export function storageConcept(
  id = 'concept-0',
  position = 0,
): Extract<ConceptRecord, { descriptionPresent: true }> {
  return {
    id,
    position,
    descriptionPresent: true,
    description: 'Consulta',
    netAmount: { raw: '12.3400', decimal: '12.3400' },
    prediction: {
      status: 0,
      categoryIndex: 3,
      probabilities: [0, 0, 0, 1, 0, 0, 0],
    },
    selection: { mode: 'model' },
  }
}

export function storageInvoice(
  source = storageSource(),
  pack = storagePackage(),
  overrides: Partial<InvoiceRecord> = {},
): InvoiceRecord {
  const concepts = [storageConcept()] as const
  const result = classifyInvoice(concepts, pack.classes).result

  return {
    schemaVersion: 1,
    id: 'invoice-1',
    importId: source.id,
    entryIndex: 0,
    entryPath: source.kind === 'xml' ? null : 'invoice.xml',
    modelPackageId: pack.id,
    revision: 1,
    createdAt,
    updatedAt: createdAt,
    issuer: { legalName: 'Emisor', tradeName: null },
    number: {
      establishment: '001',
      pointOfIssue: '002',
      sequential: '000000012',
    },
    date: { raw: '03/11/2026', iso: '2026-11-03' },
    currency: { raw: 'DOLAR', code: 'USD' },
    total: { raw: '12.3400', decimal: '12.3400' },
    concepts,
    classification: {
      initial: result,
      automatic: result,
      selection: { mode: 'automatic' },
    },
    issues: [],
    ...overrides,
  }
}

export const testRecalculate: InvoiceRecalculator = async (input) => ({
  type: 'recalculated',
  requestId: 'rules-only-test',
  attemptId: 'rules-only-test',
  invoiceId: input.invoiceId,
  expectedRevision: input.expectedRevision,
  selection: input.selection,
  evaluation: classifyInvoice(input.concepts, input.classes),
})

export function testCoordinator(): TabCoordinator {
  let held = false
  const listeners = new Set<(event: TabCoordinationEvent) => void>()
  const emit = (type: TabCoordinationEvent['type']) => {
    for (const listener of listeners) {
      listener({ type, external: false })
    }
  }

  return {
    supported: true,

    isLocallyBusy: () => held,

    async withWriter(work) {
      if (held) {
        throw new CoordinationFailure('storage-busy', 'Busy in test.')
      }

      held = true
      emit('busy')

      try {
        return await work()
      } finally {
        held = false
        emit('idle')
      }
    },

    async isBusy() {
      return held
    },

    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },

    notifyChanged() {
      emit('changed')
    },

    dispose() {
      listeners.clear()
    },
  }
}
