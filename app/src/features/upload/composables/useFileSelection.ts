import { computed, onScopeDispose, shallowRef } from 'vue'

import {
  ActivityMetric,
  ActivityOperation,
  ActivityPhase,
} from '../model/activity'
import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import { StorageErrorCode } from '../../invoices/domain/storageErrors'
import type { StorageLimits } from '../../../app/config/storageLimits'
import type { Result } from '../../../shared/lib/result'
import type { BatchActivity } from '../model/activity'
import { validateSelection, type SelectedFile } from '../model/selection'
import { usePaintYield } from './usePaintYield'

export type SelectionStorage =
  | { ready: false }
  | {
      ready: true
      files: number
      sourceIds: readonly string[]
      sourceNames: readonly string[]
    }

export function useFileSelection(
  limits: StorageLimits,
  getStorage: () => SelectionStorage,
) {
  const files = shallowRef<SelectedFile[]>([])
  const notice = shallowRef<string>()
  const busy = shallowRef(false)
  const activity = shallowRef<BatchActivity>({
    operation: ActivityOperation.Selection,
    phase: ActivityPhase.Idle,
    metric: ActivityMetric.Loaded,
    completed: 0,
    total: 0,
  })

  const unresolved = computed(() => files.value.some((item) => item.unresolved))

  const paint = usePaintYield()

  let generation = 0

  onScopeDispose(() => {
    generation++
  })

  function reject(message: string) {
    notice.value = message
    activity.value = {
      operation: ActivityOperation.Selection,
      phase: ActivityPhase.Failed,
      tone: FeedbackTone.Warning,
      metric: ActivityMetric.Loaded,
      completed: 0,
      total: 0,
      message,
    }
  }

  async function add(incoming: readonly File[]) {
    if (!incoming.length || busy.value || unresolved.value) {
      return
    }

    const storage = getStorage()

    if (!storage.ready) {
      reject(
        'Espera a que se consulte el almacenamiento antes de cargar archivos.',
      )

      return
    }

    const validation = validateSelection(
      files.value.length,
      incoming,
      limits.maxFiles,
      files.value.length > 0,
    )

    if (!validation.ok) {
      reject(validation.message)

      return
    }

    const token = ++generation

    busy.value = true
    notice.value = undefined
    activity.value = {
      operation: ActivityOperation.Selection,
      phase: ActivityPhase.Loading,
      metric: ActivityMetric.Loaded,
      completed: 0,
      total: incoming.length,
    }

    try {
      await paint()

      for (let offset = 0; offset < incoming.length; offset += 50) {
        if (token !== generation) {
          return
        }

        const batch: SelectedFile[] = []

        for (const file of incoming.slice(offset, offset + 50)) {
          batch.push({ id: crypto.randomUUID(), file })
          activity.value = {
            ...activity.value,
            completed: offset + batch.length,
          }
        }

        files.value = [...files.value, ...batch]

        if (offset + 50 < incoming.length) {
          await paint()
        }
      }

      activity.value = {
        ...activity.value,
        phase: ActivityPhase.Completed,
      }
    } finally {
      if (token === generation) {
        busy.value = false
      }
    }
  }

  function validate(): Result<void> {
    const storage = getStorage()

    if (!storage.ready) {
      return {
        ok: false,
        code: StorageErrorCode.Unavailable,
        message: 'No se pudo consultar la capacidad de almacenamiento.',
      }
    }

    return validateSelection(
      0,
      files.value.map((entry) => entry.file),
      limits.maxFiles,
      files.value.length > 0,
    )
  }

  function remove(id: string) {
    if (busy.value) {
      return
    }

    files.value = files.value.filter((item) => item.id !== id)
    notice.value = undefined
  }

  function cancel() {
    if (!busy.value) {
      return
    }

    generation++
    busy.value = false
    activity.value = {
      ...activity.value,
      phase: ActivityPhase.Cancelled,
      message: 'Se conservan únicamente los archivos ya añadidos.',
    }
  }

  function replace(next: SelectedFile[]) {
    files.value = next
  }

  function clear() {
    generation++
    files.value = []
    notice.value = undefined
    busy.value = false
    activity.value = {
      operation: ActivityOperation.Selection,
      phase: ActivityPhase.Idle,
      metric: ActivityMetric.Loaded,
      completed: 0,
      total: 0,
    }
  }

  return {
    files,
    busy,
    notice,
    activity,
    unresolved,
    add,
    cancel,
    remove,
    replace,
    validate,
    clear,
  }
}
