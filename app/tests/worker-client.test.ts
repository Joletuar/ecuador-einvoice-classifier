import { describe, expect, it, vi } from 'vitest'
import { createClassificationWorkerClient } from '../src/workers/workerClient'
import type { InvoiceEvent } from '../src/workers/workerClient'
import type { WorkerEvent, WorkerRequest } from '../src/workers/workerProtocol'
import { limits, modelPackage } from './fixtures/workerFixtures'

class FakeWorker extends EventTarget {
  requests: WorkerRequest[] = []
  terminated = false

  postMessage(request: WorkerRequest) {
    this.requests.push(request)
  }

  terminate() {
    this.terminated = true
  }

  emit(event: WorkerEvent) {
    this.dispatchEvent(new MessageEvent('message', { data: event }))
  }
}

function setup() {
  const worker = new FakeWorker()

  return {
    worker,
    client: createClassificationWorkerClient(() => worker as unknown as Worker),
  }
}

function invoice(request: WorkerRequest): InvoiceEvent {
  return {
    type: 'invoice_result',
    requestId: request.requestId,
    attemptId: request.attemptId,
    entry: {
      selectionId: 'selected',
      importId: 'source',
      entryIndex: 0,
      entryPath: null,
    },
    resultId: 'result',
    result: {
      ok: false,
      error: {
        code: 'INVALID_XML',
        stage: 'xml',
        message: 'bad xml',
        retryable: false,
      },
      available: null,
    },
  }
}

function terminal(
  request: WorkerRequest,
  type: 'completed' | 'cancelled' = 'completed',
): WorkerEvent {
  return {
    type,
    requestId: request.requestId,
    attemptId: request.attemptId,
    notStartedSelectionIds: [],
    pendingEntries: [],
    lastEmittedResultId: null,
    unconfirmedResultIds: [],
  }
}

describe('Worker client lifecycle', () => {
  it.each(['error', 'messageerror'])(
    'notifies native %s while prepared and idle without waiting for a new request',
    async (eventType) => {
      const { worker, client } = setup()
      const preparing = client.prepare({ modelPackage, assets: [] })
      const request = worker.requests[0]!

      worker.emit({
        type: 'preparation',
        state: 'ready',
        modelPackageId: modelPackage.id,
        requestId: request.requestId,
        attemptId: request.attemptId,
      })

      await preparing

      const failure = vi.fn()
      const ignored = vi.fn()

      client.subscribeFailure(failure)

      const unsubscribe = client.subscribeFailure(ignored)

      unsubscribe()
      worker.dispatchEvent(new Event(eventType))
      expect(worker.terminated).toBe(true)
      expect(failure).toHaveBeenCalledOnce()
      expect(failure.mock.calls[0]?.[0]).toBeInstanceOf(Error)
      expect(ignored).not.toHaveBeenCalled()
      expect(worker.requests).toHaveLength(1)
    },
  )

  it('isolates throwing lifecycle observers and notifies during a pending correction', async () => {
    const { worker, client } = setup()

    client.subscribeFailure(() => {
      throw new Error('broken observer')
    })

    const failure = vi.fn()

    client.subscribeFailure(failure)

    const operation = client.recalculate({
      invoiceId: 'invoice',
      expectedRevision: 1,
      classes: modelPackage.classes,
      concepts: [],
      selection: { mode: 'automatic' },
    })
    const rejected = expect(operation).rejects.toThrow('Worker se interrumpió')

    worker.dispatchEvent(new Event('error'))
    expect(failure).toHaveBeenCalledOnce()
    expect(worker.terminated).toBe(true)

    await rejected
    await client.dispose()
  })

  it('disposes safely when Worker creation fails before a process starts', async () => {
    const client = createClassificationWorkerClient(() => {
      throw new Error('worker unavailable')
    })
    const process = client.process([], modelPackage.id, {
      limits,

      onInvoice: async () => {
        throw new Error('unexpected')
      },
    })
    const rejection = expect(process).rejects.toThrow('worker unavailable')

    await client.dispose()
    await rejection
  })
  it('ignores stale attempts and duplicate results, and waits for pending commits', async () => {
    const { worker, client } = setup()
    let commit!: () => void
    const onInvoice = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        commit = resolve
      })

      return {
        status: 'rejected' as const,
        error: {
          code: 'INVALID_XML' as const,
          stage: 'xml' as const,
          message: 'bad xml',
          retryable: false,
        },
      }
    })
    const result = client.process([], modelPackage.id, { limits, onInvoice })
    const request = worker.requests[0]

    worker.emit({ ...terminal(request), attemptId: 'stale' })
    worker.emit(invoice(request))
    worker.emit(invoice(request))

    await vi.waitFor(() => expect(onInvoice).toHaveBeenCalledTimes(1))

    worker.emit(terminal(request))

    let finished = false

    void result.then(() => {
      finished = true
    })

    await Promise.resolve()

    expect(finished).toBe(false)
    commit()
    expect((await result).type).toBe('completed')
  })

  it('does not let a throwing progress observer strand the commit or process promise', async () => {
    const { worker, client } = setup()
    const onInvoice = vi.fn(async () => ({
      status: 'rejected' as const,
      error: {
        code: 'INVALID_XML' as const,
        stage: 'xml' as const,
        message: 'bad',
        retryable: false,
      },
    }))
    const result = client.process([], modelPackage.id, {
      limits,

      onEvent: () => {
        throw new Error('observer')
      },

      onInvoice,
    })
    const request = worker.requests[0]

    worker.emit(invoice(request))

    await vi.waitFor(() => expect(onInvoice).toHaveBeenCalledTimes(1))

    worker.emit(terminal(request, 'cancelled'))
    expect(await result).toMatchObject({
      type: 'failed',
      error: { message: 'No se pudo actualizar el estado del procesamiento.' },
    })
    expect(worker.requests.some((request) => request.type === 'cancel')).toBe(
      true,
    )
  })

  it('settles in-flight writes before reporting a Worker crash and clears confirmed IDs', async () => {
    const { worker, client } = setup()
    const failure = vi.fn()

    client.subscribeFailure(failure)

    let commit!: () => void
    const result = client.process([], modelPackage.id, {
      limits,

      onInvoice: async () => {
        await new Promise<void>((resolve) => {
          commit = resolve
        })

        return { status: 'saved', invoiceId: 'invoice', revision: 1 }
      },
    })

    worker.emit(invoice(worker.requests[0]))

    await vi.waitFor(() => expect(commit).toBeTypeOf('function'))

    worker.dispatchEvent(new Event('error'))
    expect(failure).toHaveBeenCalledOnce()

    let finished = false

    void result.then(() => {
      finished = true
    })

    await Promise.resolve()

    expect(finished).toBe(false)
    commit()
    expect(await result).toMatchObject({
      type: 'failed',
      unconfirmedResultIds: [],
    })
    expect(worker.terminated).toBe(true)
  })

  it('rejects pending preparation and recalculation on disposal', async () => {
    for (const kind of ['prepare', 'recalculate']) {
      const { worker, client } = setup()
      const operation =
        kind === 'prepare'
          ? client.prepare({ modelPackage, assets: [] })
          : client.recalculate({
              invoiceId: 'invoice',
              expectedRevision: 1,
              classes: modelPackage.classes,
              concepts: [],
              selection: { mode: 'automatic' },
            })
      const rejection = expect(operation).rejects.toThrow('cerró')

      await client.dispose()
      await rejection

      expect(worker.terminated).toBe(true)
    }
  })
})
