import type {
  PreparationState,
  ProcessingService,
} from '../../src/features/upload/services/processingService'

export function readyProcessing(
  process: ProcessingService['process'],
): ProcessingService {
  const state: PreparationState = { kind: 'ready' }

  return {
    available: true,
    state,

    prepare: async () => undefined,

    subscribe(listener) {
      listener(state)

      return () => undefined
    },

    process,
  }
}
