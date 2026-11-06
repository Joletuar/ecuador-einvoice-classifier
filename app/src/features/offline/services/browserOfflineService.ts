import {
  OfflineMessageType,
  OfflinePhase,
  OfflinePreparation,
  isOfflineEnvelope,
  isOfflineIdentity,
  sameOfflineIdentity,
  offlineProtocol,
  offlineProtocolVersion,
  type ClientUpdateRequest,
  type ClientUpdateResponse,
  type OfflineIdentity,
  type OfflineStatus,
  type UpdateRequest,
} from './offlineProtocol'
import { appRelease } from 'virtual:app-release'

import { FeedbackTone } from '../../../shared/ui/feedbackTone'
import type { UpdateCoordinator } from '../../../app/updateCoordinator'
import type { OfflineService, OfflineView } from './offlineService'

import { createOfflineTransport } from './offlineTransport'

export interface BrowserOfflineOptions {
  production?: boolean
  serviceWorker?: ServiceWorkerContainer | null
  baseUrl?: string
  confirm?: (message: string) => boolean
  reload?: () => void
  canReload?: () => boolean
  expected?: OfflineIdentity
  coordinator?: UpdateCoordinator
  timeoutMs?: number
}

export function createBrowserOfflineService(
  options: BrowserOfflineOptions = {},
): OfflineService & {
  verifyVersion(): Promise<boolean>
} {
  const production = options.production ?? import.meta.env.PROD
  const expected = options.expected ?? appRelease
  const reload = options.reload ?? (() => window.location.reload())
  const confirm =
    options.confirm ?? ((message: string) => window.confirm(message))
  const workerContainer =
    options.serviceWorker !== undefined
      ? options.serviceWorker
      : globalThis.navigator?.serviceWorker
  const coordinator = options.coordinator

  const transport = createOfflineTransport(options.timeoutMs ?? 30000)
  const listeners = new Set<(view: OfflineView) => void>()
  const cleanups: (() => void)[] = []

  let registration: Promise<ServiceWorkerRegistration> | undefined
  let registrationAttempt = 0
  let disposed = false
  let started = false
  let statusSequence = 0
  let requestSequence = 0

  let waiting: ServiceWorker | null = null
  let preparedCandidate: OfflineIdentity | undefined
  let preparedAttempt: string | undefined
  let updating = false
  let reloading = false
  let retryRecovery = false
  const recoveryKey = `einvoice:controller-recovery:${JSON.stringify([
    options.baseUrl ?? import.meta.env.BASE_URL,
    expected.appReleaseId,
    expected.modelPackageId,
  ])}`

  let view: OfflineView = {
    tone: FeedbackTone.Neutral,
    label: 'Preparando la aplicación sin conexión…',
    items: [],
    updateAvailable: false,
    updateLabel: 'Actualizar aplicación',
    cacheReady: false,
    preparing: true,
    canRetry: false,
  }

  function publish(next: Partial<OfflineView>) {
    if (disposed) {
      return
    }

    view = { ...view, ...next }

    for (const listener of listeners) {
      listener(view)
    }
  }

  function envelope() {
    return {
      protocol: offlineProtocol,
      version: offlineProtocolVersion,
      requestId: `tab-${++requestSequence}-${crypto.randomUUID()}`,
    }
  }

  function setWaiting(worker: ServiceWorker | null) {
    waiting = worker
    publish({ updateAvailable: Boolean(worker), updatePending: updating })
  }

  function observe(worker: ServiceWorker, attempt: number) {
    const change = () => {
      if (disposed || attempt !== registrationAttempt) {
        return
      }

      if (worker.state === 'installed' && workerContainer?.controller) {
        setWaiting(worker)
      }

      if (worker.state === 'activated' || worker.state === 'redundant') {
        void refresh()
      }
    }

    worker.addEventListener('statechange', change)
    cleanups.push(() => worker.removeEventListener('statechange', change))
  }

  function requestRegistration(current: ServiceWorkerContainer) {
    const attempt = ++registrationAttempt
    const pending = current
      .register(`${options.baseUrl ?? import.meta.env.BASE_URL}sw.js`)
      .then((value) => {
        if (disposed || attempt !== registrationAttempt) {
          return value
        }

        setWaiting(value.waiting)

        if (value.installing) {
          observe(value.installing, attempt)
        }

        const updateFound = () => {
          if (disposed || attempt !== registrationAttempt) {
            return
          }

          if (value.installing) {
            observe(value.installing, attempt)
          }
        }

        value.addEventListener('updatefound', updateFound)
        cleanups.push(() =>
          value.removeEventListener('updatefound', updateFound),
        )

        return value
      })
      .catch((error: unknown) => {
        if (registration === pending) {
          registration = undefined
        }

        throw error
      })

    registration = pending

    return pending
  }

  async function register(
    retryFailedInstall = false,
  ): Promise<ServiceWorkerRegistration> {
    if (!production || !workerContainer) {
      throw new Error('offline-unavailable')
    }

    const pending = registration ?? requestRegistration(workerContainer)

    const value = await pending

    if (!retryFailedInstall || disposed) {
      return value
    }

    // El registro puede resolverse aunque la instalación falle después. Solo un
    // reintento explícito debe sustituir ese registro fallido.
    if (registration !== pending) {
      return register()
    }

    if (
      !workerContainer.controller &&
      !value.active &&
      !value.waiting &&
      (!value.installing || value.installing.state === 'redundant')
    ) {
      registration = undefined

      return register()
    }

    return value
  }

  async function resourceStatus(
    worker: ServiceWorker,
    identity: OfflineIdentity,
    repair = false,
  ) {
    const response = await transport.request(worker, {
      ...envelope(),
      type: repair
        ? OfflineMessageType.PrepareResources
        : OfflineMessageType.GetStatus,
      expected: identity,
    })

    if (response.type !== OfflineMessageType.Status) {
      throw new Error('Unexpected offline response.')
    }

    return response
  }

  function ready(status: OfflineStatus, identity = expected) {
    return (
      sameOfflineIdentity(status.identity, identity) &&
      status.matchesExpected &&
      status.preparation === OfflinePreparation.Ready &&
      status.uiComplete &&
      status.classifierComplete
    )
  }

  async function refresh(repair = false) {
    const sequence = ++statusSequence

    publish({
      cacheReady: false,
      preparing: true,
      canRetry: false,
      tone: FeedbackTone.Neutral,
      label: 'Comprobando el uso sin conexión…',
    })

    try {
      const value = await register(repair)

      const worker = workerContainer?.controller ?? value.active

      if (!worker) {
        if (sequence === statusSequence) {
          publish({
            tone: FeedbackTone.Warning,
            preparing: false,
            canRetry: true,
            label:
              'La aplicación todavía se está preparando para abrirse sin conexión.',
          })
        }

        return
      }

      const status = await resourceStatus(worker, expected, repair)

      if (sequence !== statusSequence || disposed) {
        return
      }

      const complete = ready(status)

      publish({
        cacheReady: complete,
        preparing: false,
        canRetry: !complete,
        tone: complete ? FeedbackTone.Success : FeedbackTone.Warning,
        label: complete
          ? 'Todo listo para usar la aplicación sin internet.'
          : 'Todavía no puedes abrir y clasificar facturas sin internet.',
        items: [
          {
            label: 'Uso sin conexión',
            tone: complete ? FeedbackTone.Success : FeedbackTone.Warning,
            detail: complete
              ? 'Puedes abrir la aplicación sin internet.'
              : 'Conéctate a internet y vuelve a intentarlo.',
          },
        ],
      })
    } catch {
      if (sequence === statusSequence) {
        publish({
          cacheReady: false,
          preparing: false,
          canRetry: production && Boolean(workerContainer),
          tone: FeedbackTone.Warning,
          label: production
            ? 'No pudimos comprobar si la aplicación está lista para usarse sin internet.'
            : 'Abre la aplicación instalada para comprobar el uso sin conexión.',
          items: [],
        })
      }
    }
  }

  function recoverUncontrolled(stillCurrent: () => boolean) {
    if (
      disposed ||
      reloading ||
      updating ||
      coordinator?.isPrepared() ||
      !options.canReload?.() ||
      !stillCurrent()
    ) {
      return
    }

    try {
      const storage = window.sessionStorage

      if (retryRecovery) {
        retryRecovery = false
        storage.removeItem(recoveryKey)
      }

      if (storage.getItem(recoveryKey) !== null) {
        return
      }

      storage.setItem(recoveryKey, '1')

      if (
        storage.getItem(recoveryKey) !== '1' ||
        !stillCurrent() ||
        !options.canReload()
      ) {
        return
      }

      reload()
    } catch {
      // Sin confirmar el límite persistido no es seguro recargar automáticamente.
    }
  }

  async function verifyVersion() {
    if (!production) {
      return true
    }

    try {
      const value = await register()

      for (let retry = 0; retry < 3 && !disposed; retry++) {
        const controller = workerContainer?.controller
        const active = value.active
        const waiting = value.waiting
        const installing = value.installing

        if (!active) {
          return false
        }

        const workers = [
          ...new Set([
            active,
            ...(controller ? [controller] : []),
            ...(waiting ? [waiting] : []),
          ]),
        ]
        const states = workers.map((worker) => worker.state)

        const statuses = await Promise.all(
          [active, ...(controller ? [controller] : [])].map((worker) =>
            resourceStatus(worker, expected),
          ),
        )

        let idle = !waiting
        let activeBridgeReady = false

        if (waiting) {
          const candidate = await resourceStatus(waiting, expected)
          const reportedActive = statuses[0]!

          if (
            !controller &&
            ready(candidate) &&
            !reportedActive.matchesExpected &&
            !sameOfflineIdentity(reportedActive.identity, expected)
          ) {
            // Una recarga normal debe servir la versión completa del Worker activo,
            // sin admitir el documento nuevo bajo una versión anterior.
            const ownStatus = await resourceStatus(
              active,
              reportedActive.identity,
            )

            activeBridgeReady = ready(ownStatus, reportedActive.identity)
          }

          const control = await candidateState(waiting, candidate.identity)

          idle = control.phase === OfflinePhase.Idle
        }

        if (disposed) {
          return false
        }

        const stillCurrent = () =>
          !disposed &&
          workerContainer?.controller === controller &&
          value.active === active &&
          value.waiting === waiting &&
          value.installing === installing &&
          workers.every((worker, index) => worker.state === states[index])

        if (!stillCurrent()) {
          continue
        }

        if (!controller) {
          if (
            active.state === 'activated' &&
            !installing &&
            (!waiting || waiting.state === 'installed') &&
            idle &&
            (statuses.every((status) => ready(status)) || activeBridgeReady)
          ) {
            recoverUncontrolled(stillCurrent)
          }

          return false
        }

        if (
          statuses.some(
            (status) =>
              !sameOfflineIdentity(status.identity, expected) ||
              !status.matchesExpected,
          )
        ) {
          reload()

          return false
        }

        const verified =
          active.state === 'activated' &&
          controller.state === 'activated' &&
          (!waiting || waiting.state === 'installed') &&
          idle

        if (verified) {
          try {
            window.sessionStorage.removeItem(recoveryKey)
          } catch {
            // Una pestaña ya verificada no depende del marcador de recuperación.
          }
        }

        return verified
      }

      return false
    } catch {
      return false
    }
  }

  async function candidateState(
    worker: ServiceWorker,
    identity: OfflineIdentity,
  ) {
    const response = await transport.request(worker, {
      ...envelope(),
      type: OfflineMessageType.GetCandidateState,
      expected: identity,
    })

    if (
      response.type !== OfflineMessageType.CandidateState ||
      !sameOfflineIdentity(response.identity, identity)
    ) {
      throw new Error('No se pudo verificar la activación pendiente.')
    }

    return response
  }

  async function controllerChanged() {
    if (reloading || disposed) {
      return
    }

    ++statusSequence
    publish({ cacheReady: false })

    const candidate = preparedCandidate

    if (candidate && coordinator?.isPrepared()) {
      try {
        const controller = workerContainer?.controller

        if (!controller) {
          return
        }

        const status = await resourceStatus(controller, candidate)

        if (
          !disposed &&
          workerContainer?.controller === controller &&
          !reloading &&
          status.matchesExpected &&
          sameOfflineIdentity(status.identity, candidate)
        ) {
          coordinator.activated()
          reloading = true
          reload()

          return
        }
      } catch {
        // Sin confirmar qué versión quedó activa, esta pestaña debe seguir
        // bloqueada para evitar escrituras con una versión anterior.
      }

      if (waiting && preparedAttempt) {
        try {
          const response = await transport.request(waiting, {
            ...envelope(),
            type: OfflineMessageType.GetUpdateStatus,
            expected: candidate,
            attemptId: preparedAttempt,
          })

          if (
            !disposed &&
            response.type === OfflineMessageType.UpdateStatus &&
            response.accepted &&
            response.phase === OfflinePhase.Aborted &&
            sameOfflineIdentity(response.identity, candidate)
          ) {
            coordinator.activationRejected(preparedAttempt)

            await coordinator.abort(preparedAttempt)

            preparedCandidate = undefined
            preparedAttempt = undefined
          }
        } catch {
          // Si no se conoce el estado de la actualización, todavía no es
          // seguro permitir nuevas escrituras.
        }
      }
    } else {
      await coordinator?.admit(verifyVersion)
      await refresh()
    }
  }

  async function clientUpdate(event: MessageEvent<unknown>) {
    if (disposed || !coordinator || !isOfflineEnvelope(event.data)) {
      return
    }

    const request = event.data as ClientUpdateRequest

    if (
      ![
        OfflineMessageType.PrepareClientUpdate,
        OfflineMessageType.AbortClientUpdate,
      ].includes(request.type) ||
      typeof request.attemptId !== 'string' ||
      !isOfflineIdentity(request.candidate) ||
      !event.ports[0] ||
      !event.source ||
      event.source !== waiting
    ) {
      return
    }

    const accepted =
      request.type === OfflineMessageType.PrepareClientUpdate
        ? await coordinator.prepare(request.attemptId)
        : await coordinator.abort(request.attemptId)

    if (disposed) {
      return
    }

    if (accepted) {
      preparedCandidate =
        request.type === OfflineMessageType.PrepareClientUpdate
          ? request.candidate
          : undefined
      preparedAttempt =
        request.type === OfflineMessageType.PrepareClientUpdate
          ? request.attemptId
          : undefined
    }

    const response: ClientUpdateResponse = {
      protocol: offlineProtocol,
      version: offlineProtocolVersion,
      requestId: request.requestId,
      type:
        request.type === OfflineMessageType.PrepareClientUpdate
          ? OfflineMessageType.ClientUpdateReady
          : OfflineMessageType.ClientUpdateAborted,
      candidate: request.candidate,
      attemptId: request.attemptId,
      accepted,
    }

    event.ports[0].postMessage(response)
    event.ports[0].close()
  }

  if (workerContainer) {
    const changed = () => {
      void controllerChanged()
    }
    const message = (event: MessageEvent<unknown>) => {
      void clientUpdate(event)
    }

    workerContainer.addEventListener('controllerchange', changed)
    workerContainer.addEventListener('message', message)
    cleanups.push(() => {
      workerContainer.removeEventListener('controllerchange', changed)
      workerContainer.removeEventListener('message', message)
    })
  }

  const recheck = () => {
    if (coordinator?.isPrepared()) {
      void controllerChanged()
    } else {
      void refresh()

      if (coordinator?.interaction.blocked.value) {
        void coordinator.admit(verifyVersion)
      }
    }
  }
  const visible = () => {
    if (document.visibilityState === 'visible') {
      recheck()
    }
  }

  window.addEventListener('focus', recheck)
  window.addEventListener('online', recheck)
  document.addEventListener('visibilitychange', visible)
  cleanups.push(() => {
    window.removeEventListener('focus', recheck)
    window.removeEventListener('online', recheck)
    document.removeEventListener('visibilitychange', visible)
  })

  return {
    current: () => view,

    subscribe(listener) {
      listeners.add(listener)
      listener(view)

      if (!started) {
        started = true
        void refresh()
      }

      return () => {
        listeners.delete(listener)
      }
    },

    async retry() {
      retryRecovery = true

      try {
        await refresh(true)

        if (
          coordinator?.interaction.blocked.value &&
          !coordinator.isPrepared()
        ) {
          await coordinator.admit(verifyVersion)
        }
      } finally {
        retryRecovery = false
      }
    },

    verifyVersion,

    async applyUpdate(prepareLeave) {
      if (!waiting || disposed || updating || !coordinator) {
        return
      }

      if (
        !confirm(
          'La actualización recargará la página y se perderá la selección temporal de archivos. ¿Continuar?',
        )
      ) {
        return
      }

      const worker = waiting

      updating = true
      publish({ updatePending: true })

      let permission

      try {
        permission = await prepareLeave()
      } catch {
        updating = false
        publish({ updatePending: false })

        return
      }

      if (!permission.allowed || disposed || waiting !== worker) {
        if (permission.allowed) {
          permission.cancel()
        }

        updating = false
        publish({ updatePending: false })

        return
      }

      const attemptId = crypto.randomUUID()

      publish({
        updatePending: true,
        updateLabel: 'Preparando actualización…',
      })

      try {
        await coordinator.withUpdate(attemptId, permission, async () => {
          let activationPossible = false
          let candidate = expected
          const request = async (type: UpdateRequest['type']) => {
            const result = await transport.request(
              worker,
              {
                ...envelope(),
                type,
                expected: candidate,
                attemptId,
              },
              type === OfflineMessageType.ActivateUpdate
                ? () => {
                    activationPossible = true
                    coordinator.activationSent(attemptId)
                  }
                : undefined,
            )

            if (
              result.type === OfflineMessageType.Status ||
              result.type === OfflineMessageType.CandidateState ||
              !sameOfflineIdentity(result.identity, candidate)
            ) {
              throw new Error('La versión de actualización cambió.')
            }

            return result
          }

          try {
            candidate = (await resourceStatus(worker, expected)).identity

            if (!ready(await resourceStatus(worker, candidate), candidate)) {
              throw new Error('La actualización todavía no está completa.')
            }

            const prepared = await request(OfflineMessageType.PrepareUpdate)

            if (
              !prepared.accepted ||
              prepared.phase !== OfflinePhase.Prepared ||
              !(await coordinator.acquireExclusive(attemptId))
            ) {
              throw new Error(
                'Hay otra pestaña con trabajo pendiente. Reintenta cuando termine.',
              )
            }

            const activated = await request(OfflineMessageType.ActivateUpdate)

            if (
              !activated.accepted &&
              activated.phase !== OfflinePhase.Activating
            ) {
              activationPossible = false
              coordinator.activationRejected(attemptId)

              throw new Error(
                'La actualización está esperando a las demás pestañas.',
              )
            }

            publish({ updateLabel: 'Aplicando actualización…' })
          } catch (error) {
            if (activationPossible) {
              try {
                const current = await request(
                  OfflineMessageType.GetUpdateStatus,
                )

                let aborted = current.phase === OfflinePhase.Aborted

                if (current.phase === OfflinePhase.Prepared) {
                  const stopped = await request(OfflineMessageType.AbortUpdate)

                  aborted =
                    stopped.accepted && stopped.phase === OfflinePhase.Aborted
                }

                if (aborted) {
                  coordinator.activationRejected(attemptId)
                  activationPossible = false
                }
              } catch {
                /* No recibir respuesta no confirma que la actualización haya
                 * fallado. Se mantiene el bloqueo hasta comprobar qué versión
                 * quedó activa. */
              }
            }

            if (activationPossible) {
              publish({
                updateLabel: 'Esperando la actualización…',
                label:
                  'La actualización está en curso. Esta pestaña se recargará al completarla.',
              })
              void controllerChanged()

              return
            }

            let stopped = false

            try {
              const response = await request(OfflineMessageType.AbortUpdate)

              stopped =
                response.accepted && response.phase === OfflinePhase.Aborted
            } catch {
              // La falta de respuesta no confirma la cancelación. Se conserva el
              // bloqueo hasta verificar que la actualización se detuvo.
            }

            if (!stopped) {
              try {
                stopped =
                  (await candidateState(worker, candidate)).phase ===
                  OfflinePhase.Idle
              } catch {
                // Si no se puede consultar la autorización guardada, no se da por
                // cancelada la actualización ni se permiten escrituras.
              }
            }

            if (!stopped) {
              coordinator.activationSent(attemptId)
              preparedCandidate = candidate
              preparedAttempt = attemptId
              publish({
                updateLabel: 'Esperando la actualización…',
                label:
                  'No se pudo confirmar el aborto. Esta pestaña esperará a verificar la actualización.',
              })

              return
            }

            coordinator.activationRejected(attemptId)

            await coordinator.abort(attemptId)

            preparedCandidate = undefined
            preparedAttempt = undefined

            throw error
          }
        })
      } catch (error) {
        publish({
          label:
            error instanceof Error
              ? error.message
              : 'No se pudo actualizar la aplicación.',
        })
      } finally {
        updating = false
        publish({
          updatePending: coordinator.isPrepared(),
          updateLabel: 'Actualizar aplicación',
        })
      }
    },

    dispose() {
      disposed = true
      ++statusSequence
      transport.dispose()
      cleanups.forEach((cleanup) => cleanup())
      listeners.clear()
    },
  }
}
