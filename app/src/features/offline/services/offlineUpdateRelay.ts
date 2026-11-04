import {
  OfflineMessageType,
  OfflinePhase,
  isOfflineEnvelope,
  isOfflineIdentity,
  offlineProtocol,
  offlineProtocolVersion,
  sameOfflineIdentity,
  type ClientUpdateRequest,
  type CandidateStateRequest,
  type CandidateState,
  type CandidatePhase,
  type OfflineIdentity,
  type UpdatePhase,
  type UpdateRequest,
  type UpdateResponse,
} from './offlineProtocol'
import { ReleaseControlKind } from './releaseControl'

import type { ReleaseControl } from './releaseControl'

export interface UpdateClient {
  id: string
  postMessage(message: ClientUpdateRequest, transfer: MessagePort[]): void
}

interface UpdateAttempt {
  id: string
  initiator: string
  clients: UpdateClient[]
  phase: Exclude<UpdatePhase, typeof OfflinePhase.Unknown>
  expiration?: ReturnType<typeof setTimeout>
  settled: Promise<void>
  settle(): void
}

export function createOfflineUpdateRelay(options: {
  identity: OfflineIdentity
  clients(): Promise<UpdateClient[]>
  ready(): Promise<boolean>
  activate(): Promise<void>
  control: ReleaseControl
  timeoutMs?: number
  preparedTimeoutMs?: number
}) {
  let attempt: UpdateAttempt | null = null
  let activation: Promise<void> | undefined
  let committing = false
  let commitFailed = false

  function activateCommitted() {
    activation ??= Promise.resolve().then(() => options.activate())
    // El evento espera esta promesa después de responder para que el navegador
    // mantenga activo el Service Worker hasta cerrar la actualización.
    void activation.catch(() => undefined)

    return activation
  }

  async function candidate(): Promise<{
    phase: CandidatePhase
    attemptId?: string
  }> {
    const control = await options.control
      .read()
      .catch(() => ({ state: ReleaseControlKind.Unknown }))
    // Mientras se lee el almacenamiento puede empezar otra activación. Por eso
    // se consulta el estado en memoria después de esa lectura.
    const current = attempt

    if (control.state === ReleaseControlKind.ActivationCommitted) {
      if (!committing && !commitFailed) {
        void activateCommitted()
      }

      return { phase: OfflinePhase.Activating, attemptId: control.attemptId }
    }

    if (current?.phase === OfflinePhase.Activating) {
      return { phase: OfflinePhase.Activating, attemptId: current.id }
    }

    if (control.state !== ReleaseControlKind.Idle) {
      return { phase: OfflinePhase.Unknown }
    }

    if (current && current.phase !== OfflinePhase.Aborted) {
      return { phase: current.phase, attemptId: current.id }
    }

    return { phase: OfflinePhase.Idle }
  }

  function relay(
    client: UpdateClient,
    current: UpdateAttempt,
    type: ClientUpdateRequest['type'],
  ): Promise<boolean> {
    const channel = new MessageChannel()
    const request: ClientUpdateRequest = {
      protocol: offlineProtocol,
      version: offlineProtocolVersion,
      type,
      requestId: crypto.randomUUID(),
      attemptId: current.id,
      candidate: options.identity,
      initiatorClientId: current.initiator,
    }

    return new Promise((resolve) => {
      const finish = (accepted: boolean) => {
        clearTimeout(timer)
        channel.port1.close()
        channel.port2.close()
        resolve(accepted)
      }
      const timer = setTimeout(() => finish(false), options.timeoutMs ?? 5000)

      channel.port1.onmessage = ({ data }: MessageEvent<unknown>) => {
        if (!isOfflineEnvelope(data)) {
          return finish(false)
        }

        const response = data as unknown as Record<string, unknown>

        finish(
          response.requestId === request.requestId &&
            response.attemptId === current.id &&
            response.type ===
              (type === OfflineMessageType.PrepareClientUpdate
                ? OfflineMessageType.ClientUpdateReady
                : OfflineMessageType.ClientUpdateAborted) &&
            isOfflineIdentity(response.candidate) &&
            sameOfflineIdentity(response.candidate, options.identity) &&
            response.accepted === true,
        )
      }
      channel.port1.onmessageerror = () => finish(false)

      try {
        client.postMessage(request, [channel.port2])
      } catch {
        finish(false)
      }
    })
  }

  async function abort(
    current: UpdateAttempt,
    failedPrecommit = false,
  ): Promise<boolean> {
    if (
      activation ||
      committing ||
      (current.phase === OfflinePhase.Activating && !failedPrecommit)
    ) {
      return false
    }

    const control = await options.control
      .read()
      .catch(() => ({ state: ReleaseControlKind.Unknown }))

    if (
      control.state !== ReleaseControlKind.Idle ||
      activation ||
      committing ||
      (current.phase === OfflinePhase.Activating && !failedPrecommit)
    ) {
      return false
    }

    clearTimeout(current.expiration)
    current.phase = OfflinePhase.Aborted

    await Promise.all(
      current.clients.map((client) =>
        relay(client, current, OfflineMessageType.AbortClientUpdate),
      ),
    )

    current.settle()

    return true
  }

  function reply(
    request: UpdateRequest,
    type: UpdateResponse['type'],
    accepted: boolean,
    error?: string,
  ): UpdateResponse {
    const current = attempt?.id === request.attemptId ? attempt : null

    return {
      protocol: offlineProtocol,
      version: offlineProtocolVersion,
      requestId: request.requestId,
      type,
      identity: options.identity,
      attemptId: request.attemptId,
      accepted,
      phase: current?.phase ?? OfflinePhase.Unknown,
      clientIds: current?.clients.map((client) => client.id) ?? [],
      ...(error ? { error } : {}),
    }
  }

  return {
    async candidateState(
      request: CandidateStateRequest,
    ): Promise<CandidateState> {
      const observed = await candidate()

      return {
        protocol: offlineProtocol,
        version: offlineProtocolVersion,
        type: OfflineMessageType.CandidateState,
        requestId: request.requestId,
        identity: options.identity,
        ...observed,
      }
    },

    pendingActivation: () => activation ?? Promise.resolve(),

    settled(): Promise<void> {
      return attempt?.settled ?? Promise.resolve()
    },

    async handle(
      request: UpdateRequest,
      sourceClientId: string,
    ): Promise<UpdateResponse> {
      const type = {
        [OfflineMessageType.PrepareUpdate]: OfflineMessageType.UpdatePrepared,
        [OfflineMessageType.AbortUpdate]: OfflineMessageType.UpdateAborted,
        [OfflineMessageType.ActivateUpdate]:
          OfflineMessageType.UpdateActivating,
        [OfflineMessageType.GetUpdateStatus]: OfflineMessageType.UpdateStatus,
      }[request.type] as UpdateResponse['type']

      if (!sameOfflineIdentity(request.expected, options.identity)) {
        return reply(request, type, false, 'La versión candidata no coincide.')
      }

      if (request.type === OfflineMessageType.PrepareUpdate) {
        const initial = await candidate()

        if (initial.phase !== OfflinePhase.Idle) {
          return {
            ...reply(request, type, false, 'La activación no está disponible.'),
            phase: initial.phase,
          }
        }

        if (attempt && attempt.phase !== OfflinePhase.Aborted) {
          return reply(
            request,
            type,
            false,
            'Hay otra actualización pendiente.',
          )
        }

        let settle!: () => void
        const settled = new Promise<void>((resolve) => {
          settle = resolve
        })
        const current: UpdateAttempt = {
          id: request.attemptId,
          initiator: sourceClientId,
          clients: [],
          phase: OfflinePhase.Preparing,
          settled,
          settle,
        }

        attempt = current

        try {
          if (!(await options.ready())) {
            throw new Error(
              'La versión candidata no está completa sin conexión.',
            )
          }

          if (current.phase !== OfflinePhase.Preparing) {
            throw new Error('El intento fue cancelado.')
          }

          current.clients = await options.clients()

          if (current.phase !== OfflinePhase.Preparing) {
            throw new Error('El intento fue cancelado.')
          }

          if (!current.clients.some((client) => client.id === sourceClientId)) {
            throw new Error('No se pudo identificar la pestaña que actualiza.')
          }

          const answers = await Promise.all(
            current.clients.map((client) =>
              relay(client, current, OfflineMessageType.PrepareClientUpdate),
            ),
          )

          if (
            current.phase !== OfflinePhase.Preparing ||
            answers.some((ready) => !ready)
          ) {
            throw new Error('Alguna pestaña tiene trabajo o no respondió.')
          }

          current.phase = OfflinePhase.Prepared
          current.expiration = setTimeout(() => {
            void abort(current)
          }, options.preparedTimeoutMs ?? 30_000)

          return reply(request, type, true)
        } catch (error) {
          await abort(current)

          current.settle()

          return reply(request, type, false, String(error))
        }
      }

      const current = attempt

      if (request.type === OfflineMessageType.GetUpdateStatus && !current) {
        const observed = await candidate()

        return {
          ...reply(
            request,
            type,
            observed.phase === OfflinePhase.Idle ||
              observed.attemptId === request.attemptId,
          ),
          phase:
            observed.phase === OfflinePhase.Idle
              ? OfflinePhase.Aborted
              : observed.phase,
        }
      }

      if (
        !current ||
        current.id !== request.attemptId ||
        (current.initiator !== sourceClientId &&
          !(
            request.type === OfflineMessageType.GetUpdateStatus &&
            current.clients.some((client) => client.id === sourceClientId)
          ))
      ) {
        return reply(
          request,
          type,
          false,
          'El intento de actualización no coincide.',
        )
      }

      if (request.type === OfflineMessageType.GetUpdateStatus) {
        const observed = await candidate()

        if (
          observed.phase === OfflinePhase.Activating ||
          observed.phase === OfflinePhase.Unknown
        ) {
          return { ...reply(request, type, true), phase: observed.phase }
        }

        if (
          current.phase === OfflinePhase.Prepared &&
          !(await options.clients()).some(
            (client) => client.id === current.initiator,
          )
        ) {
          await abort(current)
        }

        return reply(request, type, true)
      }

      if (request.type === OfflineMessageType.AbortUpdate) {
        if (current.phase === OfflinePhase.Activating) {
          return reply(request, type, false, 'La activación ya está en curso.')
        }

        const stopped = await abort(current)

        return reply(request, type, stopped)
      }

      if (current.phase !== OfflinePhase.Prepared) {
        return reply(
          request,
          type,
          false,
          'Las pestañas aún no están preparadas.',
        )
      }

      // Cuando la activación pudo empezar, el vencimiento del plazo no basta
      // para permitir nuevas escrituras. La pestaña debe comprobar primero qué
      // versión quedó activa.
      current.phase = OfflinePhase.Activating
      clearTimeout(current.expiration)

      try {
        if (!(await options.ready())) {
          throw new Error('La versión candidata perdió recursos de la caché.')
        }

        const clients = await options.clients()

        const original = new Set(current.clients.map((client) => client.id))

        if (
          clients.length !== original.size ||
          clients.some((client) => !original.has(client.id))
        ) {
          throw new Error('Cambió el conjunto de pestañas abiertas.')
        }
      } catch (error) {
        await abort(current, true)

        current.settle()

        return reply(request, type, false, String(error))
      }

      try {
        committing = true

        const committed = await options.control.commit(current.id)

        if (
          committed.state !== ReleaseControlKind.ActivationCommitted ||
          committed.attemptId !== current.id
        ) {
          throw new Error('No se pudo confirmar la intención de activación.')
        }
      } catch (error) {
        committing = false
        commitFailed = true

        await abort(current, true)

        current.settle()

        return reply(request, type, false, String(error))
      }

      committing = false

      try {
        await activateCommitted()
      } finally {
        current.settle()
      }

      return reply(request, type, true)
    },
  }
}
