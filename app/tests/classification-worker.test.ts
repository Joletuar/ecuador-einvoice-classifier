import { describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { createWorkerController } from '../src/workers/workerController'
import type { WorkerEvent, WorkerRequest } from '../src/workers/workerProtocol'
import {
  directXml,
  limits,
  modelPackage,
  predictions,
  source,
} from './fixtures/workerFixtures'

function setup(autoConfirm = true) {
  const events: WorkerEvent[] = []
  const classifier = {
    prepare: vi.fn(async () => undefined),
    classify: vi.fn(async (concepts: Parameters<typeof predictions>[0]) =>
      predictions(concepts),
    ),
    dispose: vi.fn(async () => undefined),

    currentPackage: () => modelPackage,
  }
  const controller = createWorkerController((event) => {
    events.push(event)

    if (autoConfirm && event.type === 'invoice_result') {
      const invoice = event.result.ok
        ? event.result.invoice
        : event.result.available?.kind === 'invoice'
          ? event.result.available.invoice
          : null

      void controller.handle({
        type: 'commit_result',
        requestId: event.requestId,
        attemptId: event.attemptId,
        entry: event.entry,
        resultId: event.resultId,
        outcome: invoice
          ? { status: 'saved', invoiceId: invoice.id, revision: 1 }
          : {
              status: 'rejected',
              error: event.result.ok
                ? {
                    code: 'WORKER_FAILED',
                    stage: 'read',
                    message: 'test',
                    retryable: false,
                  }
                : event.result.error,
            },
      })
    }
  }, classifier)

  return { controller, classifier, events }
}

const processRequest = (
  file = new File([directXml()], 'one.xml'),
): Extract<WorkerRequest, { type: 'process' }> => ({
  type: 'process',
  requestId: 'request',
  attemptId: 'attempt',
  modelPackageId: modelPackage.id,
  sources: [source(file)],
  limits,
})

describe('real Worker controller contracts', () => {
  it('returns raw concept predictions, invoice rules, provenance and separate commit confirmation', async () => {
    const { controller, events } = setup()

    await controller.handle(processRequest())

    const result = events.find((event) => event.type === 'invoice_result')

    expect(
      result?.type === 'invoice_result' &&
        result.result.ok &&
        result.result.invoice.concepts[0].description,
    ).toBe('  ARROZ & café  ')

    const summary = events.find((event) => event.type === 'source_result')

    expect(summary?.type === 'source_result' && summary.counts.savedXml).toBe(1)
    expect(events.at(-1)?.type).toBe('completed')
    expect(
      events
        .filter((event) => event.type === 'progress')
        .map((event) => event.stage),
    ).toEqual(['read', 'xml', 'model', 'awaiting_commit'])
  })

  it('keeps corrupt XML independent of valid ZIP siblings and honors exclusions after recreation', async () => {
    const zip = new File(
      [
        zipSync({
          'good.xml': strToU8(directXml()),
          'bad.xml': strToU8('<broken>'),
          'new.xml': strToU8(directXml()),
        }),
      ],
      'all.zip',
    )
    const request = { ...processRequest(), sources: [source(zip, 'zip')] }
    const first = setup()

    await first.controller.handle(request)

    expect(
      first.events
        .filter((event) => event.type === 'invoice_result')
        .map((event) => event.result.ok),
    ).toEqual([true, false, true])

    const second = setup()

    await second.controller.handle({
      ...request,
      sources: [
        {
          ...request.sources[0],
          entries: {
            mode: 'retry',
            settledEntries: [
              {
                entryIndex: 0,
                entryPath: 'good.xml',
                status: 'saved',
                invoiceId: 'old',
              },
              {
                entryIndex: 1,
                entryPath: 'bad.xml',
                status: 'permanent_failure',
              },
            ],
          },
        },
      ],
    })

    expect(
      second.events
        .filter((event) => event.type === 'invoice_result')
        .map((event) => event.entry.entryIndex),
    ).toEqual([2])
  })

  it('waits for a matching acknowledgment even after cancellation', async () => {
    const { controller, events } = setup(false)
    const done = controller.handle(processRequest())

    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'invoice_result')).toBe(
        true,
      ),
    )

    const invoice = events.find((event) => event.type === 'invoice_result')!

    if (invoice.type !== 'invoice_result' || !invoice.result.ok) {
      throw new Error('fixture')
    }

    await controller.handle({
      type: 'cancel',
      requestId: 'request',
      attemptId: 'attempt',
    })
    await controller.handle({
      type: 'commit_result',
      requestId: 'request',
      attemptId: 'stale',
      entry: invoice.entry,
      resultId: invoice.resultId,
      outcome: {
        status: 'saved',
        invoiceId: invoice.result.invoice.id,
        revision: 1,
      },
    })

    expect(events.some((event) => event.type === 'cancelled')).toBe(false)

    await controller.handle({
      type: 'commit_result',
      requestId: 'request',
      attemptId: 'attempt',
      entry: invoice.entry,
      resultId: invoice.resultId,
      outcome: {
        status: 'saved',
        invoiceId: invoice.result.invoice.id,
        revision: 1,
      },
    })
    await done

    expect(events.at(-1)?.type).toBe('cancelled')
    expect(
      events.find((event) => event.type === 'source_result')?.counts.savedXml,
    ).toBe(1)
  })

  it('reports uncertain writes for reconciliation, without declaring them confirmed failures', async () => {
    const { controller, events } = setup(false)
    const done = controller.handle(processRequest())

    await vi.waitFor(() =>
      expect(events.some((event) => event.type === 'invoice_result')).toBe(
        true,
      ),
    )

    const result = events.find((event) => event.type === 'invoice_result')!

    if (result.type !== 'invoice_result') {
      throw new Error('fixture')
    }

    await controller.handle({
      type: 'commit_result',
      requestId: 'request',
      attemptId: 'attempt',
      entry: result.entry,
      resultId: result.resultId,
      outcome: {
        status: 'uncertain',
        error: {
          code: 'WRITE_FAILED',
          stage: 'persistence',
          message: 'uncertain',
          retryable: true,
        },
      },
    })
    await done

    expect(events.at(-1)).toMatchObject({
      type: 'failed',
      unconfirmedResultIds: [result.resultId],
    })
  })

  it('recalculates on a fresh Worker without preparing or invoking ONNX', async () => {
    const { controller, classifier, events } = setup()

    await controller.handle({
      type: 'recalculate',
      requestId: 'r',
      attemptId: 'r',
      invoiceId: 'invoice',
      expectedRevision: 3,
      classes: modelPackage.classes,
      concepts: [
        {
          id: 'concept',
          position: 0,
          netAmount: { raw: null, decimal: null },
          prediction: {
            status: 1,
            categoryIndex: -1,
            probabilities: [0, 0, 0, 0, 0, 0, 0],
          },
          selection: { mode: 'manual', category: 'Salud' },
        },
      ],
      selection: { mode: 'manual', category: null },
    })

    expect(events[0]).toMatchObject({
      type: 'recalculated',
      expectedRevision: 3,
      evaluation: { result: { category: 'Salud' } },
      selection: { mode: 'manual', category: null },
    })
    expect(classifier.prepare).not.toHaveBeenCalled()
    expect(classifier.classify).not.toHaveBeenCalled()
  })

  it('completes an empty request without preparing model or limits', async () => {
    const { controller, classifier, events } = setup()

    await controller.handle({
      ...processRequest(),
      sources: [],
      limits: undefined,
    })

    expect(events.at(-1)).toMatchObject({
      type: 'completed',
      pendingEntries: [],
      notStartedSelectionIds: [],
    })
    expect(classifier.classify).not.toHaveBeenCalled()
  })
})
