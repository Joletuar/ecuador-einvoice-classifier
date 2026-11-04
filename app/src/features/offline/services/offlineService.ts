import { inject, type InjectionKey } from 'vue'

import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import type { Awaitable } from '../../../shared/lib/result'

export interface OfflineView {
  tone:
    | typeof FeedbackTone.Neutral
    | typeof FeedbackTone.Success
    | typeof FeedbackTone.Warning
    | typeof FeedbackTone.Danger
  label: string
  items: {
    label: string
    detail?: string
    tone:
      | typeof FeedbackTone.Success
      | typeof FeedbackTone.Warning
      | typeof FeedbackTone.Danger
  }[]
  updateAvailable: boolean
  updateLabel: string
  cacheReady?: boolean
  preparing?: boolean
  canRetry?: boolean
  updatePending?: boolean
}

export interface UpdatePermission {
  allowed: boolean
  commit(): void
  cancel(): void
}

export interface OfflineService {
  current(): OfflineView
  subscribe(listener: (view: OfflineView) => void): () => void
  retry(): Promise<void>
  applyUpdate(prepareLeave: () => Awaitable<UpdatePermission>): Promise<void>
  dispose(): void
}

export const offlineServiceKey: InjectionKey<OfflineService> =
  Symbol('offlineService')

export function useOfflineService(): OfflineService {
  const service = inject(offlineServiceKey)

  if (!service) {
    throw new Error('Offline service must be provided by the application.')
  }

  return service
}
