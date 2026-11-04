import {
  CommitStatus,
  WorkerErrorCode,
  WorkerMessageType,
  WorkerPreparationState,
  WorkerStage,
} from './workerProtocol'
import type { ModelPackageRecord } from '../features/invoices/domain/persistenceRecords'
import type { ProcessingLimits } from './processingLimits'
import type {
  CommitOutcome,
  ModelAsset,
  WorkerEvent,
  WorkerRequest,
  WorkerSource,
} from './workerProtocol'

export interface ClassifierPackage {
  readonly modelPackage: ModelPackageRecord
  readonly assets: readonly ModelAsset[]
}

type Payload<T = WorkerRequest> = T extends WorkerRequest
  ? Omit<T, 'requestId' | 'attemptId'>
  : never

export type TerminalEvent = Extract<
  WorkerEvent,
  {
    type:
      | typeof WorkerMessageType.Completed
      | typeof WorkerMessageType.Cancelled
      | typeof WorkerMessageType.Failed
  }
>

export type InvoiceEvent = Extract<
  WorkerEvent,
  { type: typeof WorkerMessageType.InvoiceResult }
>

interface Pending {
  request: WorkerRequest
  resolve(event: WorkerEvent): void
  reject(error: Error): void
  onEvent?(event: WorkerEvent): void
  commit?(event: InvoiceEvent): Promise<CommitOutcome>
  writes: Set<Promise<void>>
  unconfirmed: Set<string>
  seenResults: Set<string>
  observerFailed: boolean
  completion: Promise<WorkerEvent> | null
}

export function absoluteClassifierPackage(
  pack: ClassifierPackage,
  baseUrl = globalThis.location?.href,
): ClassifierPackage {
  return {
    modelPackage: pack.modelPackage,
    assets: pack.assets.map((asset) => ({
      ...asset,
      url: new URL(asset.url, baseUrl).href,
    })),
  }
}

