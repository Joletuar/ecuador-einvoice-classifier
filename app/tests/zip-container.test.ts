import { describe, expect, it, vi } from 'vitest'
import { Zip, ZipDeflate, strToU8, zipSync } from 'fflate'
import {
  readZipInvoices,
  type ZipReadState,
} from '../src/workers/zipInvoiceReader'
import { createWorkerController } from '../src/workers/workerController'
import { countZipXml } from '../src/workers/zipContainer'
import { ProcessingCancelled } from '../src/workers/processingLimits'
import type { WorkerEvent } from '../src/workers/workerProtocol'
import {
  directXml,
  immediateControl,
  limits,
  modelPackage,
  predictions,
  source,
} from './fixtures/workerFixtures'

function signature(bytes: Uint8Array, value: number, after = 0) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  for (let offset = after; offset + 4 <= bytes.length; offset++) {
    if (view.getUint32(offset, true) === value) {
      return offset
    }
  }

  throw new Error('Missing fixture signature')
}

function join(...chunks: Uint8Array[]) {
  const bytes = new Uint8Array(
    chunks.reduce((size, chunk) => size + chunk.length, 0),
  )
  let offset = 0

  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }

  return bytes
}

const archive = () =>
  zipSync({
    'first.xml': strToU8(directXml()),
    'second.xml': strToU8(directXml()),
  })
const state = (): ZipReadState => ({ knownXml: 0, omissions: [] })

async function recover(bytes: Uint8Array) {
  const summary = state()
  const returned: string[] = []
  let error: unknown = null

  try {
    for await (const entry of readZipInvoices(
      new File([bytes], 'archive.zip'),
      { mode: 'initial' },
      limits,
      immediateControl,
      summary,
    )) {
      returned.push(entry.entryPath)
    }
  } catch (cause) {
    error = cause
  }

  return { returned, summary, error }
}

function comment(bytes: Uint8Array, value: Uint8Array) {
  const result = join(bytes, value)

  new DataView(result.buffer).setUint16(bytes.length - 2, value.length, true)

  return result
}

function streamedArchive() {
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, data) => {
    if (error) {
      throw error
    }

    chunks.push(data)
  })
  const file = new ZipDeflate('stream.xml')

  zip.add(file)

  const bytes = strToU8(directXml())

  file.push(bytes.subarray(0, 100), false)
  file.push(bytes.subarray(100), true)
  zip.end()

  return join(...chunks)
}

function zip64Footer(bytes: Uint8Array) {
  const end = bytes.length - 22
  const old = new DataView(bytes.buffer, bytes.byteOffset + end, 22)
  const extension = new Uint8Array(76)
  const view = new DataView(extension.buffer)

  view.setUint32(0, 0x06064b50, true)
  view.setBigUint64(4, 44n, true)
  view.setUint16(12, 45, true)
  view.setUint16(14, 45, true)
  view.setBigUint64(24, BigInt(old.getUint16(10, true)), true)
  view.setBigUint64(32, BigInt(old.getUint16(10, true)), true)
  view.setBigUint64(40, BigInt(old.getUint32(12, true)), true)
  view.setBigUint64(48, BigInt(old.getUint32(16, true)), true)
  view.setUint32(56, 0x07064b50, true)
  view.setBigUint64(64, BigInt(end), true)
  view.setUint32(72, 1, true)

  const footer = bytes.slice(end)
  const footerView = new DataView(footer.buffer)

  footerView.setUint16(8, 0xffff, true)
  footerView.setUint16(10, 0xffff, true)
  footerView.setUint32(12, 0xffffffff, true)
  footerView.setUint32(16, 0xffffffff, true)

  return join(bytes.subarray(0, end), extension, footer)
}

