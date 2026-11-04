import { FileResultStatus } from './processingStatus'
import type { Result } from '../../../shared/lib/result'
import type {
  FileProcessingResult,
  SelectedProcessingFile,
} from '../services/processingService'

export interface SelectedFile extends SelectedProcessingFile {
  failure?: string
  unresolved?: boolean
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  const unit = bytes < 1048576 ? 'KiB' : 'MiB'
  const divisor = bytes < 1048576 ? 1024 : 1048576
  const amount = new Intl.NumberFormat('es-EC', {
    maximumFractionDigits: 1,
  }).format(bytes / divisor)

  return `${amount} ${unit}`
}

export function validateFileType(file: File): Result<void> {
  if (!/\.(xml|zip)$/i.test(file.name)) {
    return {
      ok: false,
      code: 'unsupported-type',
      message: `«${file.name}» no es un archivo XML o ZIP. No se añadió la tanda.`,
    }
  }

  return { ok: true, value: undefined }
}

export function validateFileCount(
  existingCount: number,
  incomingCount: number,
  maxFiles: number,
  hadSelection: boolean,
): Result<void> {
  const consequence = hadSelection
    ? 'Tu selección anterior se mantiene.'
    : 'No se añadió ningún archivo.'

  if (existingCount > maxFiles - incomingCount) {
    const fileLabel = maxFiles === 1 ? 'archivo' : 'archivos'

    return {
      ok: false,
      code: 'file-limit',
      message: `No se pueden añadir más de ${maxFiles} ${fileLabel} en total. ${consequence}`,
    }
  }

  return { ok: true, value: undefined }
}

export function validateSelection(
  existingCount: number,
  incoming: readonly File[],
  maxFiles: number,
  hadSelection: boolean,
): Result<void> {
  const count = validateFileCount(
    existingCount,
    incoming.length,
    maxFiles,
    hadSelection,
  )

  if (!count.ok) {
    return count
  }

  for (const file of incoming) {
    const type = validateFileType(file)

    if (!type.ok) {
      return type
    }
  }

  return { ok: true, value: undefined }
}

export function reconcileSelection(
  selected: readonly SelectedFile[],
  confirmed: readonly FileProcessingResult[],
  notStartedIds: ReadonlySet<string>,
): SelectedFile[] {
  const results = new Map(confirmed.map((result) => [result.id, result]))

  return selected.flatMap((entry) => {
    const result = results.get(entry.id)

    if (notStartedIds.has(entry.id) || result?.retryable) {
      return [{ id: entry.id, file: entry.file, failure: result?.message }]
    }

    if (
      result?.status === FileResultStatus.Added ||
      result?.status === FileResultStatus.Duplicate
    ) {
      return []
    }

    if (result?.status === FileResultStatus.Error) {
      if (result.retryable === false) {
        return []
      }

      return [{ id: entry.id, file: entry.file, failure: result.message }]
    }

    return [{ id: entry.id, file: entry.file }]
  })
}
