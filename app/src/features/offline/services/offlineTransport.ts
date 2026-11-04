import {
  OfflineMessageType,
  OfflinePhase,
  OfflinePreparation,
  isOfflineEnvelope,
  isOfflineIdentity,
  type OfflineRequest,
  type OfflineResponse,
} from './offlineProtocol'

export class OfflineTransportFailure extends Error {
  constructor(readonly delivered: boolean) {
    super('No se recibió una respuesta verificable de la preparación offline.')
  }
}

export function createOfflineTransport(timeoutMs: number) {
  const pending = new Set<() => void>()
  let disposed = false

  return {
    request(
      worker: ServiceWorker,
      request: OfflineRequest,
      onDelivered?: () => void,
    ) {
      return new Promise<OfflineResponse>((resolve, reject) => {
        if (disposed) {
          reject(new OfflineTransportFailure(false))

          return
        }

        const channel = new MessageChannel()
        let delivered = false

        function cleanup() {
          clearTimeout(timer)
          pending.delete(cancel)
          channel.port1.onmessage = null
          channel.port1.close()
          channel.port2.close()
        }

        function cancel() {
          cleanup()
          reject(new OfflineTransportFailure(delivered))
        }

        const timer = setTimeout(cancel, timeoutMs)

        pending.add(cancel)
        channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
          if (
            !isOfflineEnvelope(data) ||
            data.requestId !== request.requestId
          ) {
            return
          }

          const response = data as OfflineResponse

          if (!isOfflineIdentity(response.identity)) {
            return
          }

          if (
            request.type === OfflineMessageType.GetStatus ||
            request.type === OfflineMessageType.PrepareResources
          ) {
            if (
              response.type !== OfflineMessageType.Status ||
              typeof response.matchesExpected !== 'boolean' ||
              typeof response.uiComplete !== 'boolean' ||
              typeof response.classifierComplete !== 'boolean' ||
              ![
                OfflinePreparation.Ready,
                OfflinePreparation.Incomplete,
                OfflinePreparation.Error,
              ].includes(response.preparation)
            ) {
              return
            }
          } else if (request.type === OfflineMessageType.GetCandidateState) {
            if (
              response.type !== OfflineMessageType.CandidateState ||
              ![
                OfflinePhase.Idle,
                OfflinePhase.Unknown,
                OfflinePhase.Preparing,
                OfflinePhase.Prepared,
                OfflinePhase.Activating,
              ].includes(response.phase) ||
              (response.phase === OfflinePhase.Idle &&
                response.attemptId !== undefined) ||
              ([
                OfflinePhase.Preparing,
                OfflinePhase.Prepared,
                OfflinePhase.Activating,
              ].some((phase) => phase === response.phase) &&
                typeof response.attemptId !== 'string') ||
              (response.attemptId !== undefined &&
                (typeof response.attemptId !== 'string' ||
                  !response.attemptId ||
                  response.attemptId.length > 200))
            ) {
              return
            }
          } else if (
            response.type !==
              (
                {
                  [OfflineMessageType.PrepareUpdate]:
                    OfflineMessageType.UpdatePrepared,
                  [OfflineMessageType.AbortUpdate]:
                    OfflineMessageType.UpdateAborted,
                  [OfflineMessageType.ActivateUpdate]:
                    OfflineMessageType.UpdateActivating,
                  [OfflineMessageType.GetUpdateStatus]:
                    OfflineMessageType.UpdateStatus,
                } as const
              )[request.type] ||
            response.attemptId !== request.attemptId ||
            typeof response.accepted !== 'boolean' ||
            ![
              OfflinePhase.Unknown,
              OfflinePhase.Preparing,
              OfflinePhase.Prepared,
              OfflinePhase.Activating,
              OfflinePhase.Aborted,
            ].includes(response.phase)
          ) {
            return
          }

          cleanup()
          resolve(response)
        }

        try {
          worker.postMessage(request, [channel.port2])
          delivered = true
          onDelivered?.()
        } catch {
          cancel()
        }
      })
    },

    dispose() {
      disposed = true

      for (const cancel of [...pending]) {
        cancel()
      }
    },
  }
}
