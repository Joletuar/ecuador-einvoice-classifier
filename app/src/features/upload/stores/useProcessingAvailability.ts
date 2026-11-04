import { defineStore } from 'pinia'
import { computed, onScopeDispose, shallowRef } from 'vue'

import { PreparationKind } from '../model/processingStatus'
import { useProcessingService } from '../services/processingService'

export const useProcessingAvailability = defineStore(
  'processing-availability',
  () => {
    const service = useProcessingService()
    const state = shallowRef(service.state)

    onScopeDispose(
      service.subscribe((next) => {
        state.value = next
      }),
    )

    const issue = computed(() =>
      state.value.kind === PreparationKind.Error
        ? state.value.message
        : state.value.kind === PreparationKind.Loading
          ? 'Preparando el modelo de clasificación…'
          : undefined,
    )
    const available = computed(() => state.value.kind === PreparationKind.Ready)

    return { state, issue, available, retry: () => service.prepare() }
  },
)
