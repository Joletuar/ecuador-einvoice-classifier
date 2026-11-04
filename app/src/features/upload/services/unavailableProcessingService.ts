import {
  PreparationKind,
  ProcessingOutcomeKind,
} from '../model/processingStatus'
import type { ProcessingService } from './processingService'

export const processingUnavailableMessage =
  'El procesamiento de archivos no está disponible. Tu selección permanece en esta sesión.'

export function createUnavailableProcessingService(): ProcessingService {
  return {
    available: false,
    state: {
      kind: PreparationKind.Error,
      message: processingUnavailableMessage,
    },

    prepare: async () => undefined,

    subscribe(listener) {
      listener({
        kind: PreparationKind.Error,
        message: processingUnavailableMessage,
      })

      return () => undefined
    },

    process: () => ({
      ok: true,
      value: {
        kind: ProcessingOutcomeKind.Unavailable,
        message: processingUnavailableMessage,
      },
    }),
  }
}
