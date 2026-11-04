import { WorkerErrorCode, WorkerStage } from './workerProtocol'
import {
  checkpoint,
  failure,
  ProcessingCancelled,
  type ProcessingLimits,
  type WorkControl,
} from './processingLimits'

const endSignature = 0x06054b50
const centralSignature = 0x02014b50
const zip64LocatorSignature = 0x07064b50
const zip64EndSignature = 0x06064b50

function invalid(): never {
  throw failure(
    WorkerErrorCode.InvalidZip,
    WorkerStage.Zip,
    'El ZIP está incompleto o su directorio no es válido.',
  )
}

function safeInteger(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalid()
  }

  return Number(value)
}

// El lector puede recuperar archivos completos antes de encontrar el final del
// ZIP. La validación del contenedor se hace después para conservar esos
// archivos. El formato sigue PKWARE APPNOTE, secciones 4.3.12 y 4.3.14 a
// 4.3.16.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
async function inspectZipContainer(
  file: Blob,
  observedEntries: number | undefined,
  limits: ProcessingLimits,
  control: WorkControl,
) {
  const tailOffset = Math.max(0, file.size - 65_557)

  const tail = new DataView(await file.slice(tailOffset).arrayBuffer())

  const windows = [
    { offset: -1, bytes: new Uint8Array() },
    { offset: -1, bytes: new Uint8Array() },
  ]

  // Las ventanas de lectura tienen un tamaño fijo para que los nombres y los
  // campos adicionales de un ZIP grande no obliguen a cargarlo entero.
  async function read(
    offset: number,
    length: number,
    local = false,
  ): Promise<DataView> {
    const window = windows[Number(local)]

    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      length < 0 ||
      offset + length > file.size
    ) {
      invalid()
    }

    if (
      offset < window.offset ||
      offset + length > window.offset + window.bytes.byteLength
    ) {
      window.offset = offset

      window.bytes = new Uint8Array(
        await file
          .slice(offset, Math.min(file.size, offset + Math.max(65_536, length)))
          .arrayBuffer(),
      )
    }

    return new DataView(
      window.bytes.buffer,
      window.bytes.byteOffset + offset - window.offset,
      length,
    )
  }

  async function validate(end: number, footer: DataView) {
    if (footer.getUint16(4, true) !== 0 || footer.getUint16(6, true) !== 0) {
      invalid()
    }

    let count = footer.getUint16(10, true)
    let size = footer.getUint32(12, true)
    let offset = footer.getUint32(16, true)
    let directoryEnd = end

    const locator = end >= 20 ? await read(end - 20, 20) : null

    const plainDirectory =
      count !== 0xffff &&
      size !== 0xffffffff &&
      offset !== 0xffffffff &&
      offset + size === end

    if (
      !plainDirectory &&
      locator?.getUint32(0, true) === zip64LocatorSignature
    ) {
      if (
        locator.getUint32(4, true) !== 0 ||
        locator.getUint32(16, true) !== 1
      ) {
        invalid()
      }

      const zip64Offset = safeInteger(locator.getBigUint64(8, true))

      const record = await read(zip64Offset, 56)

      if (
        record.getUint32(0, true) !== zip64EndSignature ||
        record.getUint32(16, true) !== 0 ||
        record.getUint32(20, true) !== 0
      ) {
        invalid()
      }

      const recordSize = safeInteger(record.getBigUint64(4, true))

      if (recordSize < 44 || zip64Offset + 12 + recordSize !== end - 20) {
        invalid()
      }

      count = safeInteger(record.getBigUint64(32, true))

      if (safeInteger(record.getBigUint64(24, true)) !== count) {
        invalid()
      }

      size = safeInteger(record.getBigUint64(40, true))
      offset = safeInteger(record.getBigUint64(48, true))
      directoryEnd = zip64Offset
    } else if (
      count === 0xffff ||
      size === 0xffffffff ||
      offset === 0xffffffff
    ) {
      invalid()
    }

    if (footer.getUint16(8, true) !== footer.getUint16(10, true)) {
      invalid()
    }

    if (
      (observedEntries !== undefined && count !== observedEntries) ||
      count > limits.maxZipEntries ||
      offset + size !== directoryEnd
    ) {
      invalid()
    }

    if (count === 0 && size === 0) {
      return 0
    }

    if (offset >= directoryEnd) {
      invalid()
    }

    let position = offset

    const first = await read(position, 8)

    if (first.getUint32(0, true) === 0x08064b50) {
      position += 8 + first.getUint32(4, true)
    }

    let xmlCount = 0
    const localRecords: { offset: number; end: number }[] = []

    for (let index = 0; index < count; index++) {
      if (index % 32 === 0) {
        await checkpoint(control)
      }

      if (position + 46 > directoryEnd) {
        invalid()
      }

      const header = await read(position, 46)

      if (header.getUint32(0, true) !== centralSignature) {
        invalid()
      }

      const nameBytes = header.getUint16(28, true)
      const extraBytes = header.getUint16(30, true)
      const commentBytes = header.getUint16(32, true)
      const localOffset = header.getUint32(42, true)
      const disk = header.getUint16(34, true)
      const next = position + 46 + nameBytes + extraBytes + commentBytes

      if (
        next > directoryEnd ||
        (disk !== 0 && disk !== 0xffff) ||
        (localOffset !== 0xffffffff && localOffset >= offset)
      ) {
        invalid()
      }

      if (nameBytes >= 4) {
        const suffix = await read(position + 46 + nameBytes - 4, 4)

        if (
          suffix.getUint8(0) === 46 &&
          (suffix.getUint8(1) | 32) === 120 &&
          (suffix.getUint8(2) | 32) === 109 &&
          (suffix.getUint8(3) | 32) === 108
        ) {
          xmlCount++
        }
      }

      // ZIP64 solo añade un valor de 64 bits cuando el campo original contiene
      // su valor máximo. Eso determina qué valores hay que saltar para leer la
      // posición del archivo.
      if (localOffset === 0xffffffff || disk === 0xffff) {
        const extra = await read(position + 46 + nameBytes, extraBytes)

        let found = false

        for (let cursor = 0; cursor + 4 <= extra.byteLength;) {
          const length = extra.getUint16(cursor + 2, true)
          const end = cursor + 4 + length

          if (end > extra.byteLength) {
            invalid()
          }

          if (extra.getUint16(cursor, true) === 1) {
            let valueOffset = cursor + 4

            if (header.getUint32(24, true) === 0xffffffff) {
              valueOffset += 8
            }

            if (header.getUint32(20, true) === 0xffffffff) {
              valueOffset += 8
            }

            if (localOffset === 0xffffffff) {
              if (
                valueOffset + 8 > end ||
                safeInteger(extra.getBigUint64(valueOffset, true)) >= offset
              ) {
                invalid()
              }

              valueOffset += 8
            }

            if (
              disk === 0xffff &&
              (valueOffset + 4 > end ||
                extra.getUint32(valueOffset, true) !== 0)
            ) {
              invalid()
            }

            found = true
            break
          }

          cursor = end
        }

        if (!found) {
          invalid()
        }
      }

      if (observedEntries === undefined) {
        // El total solo se usa si coincide con los archivos que puede leer el
        // importador. Si hay dudas, se deja el progreso sin total y se intenta
        // recuperar las facturas.
        const compressed = header.getUint32(20, true)
        const uncompressed = header.getUint32(24, true)

        if ([localOffset, compressed, uncompressed].includes(0xffffffff)) {
          invalid()
        }

        const local = await read(localOffset, 30, true)

        const flags = header.getUint16(8, true)

        if (
          local.getUint32(0, true) !== 0x04034b50 ||
          local.getUint16(6, true) !== flags ||
          local.getUint16(8, true) !== header.getUint16(10, true) ||
          local.getUint16(26, true) !== nameBytes
        ) {
          invalid()
        }

        const centralName = await read(position + 46, nameBytes)
        const localName = await read(localOffset + 30, nameBytes, true)

        for (let byte = 0; byte < nameBytes; byte++) {
          if (centralName.getUint8(byte) !== localName.getUint8(byte)) {
            invalid()
          }
        }

        let end =
          localOffset + 30 + nameBytes + local.getUint16(28, true) + compressed

        if (flags & 8) {
          const signed =
            (await read(end, 4, true)).getUint32(0, true) === 0x08074b50
          const descriptor = await read(end + (signed ? 4 : 0), 12, true)

          if (
            descriptor.getUint32(0, true) !== header.getUint32(16, true) ||
            descriptor.getUint32(4, true) !== compressed ||
            descriptor.getUint32(8, true) !== uncompressed
          ) {
            invalid()
          }

          end += signed ? 16 : 12
        } else if (
          local.getUint32(14, true) !== header.getUint32(16, true) ||
          local.getUint32(18, true) !== compressed ||
          local.getUint32(22, true) !== uncompressed
        ) {
          invalid()
        }

        if (end > offset) {
          invalid()
        }

        localRecords.push({ offset: localOffset, end })
      }

      position = next
    }

    // Esta firma pertenece al contenedor ZIP y no a la firma fiscal del XML.
    if (position < directoryEnd) {
      if (position + 6 > directoryEnd) {
        invalid()
      }

      const signature = await read(position, 6)

      if (signature.getUint32(0, true) !== 0x05054b50) {
        invalid()
      }

      position += 6 + signature.getUint16(4, true)
    }

    if (position !== directoryEnd) {
      invalid()
    }

    if (observedEntries === undefined) {
      localRecords.sort((a, b) => a.offset - b.offset)

      let expected = 0

      for (const local of localRecords) {
        if (local.offset !== expected) {
          invalid()
        }

        expected = local.end
      }

      if (expected !== offset) {
        invalid()
      }
    }

    return xmlCount
  }

  for (let index = tail.byteLength - 22; index >= 0; index--) {
    if (
      tail.getUint32(index, true) !== endSignature ||
      index + 22 + tail.getUint16(index + 20, true) !== tail.byteLength
    ) {
      continue
    }

    await checkpoint(control)

    try {
      return await validate(
        tailOffset + index,
        new DataView(tail.buffer, tail.byteOffset + index, 22),
      )
    } catch (error) {
      // El comentario del ZIP puede contener bytes que parezcan un final de
      // archivo. Se prueban otros finales posibles sin tratar una cancelación
      // como un error de formato.
      if (!(error instanceof Error) || !('detail' in error)) {
        throw error
      }
    }
  }

  invalid()
}

export async function validateZipContainer(
  file: Blob,
  observedEntries: number,
  limits: ProcessingLimits,
  control: WorkControl,
) {
  await inspectZipContainer(file, observedEntries, limits, control)
}

export async function countZipXml(
  file: Blob,
  limits: ProcessingLimits,
  control: WorkControl,
): Promise<number | null> {
  if (file.size > limits.maxInputBytes) {
    return null
  }

  try {
    return await inspectZipContainer(file, undefined, limits, control)
  } catch (error) {
    if (error instanceof ProcessingCancelled) {
      throw error
    }

    return null
  }
}
