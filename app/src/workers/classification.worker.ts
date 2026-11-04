import {
  WorkerErrorCode,
  WorkerMessageType,
  WorkerStage,
} from './workerProtocol'
import { createWorkerController } from './workerController'
import type { WorkerRequest } from './workerProtocol'

const controller = createWorkerController((event) => self.postMessage(event))

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  void controller.handle(event.data).catch(() => {
    self.postMessage({
      requestId: event.data.requestId,
      attemptId: event.data.attemptId,
      type: WorkerMessageType.Failed,
      error: {
        code: WorkerErrorCode.WorkerFailed,
        stage: WorkerStage.Read,
        message: 'No se pudo completar la solicitud del Worker.',
        retryable: true,
      },
      notStartedSelectionIds: [],
      pendingEntries: [],
      lastEmittedResultId: null,
      unconfirmedResultIds: [],
    })
  })
})