describe('ZIP container completion after recoverable entries', () => {
  it('keeps progress metadata reads bounded for many local and central records', async () => {
    const file = new Blob([
      zipSync(
        Object.fromEntries(
          Array.from({ length: 256 }, (_, index) => [
            `${index}.xml`,
            strToU8(directXml()),
          ]),
        ),
      ),
    ])
    const slice = vi.spyOn(file, 'slice')

    expect(
      await countZipXml(
        file,
        { ...limits, maxZipEntries: 512 },
        immediateControl,
      ),
    ).toBe(256)

    const readBytes = slice.mock.calls.reduce(
      (sum, [start = 0, end = file.size]) =>
        sum + Math.min(file.size, end) - start,
      0,
    )

    expect(readBytes).toBeLessThan(file.size * 8)
  })

  it('counts trustworthy XML work from bounded metadata, including descriptors and ZIP64 footers', async () => {
    for (const [bytes, count] of [
      [archive(), 2],
      [streamedArchive(), 1],
      [zip64Footer(archive()), 2],
      [
        zipSync({
          'folder/': new Uint8Array(),
          'one.XML': strToU8(directXml()),
          'ignored.txt': strToU8('text'),
        }),
        1,
      ],
      [zipSync({}), 0],
    ] as const) {
      expect(
        await countZipXml(new Blob([bytes]), limits, immediateControl),
      ).toBe(count)
    }
  })

  it('keeps progress unknown for missing metadata or central/local disagreement without rejecting recoverable XML', async () => {
    const bytes = archive()
    const central = signature(bytes, 0x02014b50)
    const mismatch = bytes.slice()

    mismatch.set(strToU8('first.txt'), central + 46)
    expect(
      await countZipXml(
        new Blob([bytes.subarray(0, central)]),
        limits,
        immediateControl,
      ),
    ).toBeNull()
    expect(
      await countZipXml(new Blob([mismatch]), limits, immediateControl),
    ).toBeNull()

    const recovered = await recover(mismatch)

    expect(recovered.returned).toEqual(['first.xml', 'second.xml'])
    expect(recovered.error).toBeNull()
  })

  it('propagates cancellation from optional progress indexing', async () => {
    await expect(
      countZipXml(new Blob([archive()]), limits, {
        ...immediateControl,

        cancelled: () => true,
      }),
    ).rejects.toBeInstanceOf(ProcessingCancelled)
  })

  it('reports missing footer at a complete local-entry boundary, retaining the first XML', async () => {
    const bytes = archive()
    const second = signature(bytes, 0x04034b50, 4)

    const result = await recover(bytes.subarray(0, second))

    expect(result.returned).toEqual(['first.xml'])
    expect(result.summary.knownXml).toBe(1)
    expect(result.error).toHaveProperty('detail.code', 'INVALID_ZIP')
  })

  it('reports a removed or damaged central directory after retaining all local XMLs', async () => {
    const bytes = archive()
    const central = signature(bytes, 0x02014b50)

    for (const damaged of [
      bytes.subarray(0, central),
      join(bytes.subarray(0, central), bytes.subarray(bytes.length - 22)),
    ]) {
      const result = await recover(damaged)

      expect(result.returned).toEqual(['first.xml', 'second.xml'])
      expect(result.error).toHaveProperty('detail.code', 'INVALID_ZIP')
    }
  })

  it('accepts normal, empty, maximal-comment and EOCD-looking-comment archives', async () => {
    const fake = new Uint8Array(22)

    new DataView(fake.buffer).setUint32(0, 0x06054b50, true)

    for (const bytes of [
      archive(),
      zipSync({}),
      comment(archive(), new Uint8Array(65_535).fill(65)),
      comment(archive(), join(strToU8('comment'), fake)),
      comment(zipSync({}), fake),
    ]) {
      expect((await recover(bytes)).error).toBeNull()
    }
  })

  it('accepts streaming data descriptors both with and without their optional signature', async () => {
    const bytes = streamedArchive()
    const descriptor = signature(bytes, 0x08074b50)
    const noSignature = join(
      bytes.subarray(0, descriptor),
      bytes.subarray(descriptor + 4),
    )
    const footer = new DataView(noSignature.buffer, noSignature.length - 22, 22)

    footer.setUint32(16, footer.getUint32(16, true) - 4, true)

    for (const valid of [bytes, noSignature]) {
      const result = await recover(valid)

      expect(result.returned).toEqual(['stream.xml'])
      expect(result.error).toBeNull()
    }
  })

  it('accepts a ZIP64 footer and rejects its truncated locator', async () => {
    const valid = zip64Footer(archive())

    expect((await recover(valid)).error).toBeNull()

    const broken = join(
      valid.subarray(0, valid.length - 23),
      valid.subarray(valid.length - 22),
    )

    expect((await recover(broken)).error).toHaveProperty(
      'detail.code',
      'INVALID_ZIP',
    )
  })

  it('reports the damaged source after its confirmed XML and continues other selected files', async () => {
    const bytes = archive()
    const damaged = new File(
      [bytes.subarray(0, signature(bytes, 0x04034b50, 4))],
      'damaged.zip',
    )
    const events: WorkerEvent[] = []
    const classifier = {
      prepare: async () => undefined,

      classify: async (concepts: Parameters<typeof predictions>[0]) =>
        predictions(concepts),

      dispose: async () => undefined,

      currentPackage: () => modelPackage,
    }
    const controller = createWorkerController((event) => {
      events.push(event)

      if (event.type === 'invoice_result' && event.result.ok) {
        void controller.handle({
          type: 'commit_result',
          requestId: event.requestId,
          attemptId: event.attemptId,
          entry: event.entry,
          resultId: event.resultId,
          outcome: {
            status: 'saved',
            invoiceId: event.result.invoice.id,
            revision: 1,
          },
        })
      }
    }, classifier)
    const other = source(new File([directXml()], 'other.xml'))

    await controller.handle({
      type: 'process',
      requestId: 'r',
      attemptId: 'a',
      modelPackageId: modelPackage.id,
      limits,
      sources: [
        source(damaged, 'zip'),
        {
          ...other,
          selectionId: 'other',
          source: { ...other.source, id: 'other-source' },
        },
      ],
    })

    const summaries = events.filter((event) => event.type === 'source_result')

    expect(summaries[0]).toMatchObject({
      counts: { knownXml: 1, savedXml: 1 },
      error: { code: 'INVALID_ZIP', retryable: false },
    })
    expect(summaries[1]).toMatchObject({
      counts: { savedXml: 1 },
      error: null,
    })
    expect(events.at(-1)?.type).toBe('completed')
  })
})
