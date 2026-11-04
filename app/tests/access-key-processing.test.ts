import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { openDB } from 'idb'
import { createWorkerController } from '../src/workers/workerController'
import { createWorkerProcessingService } from '../src/features/upload/services/workerProcessingService'
import { createIndexedDbInvoiceService } from '../src/features/invoices/services/indexedDbInvoiceService'
import type { InvoiceService } from '../src/features/invoices/services/invoiceService'
import type {
  createClassificationWorkerClient,
  TerminalEvent,
} from '../src/workers/workerClient'
import type { ProcessingProgress } from '../src/features/upload/services/processingService'
import type { WorkerRequest } from '../src/workers/workerProtocol'
import { canonicalPackage } from './fixtures/invoices'
import { directXml, limits, predictions } from './fixtures/workerFixtures'
import {
  accessKeyFixture,
  storageSource,
  testCoordinator,
  testRecalculate,
} from './fixtures/storageFixtures'

type Client = Pick<
  ReturnType<typeof createClassificationWorkerClient>,
  'prepare' | 'process' | 'subscribeFailure'
>

const services: InvoiceService[] = []

afterEach(() => services.splice(0).forEach((service) => service.dispose?.()))

function xml(identity: string) {
  return directXml().replace(
    /<claveAcceso>.*?<\/claveAcceso>/,
    `<claveAcceso>${accessKeyFixture(identity)}</claveAcceso>`,
  )
}

function setup() {
  const databaseName = `access-key-${crypto.randomUUID()}`
  const invoices = createIndexedDbInvoiceService(
    { maxFiles: 100, maxTotalBytes: 1_000_000 },
    {
      databaseName,
      coordinator: testCoordinator(),
      recalculate: testRecalculate,
    },
  )

  services.push(invoices)

  const client: Client = {
    prepare: vi.fn(async () => undefined),
    subscribeFailure: () => () => undefined,
    async process(sources, modelPackageId, hooks) {
      let terminal!: TerminalEvent
      const controller = createWorkerController(
        (event) => {
          if (event.type === 'invoice_result') {
            void hooks.onInvoice(event).then((outcome) => {
              void controller.handle({
                ...request,
                type: 'commit_result',
                entry: event.entry,
                resultId: event.resultId,
                outcome,
              })
            })
          } else if (
            event.type === 'completed' ||
            event.type === 'cancelled' ||
            event.type === 'failed'
          ) {
            terminal = event
          } else {
            hooks.onEvent?.(event)
          }
        },
        {
          prepare: vi.fn(async () => undefined),
          classify: vi.fn(async (concepts: Parameters<typeof predictions>[0]) =>
            predictions(concepts),
          ),
          dispose: vi.fn(async () => undefined),
          currentPackage: () => canonicalPackage,
        },
      )

      const request: Extract<WorkerRequest, { type: 'process' }> = {
        type: 'process',
        requestId: crypto.randomUUID(),
        attemptId: crypto.randomUUID(),
        sources,
        modelPackageId,
        limits,
      }

      const cancel = () => {
        void controller.handle({ ...request, type: 'cancel' })
      }

      hooks.signal?.addEventListener('abort', cancel, { once: true })

      try {
        await controller.handle(request)

        return terminal
      } finally {
        hooks.signal?.removeEventListener('abort', cancel)
      }
    },
  }
  const service = createWorkerProcessingService({
    client,
    invoices,
    pack: { modelPackage: canonicalPackage, assets: [] },
    limits,
  })
  const process = (
    files: File[],
    signal = new AbortController().signal,
    onProgress?: (progress: ProcessingProgress) => void,
  ) =>
    service.process(
      files.map((file, index) => ({ id: `${index}`, file })),
      { signal, onProgress, onFileResult: () => undefined },
    )

  return { service, invoices, process, databaseName }
}

const zip = (entries: Record<string, string>, name = 'facturas.zip') =>
  new File(
    [
      zipSync(
        Object.fromEntries(
          Object.entries(entries).map(([path, content]) => [
            path,
            strToU8(content),
          ]),
        ),
      ),
    ],
    name,
  )

async function read(service: InvoiceService) {
  const result = await service.read()

  if (!result.ok) {
    throw new Error(result.message)
  }

  return result.value
}

