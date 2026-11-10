import { Unzip, UnzipInflate } from 'fflate'

import {
  ArchiveOmissionReason,
  SourceEntryMode,
  WorkerErrorCode,
  WorkerStage,
} from './workerProtocol'
import { readZipIntegrity, validateZipContainer } from './zipContainer'
import type { ZipEntryIntegrity } from './zipContainer'
import type { SourceEntrySelection, WorkerError } from './workerProtocol'
import {
  blobChunks,
  checkpoint,
  failure,
  ProcessingFailure,
  type ProcessingLimits,
  type WorkControl,
} from './processingLimits'

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index

  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }

  return value
})

function crc32(value: number, chunk: Uint8Array) {
  for (const byte of chunk) {
    value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]
  }

  return value
}

export interface ZipXmlEntry {
  readonly entryIndex: number
  readonly entryPath: string
  readonly chunks: readonly Uint8Array[]
  readonly error: WorkerError | null
}

export interface ZipReadState {
  knownXml: number
  omissions: {
    entryPath: string
    reason:
      | typeof ArchiveOmissionReason.NestedZip
      | typeof ArchiveOmissionReason.UnsupportedFile
  }[]
}

export async function* readZipInvoices(
  file: Blob,
  selection: SourceEntrySelection,
  limits: ProcessingLimits,
  control: WorkControl,
  state: ZipReadState,
): AsyncGenerator<ZipXmlEntry> {
  const settled = new Map(
    selection.mode === SourceEntryMode.Retry
      ? selection.settledEntries.map((entry) => [
          entry.entryIndex,
          entry.entryPath,
        ])
      : [],
  )
  const integrity = await readZipIntegrity(file, limits, control)
  const localHeaders: { size?: number; originalSize?: number }[] = []
  let localCursor = 0
  let localIndex = 0
  const queue: (ZipXmlEntry & { crc?: number; expandedBytes?: number })[] = []
  let ordinal = 0

  let expandedBytes = 0
  let firstChunk = true
  let limitError: ProcessingFailure | null = null

  async function expectedIntegrity(index: number): Promise<ZipEntryIntegrity> {
    if (integrity?.[index]) {
      return integrity[index]
    }

    let expected: ZipEntryIntegrity | undefined

    while (!integrity && localIndex <= index) {
      await checkpoint(control)

      const entry = localHeaders[localIndex++]

      expected = undefined

      const size = entry?.size
      const originalSize = entry?.originalSize
      const header = new DataView(
        await file.slice(localCursor, localCursor + 30).arrayBuffer(),
      )

      if (
        header.byteLength !== 30 ||
        header.getUint32(0, true) !== 0x04034b50 ||
        header.getUint16(6, true) & 8 ||
        size === undefined ||
        originalSize === undefined ||
        !Number.isSafeInteger(size) ||
        !Number.isSafeInteger(originalSize) ||
        size < 0 ||
        originalSize < 0
      ) {
        break
      }

      expected = {
        offset: localCursor,
        crc: header.getUint32(14, true),
        expandedBytes: originalSize,
      }
      localCursor +=
        30 + header.getUint16(26, true) + header.getUint16(28, true) + size

      if (localCursor > file.size || !Number.isSafeInteger(localCursor)) {
        expected = undefined
        break
      }
    }

    if (!expected) {
      throw failure(
        WorkerErrorCode.InvalidZip,
        WorkerStage.Zip,
        'No se pudo verificar la integridad de una entrada del ZIP.',
      )
    }

    return expected
  }

  async function verify(entry: (typeof queue)[number]): Promise<ZipXmlEntry> {
    if (entry.error) {
      return entry
    }

    const expected = await expectedIntegrity(entry.entryIndex)

    if (
      entry.crc === expected.crc &&
      entry.expandedBytes === expected.expandedBytes
    ) {
      return entry
    }

    return {
      ...entry,
      chunks: [],
      error: {
        code: WorkerErrorCode.InvalidZip,
        stage: WorkerStage.Zip,
        message:
          'La entrada XML del ZIP está dañada: CRC o tamaño incorrectos.',
        retryable: false,
      },
    }
  }

  const unzip = new Unzip((entry) => {
    if (limitError) {
      return
    }

    const entryIndex = ordinal++

    if (ordinal > limits.maxZipEntries) {
      throw failure(
        WorkerErrorCode.LimitExceeded,
        WorkerStage.Zip,
        'El ZIP supera el límite de entradas.',
      )
    }

    if (!integrity) {
      localHeaders.push({ size: entry.size, originalSize: entry.originalSize })
    }

    if (entry.name.endsWith('/')) {
      return
    }

    if (!/\.xml$/i.test(entry.name)) {
      state.omissions.push({
        entryPath: entry.name,
        reason: /\.zip$/i.test(entry.name)
          ? ArchiveOmissionReason.NestedZip
          : ArchiveOmissionReason.UnsupportedFile,
      })

      return
    }

    state.knownXml++

    if (settled.get(entryIndex) === entry.name) {
      return
    }

    const chunks: Uint8Array[] = []
    let entryBytes = 0
    let crc = 0xffffffff
    let ended = false

    entry.ondata = (error, chunk, final) => {
      if (ended) {
        return
      }

      if (error) {
        ended = true
        queue.push({
          entryIndex,
          entryPath: entry.name,
          chunks: [],
          error: {
            code: WorkerErrorCode.InvalidZip,
            stage: WorkerStage.Zip,
            message: 'No se pudo descomprimir la entrada XML.',
            retryable: false,
          },
        })

        return
      }

      entryBytes += chunk.byteLength
      expandedBytes += chunk.byteLength

      if (
        entryBytes > limits.maxXmlBytes ||
        expandedBytes > limits.maxExpandedBytes
      ) {
        limitError = failure(
          WorkerErrorCode.LimitExceeded,
          WorkerStage.Zip,
          'El ZIP supera el límite de bytes descomprimidos.',
        )
        ended = true

        return
      }

      crc = crc32(crc, chunk)
      chunks.push(chunk)

      if (final) {
        ended = true
        queue.push({
          entryIndex,
          entryPath: entry.name,
          chunks,
          error: null,
          crc: (crc ^ 0xffffffff) >>> 0,
          expandedBytes: entryBytes,
        })
      }
    }
    entry.start()
  })

  unzip.register(UnzipInflate)

  let streamError: unknown

  for await (const chunk of blobChunks(file, limits, control)) {
    if (firstChunk) {
      firstChunk = false

      const signature = new DataView(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength,
      )

      if (
        chunk.byteLength < 4 ||
        ![0x04034b50, 0x06054b50].includes(signature.getUint32(0, true))
      ) {
        throw failure(
          WorkerErrorCode.InvalidZip,
          WorkerStage.Zip,
          'El archivo no contiene un ZIP válido.',
        )
      }
    }

    try {
      unzip.push(chunk, false)
    } catch (error) {
      streamError = error
    }

    if (limitError) {
      streamError = limitError
    }

    while (queue.length) {
      await checkpoint(control)

      yield await verify(queue.shift()!)
    }

    if (streamError) {
      break
    }
  }

  if (!streamError) {
    try {
      unzip.push(new Uint8Array(), true)
    } catch (error) {
      streamError = error
    }
  }

  while (queue.length) {
    await checkpoint(control)

    yield await verify(queue.shift()!)
  }

  if (firstChunk || streamError) {
    if (streamError instanceof ProcessingFailure) {
      throw streamError
    }

    throw failure(
      WorkerErrorCode.InvalidZip,
      WorkerStage.Zip,
      'El ZIP está incompleto o no se pudo leer.',
    )
  }

  await validateZipContainer(file, ordinal, limits, control)
}
