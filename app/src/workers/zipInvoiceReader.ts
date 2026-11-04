import { Unzip, UnzipInflate } from 'fflate'

import {
  ArchiveOmissionReason,
  SourceEntryMode,
  WorkerErrorCode,
  WorkerStage,
} from './workerProtocol'
import { validateZipContainer } from './zipContainer'
import type { SourceEntrySelection, WorkerError } from './workerProtocol'
import {
  blobChunks,
  checkpoint,
  failure,
  ProcessingFailure,
  type ProcessingLimits,
  type WorkControl,
} from './processingLimits'

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
  const queue: ZipXmlEntry[] = []
  let ordinal = 0

  let expandedBytes = 0
  let firstChunk = true
  let limitError: ProcessingFailure | null = null

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

      chunks.push(chunk)

      if (final) {
        ended = true
        queue.push({ entryIndex, entryPath: entry.name, chunks, error: null })
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

      yield queue.shift()!
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

    yield queue.shift()!
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