describe('access key through real XML/ZIP processing and canonical storage', () => {
  it('allows identical names with different keys and rejects renamed invoices across reload without changing corrections', async () => {
    const s = setup()

    await s.service.prepare()
    expect(
      await s.process([
        new File([xml('A')], 'same.xml'),
        new File([xml('B')], 'same.xml'),
      ]),
    ).toMatchObject({
      ok: true,
      value: { summary: { saved: 2, duplicates: 0 } },
    })

    const before = await read(s.invoices)
    const first = before.invoices.find((invoice) =>
      invoice.id.includes(before.sourceIds[0]!),
    )!

    expect(
      (
        await s.invoices.correctInvoiceCategory({
          invoiceId: first.id,
          selection: { mode: 'manual', category: 'Vivienda' },
        })
      ).ok,
    ).toBe(true)

    const corrected = await read(s.invoices)

    s.service.forgetSelection?.()
    expect(
      await s.process([new File([xml('A')], 'renamed.xml')]),
    ).toMatchObject({
      ok: true,
      value: { summary: { saved: 0, duplicates: 1 } },
    })
    expect(await read(s.invoices)).toEqual(corrected)

    const secondConnection = createIndexedDbInvoiceService(
      { maxFiles: 100, maxTotalBytes: 1_000_000 },
      { databaseName: s.databaseName, coordinator: testCoordinator() },
    )

    services.push(secondConnection)
    expect(await read(secondConnection)).toEqual(corrected)
  })

  it('saves only new invoices in mixed ZIPs and counts every repeated XML without reporting duplicates as failures', async () => {
    const s = setup()

    await s.service.prepare()
    await s.process([new File([xml('A')], 'first.xml')])

    const result = await s.process([
      zip({
        'one.xml': xml('A'),
        'two.xml': xml('A'),
        'sub/one.xml': xml('B'),
        'bad.xml': directXml().replace(/<claveAcceso>.*?<\/claveAcceso>/, ''),
      }),
    ])

    expect(result).toMatchObject({
      ok: true,
      value: {
        summary: { saved: 1 },
        files: [
          {
            status: 'added',
            counts: { finishedXml: 4, savedXml: 1, failedXml: 1 },
            message: expect.stringContaining('2 facturas ya guardadas'),
          },
        ],
      },
    })
    expect((await read(s.invoices)).invoices).toHaveLength(2)

    const allDuplicates = await s.process([
      zip({ '1.xml': xml('A'), '2.xml': xml('A'), '3.xml': xml('B') }),
    ])

    expect(allDuplicates).toMatchObject({
      ok: true,
      value: {
        summary: { saved: 0, duplicates: 1, failed: 0 },
        files: [
          {
            status: 'duplicate',
            counts: { finishedXml: 3, savedXml: 0, failedXml: 0 },
            message: expect.stringContaining('3 facturas ya guardadas'),
          },
        ],
      },
    })
  })

  it('retains a settled duplicate during cancellation and retries only the remaining ZIP entries', async () => {
    const s = setup()

    await s.service.prepare()
    await s.process([new File([xml('A')], 'first.xml')])

    const file = zip({
      'duplicate.xml': xml('A'),
      'new.xml': xml('B'),
      'another.xml': xml('C'),
    })
    const cancellation = new AbortController()
    const interrupted = await s.process(
      [file],
      cancellation.signal,
      (progress) => {
        if (progress.xmlProgress?.completed === 1) {
          cancellation.abort()
        }
      },
    )

    expect(interrupted).toMatchObject({
      ok: true,
      value: {
        kind: 'cancelled',
        files: [
          {
            retryable: true,
            status: 'duplicate',
            counts: { finishedXml: 1, savedXml: 0, failedXml: 0 },
          },
        ],
      },
    })
    expect((await read(s.invoices)).invoices).toHaveLength(1)
    expect(await s.process([file])).toMatchObject({
      ok: true,
      value: {
        kind: 'completed',
        summary: { saved: 2, duplicates: 0 },
        files: [
          {
            retryable: false,
            counts: { finishedXml: 2, savedXml: 2, failedXml: 0 },
          },
        ],
      },
    })
    expect((await read(s.invoices)).invoices).toHaveLength(3)
  })

  it('enforces the unique access key in IndexedDB even for writes bypassing the service', async () => {
    const s = setup()

    await s.service.prepare()
    await s.process([new File([xml('A')], 'invoice.xml')])

    const db = await openDB(s.databaseName)

    try {
      const existing = (await db.getAll('invoices'))[0]!
      const transaction = db.transaction(['imports', 'invoices'], 'readwrite')

      void transaction.done.catch(() => undefined)
      await transaction
        .objectStore('imports')
        .add(storageSource({ id: 'orphan-source' }))
      await expect(
        transaction
          .objectStore('invoices')
          .add({ ...existing, id: 'duplicate-id', importId: 'orphan-source' }),
      ).rejects.toMatchObject({ name: 'ConstraintError' })
      await expect(transaction.done).rejects.toBeDefined()
      expect(await db.get('imports', 'orphan-source')).toBeUndefined()
      expect(await db.getAll('invoices')).toHaveLength(1)
    } finally {
      db.close()
    }
  })
})
