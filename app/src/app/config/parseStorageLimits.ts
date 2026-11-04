import type { StorageLimits } from './storageLimits'

function positiveInteger(name: string, value: string | undefined): number {
  if (!value || !/^[0-9]+$/.test(value)) {
    throw new Error(name + ' debe ser un entero decimal positivo.')
  }

  const number = Number(value)

  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(
      name + ' debe ser un entero positivo dentro del rango seguro.',
    )
  }

  return number
}

export function parseStorageLimits(
  env: Record<string, string | undefined>,
): Readonly<StorageLimits> {
  return Object.freeze({
    maxFiles: positiveInteger(
      'VITE_STORAGE_MAX_FILES',
      env.VITE_STORAGE_MAX_FILES,
    ),
    maxTotalBytes: positiveInteger(
      'VITE_STORAGE_MAX_BYTES',
      env.VITE_STORAGE_MAX_BYTES,
    ),
  })
}