export function createClassificationWorkerClient(
  factory: () => Worker = () =>
    new Worker(new URL('./classification.worker.ts', import.meta.url), {
      type: 'module',
    }),
) {
  let worker: Worker | null = null
  let sequence = 0
  let closed = false
  let disposing = false
  let disposal: Promise<void> | null = null

  let processPending: Pending | null = null

  const pending = new Map<string, Pending>()
  const failureListeners = new Set<(error: Error) => void>()

  async function settle(operation: Pending, event: WorkerEvent) {
    await Promise.all([...operation.writes])

    if (
      operation.request.type === WorkerMessageType.Process &&
      'unconfirmedResultIds' in event
    ) {
      event = {
        ...event,
        unconfirmedResultIds: [
          ...new Set([
            ...event.unconfirmedResultIds.filter(
              (id) => !operation.seenResults.has(id),
            ),
            ...operation.unconfirmed,
          ]),
        ],
      }
    }

    if (!pending.delete(operation.request.requestId)) {
      return
    }

    if (processPending === operation) {
      processPending = null
    }

    if (
      operation.observerFailed &&
      operation.request.type === WorkerMessageType.Process
    ) {
      operation.resolve({
        ...event,
        type: WorkerMessageType.Failed,
        error: {
          code: WorkerErrorCode.WorkerFailed,
          stage: WorkerStage.Read,
          message: 'No se pudo actualizar el estado del procesamiento.',
          retryable: true,
        },
        notStartedSelectionIds:
          'notStartedSelectionIds' in event ? event.notStartedSelectionIds : [],
        pendingEntries: 'pendingEntries' in event ? event.pendingEntries : [],
        lastEmittedResultId:
          'lastEmittedResultId' in event ? event.lastEmittedResultId : null,
        unconfirmedResultIds: [...operation.unconfirmed],
      })
    } else {
      operation.resolve(event)
    }
  }

  function failedWorker() {
    const broken = worker

    worker = null
    broken?.terminate()

    for (const operation of pending.values()) {
      if (operation.request.type === WorkerMessageType.Process) {
        const event: WorkerEvent = {
          requestId: operation.request.requestId,
          attemptId: operation.request.attemptId,
          type: WorkerMessageType.Failed,
          error: {
            code: WorkerErrorCode.WorkerFailed,
            stage: WorkerStage.Read,
            message: 'El Worker se interrumpió.',
            retryable: true,
          },
          notStartedSelectionIds: [],
          pendingEntries: [],
          lastEmittedResultId: null,
          unconfirmedResultIds: [...operation.unconfirmed],
        }

        void settle(operation, event)
      } else {
        pending.delete(operation.request.requestId)
        operation.reject(new Error('El Worker se interrumpió.'))
      }
    }

    const error = new Error(
      'El Worker se interrumpió. Reintenta la preparación del modelo.',
    )

    for (const listener of failureListeners) {
      try {
        listener(error)
      } catch {
        // Se continúa el cierre aunque falle una función que recibe el aviso
        // para no dejar operaciones pendientes.
      }
    }
  }

  function connect() {
    if (worker) {
      return worker
    }

    worker = factory()

    const connected = worker
    const onFailure = () => {
      if (worker === connected) {
        failedWorker()
      }
    }

    worker.addEventListener('error', onFailure)
    worker.addEventListener('messageerror', onFailure)
    worker.addEventListener('message', (message: MessageEvent<WorkerEvent>) => {
      if (worker !== connected) {
        return
      }

      const event = message.data
      const operation = pending.get(event.requestId)

      if (!operation || operation.request.attemptId !== event.attemptId) {
        return
      }

      if (event.type === WorkerMessageType.InvoiceResult) {
        if (operation.seenResults.has(event.resultId)) {
          return
        }

        operation.seenResults.add(event.resultId)
      }

      try {
        operation.onEvent?.(event)
      } catch {
        operation.observerFailed = true
        connected.postMessage({
          type: WorkerMessageType.Cancel,
          requestId: event.requestId,
          attemptId: event.attemptId,
        } satisfies WorkerRequest)
      }

      if (event.type === WorkerMessageType.InvoiceResult && operation.commit) {
        operation.unconfirmed.add(event.resultId)

        const currentWorker = worker
        const write = Promise.resolve()
          .then(() => operation.commit!(event))
          .catch((): CommitOutcome => ({
            status: CommitStatus.Uncertain,
            error: {
              code: WorkerErrorCode.WriteFailed,
              stage: WorkerStage.Persistence,
              message: 'No se pudo confirmar el guardado.',
              retryable: true,
            },
          }))
          .then((outcome) => {
            if (outcome.status !== CommitStatus.Uncertain) {
              operation.unconfirmed.delete(event.resultId)
            }

            if (worker === currentWorker && pending.has(event.requestId)) {
              currentWorker?.postMessage({
                type: WorkerMessageType.CommitResult,
                requestId: event.requestId,
                attemptId: event.attemptId,
                entry: event.entry,
                resultId: event.resultId,
                outcome,
              } satisfies WorkerRequest)
            }
          })
          .catch(failedWorker)

        operation.writes.add(write)
        void write.finally(() => operation.writes.delete(write))
      }

      const terminal =
        [
          WorkerMessageType.Completed,
          WorkerMessageType.Cancelled,
          WorkerMessageType.Failed,
          WorkerMessageType.Recalculated,
          WorkerMessageType.Disposed,
        ].some((type) => type === event.type) ||
        (event.type === WorkerMessageType.Preparation &&
          event.state !== WorkerPreparationState.Loading)

      if (terminal) {
        void settle(operation, event)
      }
    })

    return worker
  }

  function request(
    payload: Payload,
    hooks: Pick<Pending, 'onEvent' | 'commit'> = {},
  ) {
    if (closed || (disposing && payload.type !== WorkerMessageType.Dispose)) {
      throw new Error('El cliente del Worker está cerrado.')
    }

    const requestId = `worker:${++sequence}`
    const request = {
      ...payload,
      requestId,
      attemptId: requestId,
    } as WorkerRequest
    let operation!: Pending
    const result = new Promise<WorkerEvent>((resolve, reject) => {
      operation = {
        request,
        resolve,
        reject,
        writes: new Set(),
        unconfirmed: new Set(),
        seenResults: new Set(),
        observerFailed: false,
        completion: null,
        ...hooks,
      }
      pending.set(requestId, operation)

      try {
        connect().postMessage(request)
      } catch (error) {
        pending.delete(requestId)
        reject(error)
      }
    })

    operation.completion = result

    return { result, operation }
  }

  return {
    subscribeFailure(listener: (error: Error) => void) {
      failureListeners.add(listener)

      return () => {
        failureListeners.delete(listener)
      }
    },

    async prepare(pack: ClassifierPackage) {
      const resolved = absoluteClassifierPackage(pack)

      const event = await request({
        type: WorkerMessageType.Prepare,
        ...resolved,
      }).result

      if (
        event.type === WorkerMessageType.Preparation &&
        event.state === WorkerPreparationState.Ready
      ) {
        return
      }

      throw new Error(
        event.type === WorkerMessageType.Preparation &&
          event.state === WorkerPreparationState.Failed
          ? event.error.message
          : 'No se pudo preparar el modelo.',
      )
    },

    async process(
      sources: readonly WorkerSource[],
      modelPackageId: string,
      options: {
        limits: ProcessingLimits
        signal?: AbortSignal
        onEvent?(event: WorkerEvent): void
        onInvoice(event: InvoiceEvent): Promise<CommitOutcome>
      },
    ): Promise<TerminalEvent> {
      if (processPending) {
        throw new Error('Ya hay un procesamiento activo.')
      }

      const queued = request(
        {
          type: WorkerMessageType.Process,
          sources,
          modelPackageId,
          limits: options.limits,
        },
        { onEvent: options.onEvent, commit: options.onInvoice },
      )

      processPending = queued.operation

      const cancel = () =>
        worker?.postMessage({
          type: WorkerMessageType.Cancel,
          requestId: queued.operation.request.requestId,
          attemptId: queued.operation.request.attemptId,
        } satisfies WorkerRequest)

      options.signal?.addEventListener('abort', cancel, { once: true })

      if (options.signal?.aborted) {
        cancel()
      }

      try {
        return (await queued.result) as TerminalEvent
      } finally {
        options.signal?.removeEventListener('abort', cancel)

        if (processPending === queued.operation) {
          processPending = null
        }
      }
    },

    async recalculate(
      payload: Omit<
        Extract<WorkerRequest, { type: typeof WorkerMessageType.Recalculate }>,
        'type' | 'requestId' | 'attemptId'
      >,
    ) {
      const event = await request({
        type: WorkerMessageType.Recalculate,
        ...payload,
      }).result

      if (event.type !== WorkerMessageType.Recalculated) {
        throw new Error('No se pudo recalcular la factura.')
      }

      return event
    },

    dispose() {
      if (disposal) {
        return disposal
      }

      if (closed) {
        return Promise.resolve()
      }

      disposing = true
      failureListeners.clear()
      disposal = (async () => {
        if (processPending) {
          const current = processPending

          worker?.postMessage({
            type: WorkerMessageType.Cancel,
            requestId: current.request.requestId,
            attemptId: current.request.attemptId,
          } satisfies WorkerRequest)

          await current.completion?.catch(() => undefined)
        }

        if (pending.size) {
          for (const operation of pending.values()) {
            operation.reject(new Error('El cliente del Worker se cerró.'))
          }

          pending.clear()
          worker?.terminate()
          worker = null
        }

        if (worker) {
          try {
            await request({ type: WorkerMessageType.Dispose }).result
          } finally {
            worker?.terminate()
            worker = null
          }
        }

        closed = true
      })()

      return disposal
    },
  }
}
