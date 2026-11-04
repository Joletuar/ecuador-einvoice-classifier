import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkerProcessingService } from '../src/features/upload/services/workerProcessingService'
import { createIndexedDbInvoiceService } from '../src/features/invoices/services/indexedDbInvoiceService'
import type { InvoiceService } from '../src/features/invoices/services/invoiceService'
import type {
  createClassificationWorkerClient,
  InvoiceEvent,
  TerminalEvent,
} from '../src/workers/workerClient'
import type { WorkerSource, WorkerError } from '../src/workers/workerProtocol'
import type { InvoiceData } from '../src/features/invoices/domain/storageModel'
import {
  canonicalPackage as modelPackage,
  invoiceCommitFixture,
} from './fixtures/invoices'
import { limits } from './fixtures/workerFixtures'
import {
  testCoordinator,
  testRecalculate,
  accessKeyFixture,
} from './fixtures/storageFixtures'
import type { ProcessingProgress } from '../src/features/upload/services/processingService'

type Client = Pick<
  ReturnType<typeof createClassificationWorkerClient>,
  'prepare' | 'process' | 'subscribeFailure'
>

type Hooks = Parameters<Client['process']>[2]

const services: InvoiceService[] = []

afterEach(() => services.splice(0).forEach((service) => service.dispose?.()))

const error = (code: WorkerError['code'], retryable = false): WorkerError => ({
  code,
  retryable,
  stage: 'read',
  message: code,
})

function terminal(
  type: 'completed' | 'cancelled' = 'completed',
): TerminalEvent {
  return {
    requestId: 'request',
    attemptId: 'attempt',
    type,
    notStartedSelectionIds: [],
    pendingEntries: [],
    lastEmittedResultId: null,
    unconfirmedResultIds: [],
  }
}

function invoice(
  source: WorkerSource,
  entryIndex = 0,
  accessKey = accessKeyFixture(`${source.source.name}:${entryIndex}`),
): InvoiceEvent {
  const record = invoiceCommitFixture({
    accessKey,
    id: `${source.source.id}:${entryIndex}`,
    importId: source.source.id,
    entryIndex,
    entryPath: source.source.kind === 'zip' ? `${entryIndex}.xml` : null,
  }).invoice

  if (record.classification.automatic.status === 'unassigned') {
    throw new Error('Expected assigned fixture')
  }

  return {
    requestId: 'request',
    attemptId: 'attempt',
    type: 'invoice_result',
    entry: {
      selectionId: source.selectionId,
      importId: source.source.id,
      entryIndex,
      entryPath: record.entryPath,
    },
    resultId: `result:${entryIndex}`,
    result: {
      ok: true,
      invoice: {
        ...record,
        classification: {
          ...record.classification,
          automatic: record.classification.automatic,
        },
      },
    },
  }
}

function sourceResult(
  source: WorkerSource,
  hooks: Hooks,
  savedXml: number,
  sourceError: WorkerError | null = null,
  knownXml = savedXml,
) {
  hooks.onEvent?.({
    requestId: 'request',
    attemptId: 'attempt',
    type: 'source_result',
    selectionId: source.selectionId,
    importId: source.source.id,
    counts: {
      knownXml,
      finishedXml: savedXml,
      savedXml,
      failedXml: 0,
      omittedEntries: 0,
    },
    omissions: [],
    error: sourceError,
  })
}

function setup(process: Client['process'], storageLimit = 1_000_000) {
  const invoices = createIndexedDbInvoiceService(
    { maxFiles: 100, maxTotalBytes: storageLimit },
    {
      databaseName: `adapter-${crypto.randomUUID()}`,
      coordinator: testCoordinator(),
      recalculate: testRecalculate,
    },
  )

  services.push(invoices)

  const failures = new Set<(error: Error) => void>()
  const client: Client = {
    prepare: vi.fn(async () => undefined),
    process: vi.fn(process),

    subscribeFailure(listener) {
      failures.add(listener)

      return () => {
        failures.delete(listener)
      }
    },
  }
  const service = createWorkerProcessingService({
    client,
    invoices,
    pack: { modelPackage, assets: [] },
    limits,
  })
  const data = vi.fn<(data: InvoiceData) => void>()

  return {
    client,
    invoices,
    service,
    data,

    notifyFailure: () => {
      for (const listener of failures) {
        listener(new Error('Native Worker failed'))
      }
    },

    failureSubscriptions: () => failures.size,

    hooks: () => ({
      signal: new AbortController().signal,
      onFileResult: vi.fn(),
      onData: data,
    }),
  }
}

