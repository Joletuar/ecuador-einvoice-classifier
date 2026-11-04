import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  canonicalCategories,
  invoiceRulesVersion,
  type ConceptSelection,
  type FailedPrediction,
} from '../src/features/invoices/domain/classificationModel'
import type { LocalPersistenceSnapshot } from '../src/features/invoices/domain/persistenceRecords'
import { classifyInvoice } from '../src/features/invoices/domain/invoiceRules'
import type {
  CommitOutcome,
  SettledSourceEntry,
  SourceEntrySelection,
  WorkerEvent,
  WorkerRequest,
} from '../src/workers/workerProtocol'

const example = {
  imports: [
    {
      schemaVersion: 1,
      id: 'import-example-01',
      name: 'facturas-ejemplo.zip',
      kind: 'zip',
      originalBytes: 2048,
      createdAt: '2026-11-03T18:00:00.000Z',
    },
  ],
  invoices: [
    {
      schemaVersion: 1,
      id: 'invoice-example-01',
      importId: 'import-example-01',
      entryIndex: 0,
      entryPath: 'ejemplos/factura-001.xml',
      modelPackageId: 'a'.repeat(64),
      revision: 3,
      createdAt: '2026-11-03T18:00:00.000Z',
      updatedAt: '2026-11-03T18:02:00.000Z',
      issuer: {
        legalName: 'Comercio de Ejemplo S.A.',
        tradeName: 'Local de Ejemplo',
      },
      number: {
        establishment: '001',
        pointOfIssue: '002',
        sequential: '000000123',
      },
      date: { raw: '03/11/2026', iso: '2026-11-03' },
      currency: { raw: 'DOLAR', code: 'USD' },
      total: { raw: '17.25', decimal: '17.25' },
      concepts: [
        {
          id: 'concept-example-01',
          position: 0,
          descriptionPresent: true,
          description: 'ARROZ',
          netAmount: { raw: '10.00', decimal: '10' },
          prediction: {
            status: 0,
            categoryIndex: 0,
            probabilities: [0.8, 0.02, 0.05, 0.02, 0.01, 0.04, 0.06],
          },
          selection: { mode: 'model' },
        },
        {
          id: 'concept-example-02',
          position: 1,
          descriptionPresent: true,
          description: 'MEDICINA',
          netAmount: { raw: '5.00', decimal: '5' },
          prediction: {
            status: 0,
            categoryIndex: 3,
            probabilities: [0.03, 0.01, 0.04, 0.85, 0.01, 0.02, 0.04],
          },
          selection: { mode: 'manual', category: 'Alimentación' },
        },
      ],
      classification: {
        initial: {
          rulesVersion: invoiceRulesVersion,
          status: 'resolved',
          category: 'Alimentación',
          criterion: 'net_amount',
          reason: null,
        },
        automatic: {
          rulesVersion: invoiceRulesVersion,
          status: 'resolved',
          category: 'Alimentación',
          criterion: 'concept_count',
          reason: null,
        },
        selection: { mode: 'manual', category: 'Salud' },
      },
      issues: [],
    },
  ],
  modelPackages: [
    {
      schemaVersion: 1,
      id: 'a'.repeat(64),
      modelFile: 'concept_pipeline.onnx',
      modelSha256: 'b'.repeat(64),
      sourceModelSha256: 'c'.repeat(64),
      runtimeSignature: 'd'.repeat(64),
      ortVersion: '1.31.1',
      unicodeVersion: '16.0.0',
      featureCount: 26780,
      classes: canonicalCategories,
    },
  ],
} satisfies LocalPersistenceSnapshot

