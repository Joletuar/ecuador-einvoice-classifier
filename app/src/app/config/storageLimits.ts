import { inject, type InjectionKey } from 'vue'

export interface StorageLimits {
  maxFiles: number
  maxTotalBytes: number
}

export const storageLimitsKey: InjectionKey<StorageLimits> =
  Symbol('storageLimits')

export function useStorageLimits(): StorageLimits {
  const limits = inject(storageLimitsKey)

  if (!limits) {
    throw new Error('Storage limits must be provided by the application.')
  }

  return limits
}