describe('real Worker processing adapter', () => {
  it('reconciles a large cancelled remainder without repeatedly scanning its membership array', async () => {
    let membershipCalls = () => 0
    const s = setup(async (sources, _packageId, hooks) => {
      for (const source of sources.slice(0, 128)) {
        sourceResult(source, hooks, 0, error('INVALID_XML'))
      }

      const notStartedSelectionIds = sources
        .slice(128)
        .map((source) => source.selectionId)

      const membership = vi.spyOn(notStartedSelectionIds, 'includes')

      membershipCalls = () => membership.mock.calls.length

      return { ...terminal('cancelled'), notStartedSelectionIds }
    })

    await s.service.prepare()

    const inputs = Array.from({ length: 256 }, (_, index) => ({
      id: `cancel-${index}`,
      file: new File(['xml'], `${index}.xml`),
    }))

    const response = await s.service.process(inputs, s.hooks())

    expect(response).toMatchObject({
      ok: true,
      value: {
        kind: 'cancelled',
        notStartedIds: inputs.slice(128).map((input) => input.id),
      },
    })
    expect(membershipCalls()).toBeLessThanOrEqual(inputs.length * 2)
  })

  it.each(['xml files', 'one zip'])(
    'publishes incremental confirmed XML progress before the batch ends: %s',
    async (kind) => {
      const onProgress = vi.fn<(progress: ProcessingProgress) => void>()
      let reachedMidpoint!: () => void
      let continueProcessing!: () => void
      const midpoint = new Promise<void>((resolve) => {
        reachedMidpoint = resolve
      })
      const resume = new Promise<void>((resolve) => {
        continueProcessing = resolve
      })
      const s = setup(async (sources, _packageId, hooks) => {
        for (let index = 0; index < 12; index++) {
          const source = sources[kind === 'one zip' ? 0 : index]!

          await hooks.onInvoice(invoice(source, kind === 'one zip' ? index : 0))

          hooks.onEvent?.({
            requestId: 'request',
            attemptId: 'attempt',
            type: 'progress',
            selectionId: source.selectionId,
            importId: source.source.id,
            stage: 'xml',
            totalXml: kind === 'one zip' ? 12 : 1,
            outerFiles: {
              total: sources.length,
              finished: kind === 'one zip' ? 0 : index,
            },
            xml: {
              knownXml: kind === 'one zip' ? 12 : 1,
              finishedXml: kind === 'one zip' ? index + 1 : 1,
              savedXml: kind === 'one zip' ? index + 1 : 1,
              failedXml: 0,
              omittedEntries: 0,
            },
          })

          if (kind === 'xml files') {
            sourceResult(source, hooks, 1)
          }

          if (index === 2) {
            reachedMidpoint()

            await resume
          }
        }

        if (kind === 'one zip') {
          sourceResult(sources[0]!, hooks, 12)
        }

        return terminal()
      })

      await s.service.prepare()

      const inputs = Array.from(
        { length: kind === 'one zip' ? 1 : 12 },
        (_, index) => ({
          id: `live-${index}`,
          file: new File(
            ['Worker owns these bytes'],
            kind === 'one zip' ? 'many.zip' : `${index}.xml`,
          ),
        }),
      )
      const running = s.service.process(inputs, { ...s.hooks(), onProgress })

      await midpoint

      try {
        expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({
          completed: kind === 'one zip' ? 0 : 3,
          total: kind === 'one zip' ? 1 : 12,
          xmlProgress: { completed: 3, total: 12 },
        })
      } finally {
        continueProcessing()

        await running
      }
    },
  )

  it('immediately invalidates idle/correction availability and unsubscribes on disposal', async () => {
    const s = setup(async () => terminal())
    const changed = vi.fn()

    s.service.subscribe(changed)

    await s.service.prepare()

    expect(s.service.available).toBe(true)
    s.notifyFailure()
    expect(s.service.available).toBe(false)
    expect(s.service.state).toEqual({
      kind: 'error',
      message: 'Native Worker failed',
    })
    expect(s.client.process).not.toHaveBeenCalled()

    await s.service.prepare()

    expect(s.client.prepare).toHaveBeenCalledTimes(2)
    expect(s.service.available).toBe(true)
    expect(s.failureSubscriptions()).toBe(1)
    s.service.dispose?.()
    expect(s.failureSubscriptions()).toBe(0)

    const prior = changed.mock.calls.length

    s.notifyFailure()
    expect(changed).toHaveBeenCalledTimes(prior)
  })

  it('prepares truthfully, retries a failed preparation, and schedules no processing while loading', async () => {
    const s = setup(async () => terminal())

    vi.mocked(s.client.prepare).mockRejectedValueOnce(
      new Error('network unavailable'),
    )
    expect(s.service.available).toBe(false)
    expect(
      await s.service.process(
        [{ id: 'a', file: new File(['xml'], 'a.xml') }],
        s.hooks(),
      ),
    ).toMatchObject({ ok: true, value: { kind: 'unavailable' } })
    expect(s.client.process).not.toHaveBeenCalled()

    await s.service.prepare()

    expect(s.service.state).toEqual({
      kind: 'error',
      message: 'network unavailable',
    })

    await s.service.prepare()

    expect(s.service.available).toBe(true)
  })

  it('passes original Files and the package ID, commits each XML and publishes only one snapshot', async () => {
    const file = new File(['actual contents belong to Worker'], 'invoice.xml')
    const s = setup(async (sources, packageId, hooks) => {
      expect(sources[0]?.file).toBe(file)
      expect(packageId).toBe(modelPackage.id)

      const ack = await hooks.onInvoice(invoice(sources[0]!))

      expect(ack).toMatchObject({ status: 'saved', revision: 1 })
      expect(s.data).not.toHaveBeenCalled()
      sourceResult(sources[0]!, hooks, 1)

      return terminal()
    })

    await s.service.prepare()

    const response = await s.service.process(
      [{ id: 'selection', file }],
      s.hooks(),
    )

    expect(response).toMatchObject({
      ok: true,
      value: { kind: 'completed', summary: { saved: 1 } },
    })
    expect(s.data).toHaveBeenCalledTimes(1)
    expect(s.data.mock.calls[0]?.[0].invoices[0]?.number).toBe(
      '001-001-000000001',
    )
  })

  it('processes repeated filenames and deduplicates renamed XML by access key', async () => {
    const onProgress = vi.fn<(progress: ProcessingProgress) => void>()
    const s = setup(async (sources, _id, hooks) => {
      for (const source of sources) {
        const key =
          source.selectionId === 'renamed'
            ? accessKeyFixture('selection-0')
            : accessKeyFixture(source.selectionId)

        await hooks.onInvoice(invoice(source, 0, key))
        sourceResult(source, hooks, 1)
      }

      return terminal()
    })

    await s.service.prepare()

    const inputs = ['A.xml', 'A.xml', 'a.xml'].map((name, index) => ({
      id: `selection-${index}`,
      file: new File(['xml'], name),
    }))

    expect(
      await s.service.process(inputs, { ...s.hooks(), onProgress }),
    ).toMatchObject({
      ok: true,
      value: { summary: { saved: 3, duplicates: 0 } },
    })
    expect(vi.mocked(s.client.process).mock.calls[0]?.[0]).toHaveLength(3)
    expect(onProgress.mock.calls.at(-1)?.[0]).toMatchObject({
      completed: 3,
      total: 3,
      xmlProgress: { completed: 3, total: 3 },
    })
    expect(
      await s.service.process(
        [{ id: 'renamed', file: new File(['xml'], 'renamed.xml') }],
        s.hooks(),
      ),
    ).toMatchObject({
      ok: true,
      value: { summary: { saved: 0, duplicates: 1 } },
    })
    expect(s.client.process).toHaveBeenCalledTimes(2)
    expect(await s.invoices.read()).toMatchObject({
      ok: true,
      value: { usage: { files: 3 } },
    })
  })

  it('retains a corrupt ZIP warning after recovered saves and processes sibling selections', async () => {
    const s = setup(async (sources, _id, hooks) => {
      await hooks.onInvoice(invoice(sources[0]!))

      sourceResult(sources[0]!, hooks, 1, error('INVALID_ZIP'))

      await hooks.onInvoice(invoice(sources[1]!))

      sourceResult(sources[1]!, hooks, 1)

      return terminal()
    })

    await s.service.prepare()

    const response = await s.service.process(
      [
        { id: 'zip', file: new File(['zip'], 'mixed.zip') },
        { id: 'sibling', file: new File(['xml'], 'sibling.xml') },
      ],
      s.hooks(),
    )

    expect(response).toMatchObject({
      ok: true,
      value: {
        summary: { saved: 2, failed: 1 },
        files: [
          {
            status: 'added',
            retryable: false,
            issues: [expect.stringContaining('INVALID_ZIP')],
          },
          { status: 'added' },
        ],
      },
    })
  })

  it('waits for cancellation terminal after source finally, then appends only pending XML without replacing a manual correction', async () => {
    let attempt = 0
    let importId = ''
    const s = setup(async (sources, _id, hooks) => {
      const source = sources[0]!

      if (++attempt === 1) {
        importId = source.source.id

        await hooks.onInvoice(invoice(source, 0))

        sourceResult(source, hooks, 1, null, 2)

        return terminal('cancelled')
      }

      if (attempt > 2) {
        await hooks.onInvoice(invoice(source, 0))
        await hooks.onInvoice(invoice(source, 1))
        sourceResult(source, hooks, 0, null, 2)

        return terminal()
      }

      expect(source.source.id).toBe(importId)
      expect(source.entries).toMatchObject({
        mode: 'retry',
        settledEntries: [{ entryIndex: 0, status: 'saved' }],
      })

      await hooks.onInvoice(invoice(source, 1))

      sourceResult(source, hooks, 1)

      return terminal()
    })

    await s.service.prepare()

    const input = { id: 'zip', file: new File(['zip'], 'partial.zip') }

    expect(await s.service.process([input], s.hooks())).toMatchObject({
      ok: true,
      value: {
        kind: 'cancelled',
        files: [{ retryable: true, status: 'added' }],
      },
    })

    const changed = await s.invoices.correctInvoiceCategory({
      invoiceId: `${importId}:0`,
      selection: { mode: 'manual', category: null },
    })

    expect(changed.ok).toBe(true)

    await s.service.process([input], s.hooks())

    const saved = await s.invoices.read()

    expect(saved).toMatchObject({
      ok: true,
      value: {
        usage: { files: 1 },
        invoices: [
          {
            id: `${importId}:0`,
            principalMode: 'manual',
            principal: 'Sin clasificar',
            revision: 2,
          },
          { id: `${importId}:1` },
        ],
      },
    })
    s.service.forgetSelection?.()
    expect(
      await s.service.process(
        [{ id: 'after reload', file: new File(['zip'], 'partial.zip') }],
        s.hooks(),
      ),
    ).toMatchObject({
      ok: true,
      value: { summary: { duplicates: 1, saved: 0 } },
    })
  })

  it('acknowledges unreadable XML permanently and keeps it excluded on a pending retry', async () => {
    let attempt = 0
    const s = setup(async (sources, _id, hooks) => {
      const source = sources[0]!

      if (++attempt === 1) {
        const event = invoice(source, 0)

        const ack = await hooks.onInvoice({
          ...event,
          result: { ok: false, error: error('INVALID_XML'), available: null },
        })

        expect(ack).toMatchObject({
          status: 'rejected',
          error: { retryable: false },
        })
        sourceResult(source, hooks, 0, null, 2)

        return terminal('cancelled')
      }

      expect(source.entries).toMatchObject({
        mode: 'retry',
        settledEntries: [{ entryIndex: 0, status: 'permanent_failure' }],
      })

      await hooks.onInvoice(invoice(source, 1))

      sourceResult(source, hooks, 1)

      return terminal()
    })

    await s.service.prepare()

    const input = { id: 'zip', file: new File(['zip'], 'bad-sibling.zip') }

    await s.service.process([input], s.hooks())
    await s.service.process([input], s.hooks())

    expect(s.data.mock.calls.at(-1)?.[0].invoices).toHaveLength(1)
  })

  it('does not acknowledge quota failures as saved and leaves the current File retryable', async () => {
    const s = setup(async (sources, _id, hooks) => {
      const ack = await hooks.onInvoice(invoice(sources[0]!))

      expect(ack).toMatchObject({
        status: 'rejected',
        error: { code: 'WRITE_FAILED', retryable: true },
      })

      return {
        ...terminal(),
        type: 'failed',
        error: error('WRITE_FAILED', true),
      }
    }, 1)

    await s.service.prepare()

    expect(
      await s.service.process(
        [{ id: 'a', file: new File(['xml'], 'a.xml') }],
        s.hooks(),
      ),
    ).toMatchObject({
      ok: true,
      value: { kind: 'failed', files: [{ status: 'error', retryable: true }] },
    })
    expect(s.service.available).toBe(true)
    expect(s.data.mock.calls[0]?.[0].invoices).toEqual([])
  })

  it('invalidates a crashed engine and re-prepares it while retaining the current File context', async () => {
    let attempt = 0
    let originalImport = ''
    const s = setup(async (sources, _id, hooks) => {
      if (++attempt === 1) {
        originalImport = sources[0]!.source.id

        return {
          ...terminal(),
          type: 'failed',
          error: error('WORKER_FAILED', true),
        }
      }

      expect(sources[0]?.source.id).toBe(originalImport)

      await hooks.onInvoice(invoice(sources[0]!))

      sourceResult(sources[0]!, hooks, 1)

      return terminal()
    })
    const input = { id: 'a', file: new File(['xml'], 'a.xml') }

    await s.service.prepare()
    await s.service.process([input], s.hooks())

    expect(s.service.state.kind).toBe('error')

    await s.service.prepare()

    expect(s.client.prepare).toHaveBeenCalledTimes(2)
    expect(await s.service.process([input], s.hooks())).toMatchObject({
      ok: true,
      value: { summary: { saved: 1 } },
    })
  })
})