describe('canonical integration contracts', () => {
  it('preserves three-store references and initial/current classification', () => {
    const invoice = example.invoices[0]
    const modelPackage = example.modelPackages[0]
    const evaluation = classifyInvoice(invoice.concepts, modelPackage.classes)

    expect(invoice.importId).toBe(example.imports[0].id)
    expect(invoice.modelPackageId).toBe(modelPackage.id)
    expect(evaluation.result).toEqual(invoice.classification.automatic)
    expect(evaluation.issues).toEqual(invoice.issues)

    const originalConcepts = invoice.concepts.map((concept) => ({
      ...concept,
      selection: { mode: 'model' } as const,
    }))

    expect(
      classifyInvoice(originalConcepts, modelPackage.classes).result,
    ).toEqual(invoice.classification.initial)
    expect(invoice.concepts[1].selection.mode).toBe('manual')
  })

  it('types File transport, manual-null and per-XML commit correlation', () => {
    type Process = Extract<WorkerRequest, { type: 'process' }>
    type Recalculate = Extract<WorkerRequest, { type: 'recalculate' }>
    type Result = Extract<WorkerEvent, { type: 'invoice_result' }>
    type Commit = Extract<WorkerRequest, { type: 'commit_result' }>

    expectTypeOf<Process['sources'][number]['file']>().toEqualTypeOf<File>()
    expectTypeOf<Recalculate['expectedRevision']>().toEqualTypeOf<number>()
    expectTypeOf<Result['entry']>().toEqualTypeOf<Commit['entry']>()
    expectTypeOf<Commit['outcome']>().toEqualTypeOf<CommitOutcome>()
    expectTypeOf<{
      mode: 'manual'
      category: null
    }>().toMatchTypeOf<ConceptSelection>()
    expectTypeOf<{ mode: 'model' }>().toMatchTypeOf<ConceptSelection>()
    expectTypeOf<{ mode: 'manual' }>().not.toMatchTypeOf<ConceptSelection>()
    expectTypeOf<FailedPrediction['categoryIndex']>().toEqualTypeOf<-1>()
    expectTypeOf<FailedPrediction['probabilities'][number]>().toEqualTypeOf<0>()

    const request: Process = {
      type: 'process',
      requestId: 'request-1',
      attemptId: 'attempt-1',
      modelPackageId: example.modelPackages[0].id,
      sources: [
        {
          selectionId: 'selection-1',
          source: example.imports[0],
          file: new File(
            ['original bytes stay in this File'],
            'facturas-ejemplo.zip',
          ),
          entries: { mode: 'initial' },
        },
      ],
    }

    expect(request.sources[0].entries.mode).toBe('initial')
    expect(request.sources[0].file.name).toBe(request.sources[0].source.name)
  })

  it('excludes saved and permanent failures after a Worker discovery crash', () => {
    type Process = Extract<WorkerRequest, { type: 'process' }>
    type XmlResult = Extract<WorkerEvent, { type: 'invoice_result' }>

    const file = new File(['same live ZIP'], example.imports[0].name)
    const savedSibling: SettledSourceEntry = {
      entryIndex: 0,
      entryPath: 'saved.xml',
      status: 'saved',
      invoiceId: example.invoices[0].id,
    }
    const corruptSibling: XmlResult = {
      type: 'invoice_result',
      requestId: 'request-1',
      attemptId: 'attempt-1',
      resultId: 'result-corrupt',
      entry: {
        selectionId: 'selection-1',
        importId: example.imports[0].id,
        entryIndex: 1,
        entryPath: 'corrupt.xml',
      },
      result: {
        ok: false,
        error: {
          code: 'INVALID_XML',
          stage: 'xml',
          message: 'XML incompleto.',
          retryable: false,
        },
        available: null,
      },
    }
    const retry: Process = {
      type: 'process',
      requestId: 'request-2',
      attemptId: 'attempt-2-after-worker-recreation',
      modelPackageId: example.modelPackages[0].id,
      sources: [
        {
          selectionId: 'selection-1',
          source: example.imports[0],
          file,
          entries: {
            mode: 'retry',
            settledEntries: [
              savedSibling,
              {
                entryIndex: corruptSibling.entry.entryIndex,
                entryPath: corruptSibling.entry.entryPath,
                status: 'permanent_failure',
              },
            ],
          },
        },
      ],
    }
    const selection = retry.sources[0].entries

    if (selection.mode !== 'retry') {
      throw new Error('Expected a retry fixture')
    }

    expect(retry.sources[0].file).toBe(file)
    expect(selection.settledEntries).toEqual([
      savedSibling,
      { entryIndex: 1, entryPath: 'corrupt.xml', status: 'permanent_failure' },
    ])

    // Tras reiniciar el Worker pueden aparecer entradas que todavía no se
    // habían descubierto. Esas entradas y los fallos temporales deben seguir
    // disponibles para el reintento.
    const discoveredAfterRestart = [0, 1, 2, 3]
    const excluded = new Set(
      selection.settledEntries.map((entry) => entry.entryIndex),
    )

    expect(
      discoveredAfterRestart.filter((index) => !excluded.has(index)),
    ).toEqual([2, 3])
    expect(corruptSibling.result).toMatchObject({
      ok: false,
      available: null,
      error: { retryable: false },
    })

    const noKnownExclusions: SourceEntrySelection = {
      mode: 'retry',
      settledEntries: [],
    }
    const noWork: Process = { ...retry, sources: [] }

    expect(noKnownExclusions).toEqual({ mode: 'retry', settledEntries: [] })
    expect(noWork.sources).toEqual([])
    expectTypeOf<{ mode: 'retry' }>().not.toMatchTypeOf<SourceEntrySelection>()
    expectTypeOf<{ mode: 'initial' }>().toMatchTypeOf<SourceEntrySelection>()
    expectTypeOf<
      Extract<SourceEntrySelection, { mode: 'retry' }>['settledEntries'][number]
    >().toEqualTypeOf<SettledSourceEntry>()
    expectTypeOf<
      Extract<SettledSourceEntry, { status: 'permanent_failure' }>
    >().not.toHaveProperty('invoiceId')
  })
})
