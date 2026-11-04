import { inject, readonly, shallowRef, type InjectionKey, type Ref } from 'vue'
import type { UpdatePermission } from '../features/offline/services/offlineService'
import type { TabCoordinator } from './tabCoordination'

export interface UpdateInteraction {
  readonly blocked: Readonly<Ref<boolean>>
  readonly message: Readonly<Ref<string | undefined>>
}

export interface UpdateCoordinator {
  readonly interaction: UpdateInteraction
  admit(verify: () => Promise<boolean>): Promise<boolean>
  withUpdate(
    attemptId: string,
    permission: UpdatePermission,
    work: () => Promise<void>,
  ): Promise<void>
  prepare(attemptId: string): Promise<boolean>
  abort(attemptId: string): Promise<boolean>
  acquireExclusive(attemptId: string): Promise<boolean>
  activationSent(attemptId: string): void
  activationRejected(attemptId: string): void
  activated(): void
  isPrepared(): boolean
  dispose(): void
}

export const updateInteractionKey: InjectionKey<UpdateInteraction> =
  Symbol('updateInteraction')

export function useUpdateInteraction() {
  return inject(updateInteractionKey, undefined)
}

interface Lease {
  released: Promise<void>
  release(): void
}

export function createUpdateCoordinator(options: {
  writer: TabCoordinator
  isBlocked(): boolean
  isDirty(): boolean
  locks?: LockManager
  name?: string
}): UpdateCoordinator {
  const locks = options.locks ?? globalThis.navigator?.locks
  const supported =
    options.writer.supported &&
    typeof locks?.request === 'function' &&
    typeof locks?.query === 'function'
  const name = options.name ?? 'facturas-locales:update'

  const blocked = shallowRef(true)
  const message = shallowRef<string | undefined>(
    'Esperando para preparar esta pestaña…',
  )

  let disposed = false
  let shared: Lease | undefined
  let exclusive: Lease | undefined
  let verify: (() => Promise<boolean>) | undefined
  let admission: Promise<boolean> | undefined
  let prepared: string | undefined
  let preparing: Promise<boolean> | undefined
  let initiating:
    | {
        id: string
        permission: UpdatePermission
        sent: boolean
        writerHeld: boolean
      }
    | undefined

  const pending = new Set<AbortController>()

  let finishUpdate: (() => void) | undefined
  let activationObserved = false

  const activationMayHaveStarted = () => Boolean(initiating?.sent)
  const ownsAttempt = (id: string) => initiating?.id === id

  async function lease(
    mode: 'shared' | 'exclusive',
    ifAvailable: boolean,
  ): Promise<Lease | undefined> {
    if (!supported || disposed) {
      return undefined
    }

    const abort = new AbortController()

    pending.add(abort)

    let acquired!: (lease: Lease | undefined) => void
    const ready = new Promise<Lease | undefined>((resolve) => {
      acquired = resolve
    })

    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    let finished!: () => void
    const released = new Promise<void>((resolve) => {
      finished = resolve
    })

    let request: Promise<unknown>

    try {
      request = ifAvailable
        ? locks.request(name, { mode, ifAvailable: true }, hold)
        : locks.request(name, { mode, signal: abort.signal }, hold)
    } catch {
      pending.delete(abort)
      acquired(undefined)
      finished()

      return ready
    }

    void request.then(finished, finished)

    function hold(lock: Lock | null) {
      pending.delete(abort)

      if (!lock || disposed) {
        acquired(undefined)

        return Promise.resolve()
      }

      acquired({ release, released })

      return held
    }

    void request.catch(() => acquired(undefined))

    return ready
  }

  async function releaseShared() {
    const previous = shared

    shared = undefined
    previous?.release()

    await previous?.released
  }

  async function admit(check: () => Promise<boolean>) {
    verify = check

    if (disposed || prepared || exclusive || initiating) {
      return false
    }

    if (admission) {
      return admission
    }

    admission = (async () => {
      blocked.value = true
      message.value = 'Esperando para preparar esta pestaña…'

      shared ??= await lease('shared', false)

      if (!shared || disposed) {
        message.value = 'Este navegador no permite coordinar las pestañas.'

        return false
      }

      const current = await check().catch(() => false)

      if (disposed || prepared) {
        return false
      }

      blocked.value = !current
      message.value = current
        ? undefined
        : 'No se pudo verificar esta versión. Recarga la página para continuar.'

      return current
    })().finally(() => {
      admission = undefined
    })

    return admission
  }

  async function abort(attemptId: string) {
    if (
      disposed ||
      activationObserved ||
      initiating?.sent ||
      (prepared && prepared !== attemptId) ||
      (initiating && initiating.id !== attemptId)
    ) {
      return false
    }

    exclusive?.release()

    await exclusive?.released

    exclusive = undefined
    prepared = undefined
    preparing = undefined

    if (initiating?.id === attemptId) {
      initiating.permission.cancel()
      initiating = undefined
    }

    const admitted = verify ? await admit(verify) : false

    finishUpdate?.()
    finishUpdate = undefined

    return admitted
  }

  return {
    interaction: { blocked: readonly(blocked), message: readonly(message) },
    admit,

    async withUpdate(attemptId, permission, work) {
      if (
        !permission.allowed ||
        disposed ||
        blocked.value ||
        initiating ||
        prepared
      ) {
        permission.cancel()

        throw new Error(
          'Esta pestaña todavía no está disponible para actualizar.',
        )
      }

      let entered = false
      // Se bloquea la edición antes de esperar el turno de escritura. Así no
      // aparece una corrección nueva después de que el usuario haya confirmado
      // la salida.
      const reservation = {
        id: attemptId,
        permission,
        sent: false,
        writerHeld: false,
      }

      initiating = reservation
      blocked.value = true
      message.value = 'Preparando la actualización en todas las pestañas…'

      try {
        await options.writer.withWriter(async () => {
          if (disposed || !ownsAttempt(attemptId) || prepared) {
            throw new Error('Hay otra actualización en curso.')
          }

          reservation.writerHeld = true
          entered = true

          await work()

          if (initiating?.sent && !disposed) {
            await new Promise<void>((resolve) => {
              finishUpdate = resolve
            })
          }
        })
      } catch (error) {
        // Si la actualización pudo haberse activado, se conserva el turno de
        // escritura hasta confirmar el cambio de versión o cerrar esta pestaña.
        if (!activationMayHaveStarted()) {
          if (prepared === attemptId) {
            await abort(attemptId)
          } else if (ownsAttempt(attemptId) || !entered) {
            permission.cancel()
            initiating = undefined

            if (!disposed && verify) {
              await admit(verify)
            }
          }
        }

        throw error
      }
    },

    prepare(attemptId) {
      if (disposed || (prepared && prepared !== attemptId)) {
        return Promise.resolve(false)
      }

      if (prepared === attemptId) {
        return preparing ?? Promise.resolve(true)
      }

      const wasBlocked = blocked.value

      // Primero se bloquea la edición para que no cambie el trabajo pendiente
      // mientras se comprueban las pestañas.
      blocked.value = true
      message.value = 'Preparando la actualización en todas las pestañas…'

      const own = initiating?.id === attemptId && initiating.writerHeld

      if (
        !shared ||
        (wasBlocked && !own) ||
        options.isBlocked() ||
        (options.writer.isLocallyBusy() && !own) ||
        (options.isDirty() && !own)
      ) {
        blocked.value = wasBlocked

        if (!wasBlocked) {
          message.value = undefined
        }

        return Promise.resolve(false)
      }

      prepared = attemptId
      preparing = releaseShared().then(
        () => !disposed && prepared === attemptId,
      )

      return preparing
    },

    abort,

    async acquireExclusive(attemptId) {
      if (disposed || prepared !== attemptId || initiating?.id !== attemptId) {
        return false
      }

      exclusive = await lease('exclusive', true)

      return Boolean(exclusive)
    },

    activationSent(attemptId) {
      if (initiating?.id === attemptId) {
        initiating.sent = true
        message.value = 'Aplicando la actualización. La página se recargará…'
      }
    },

    activationRejected(attemptId) {
      if (initiating?.id === attemptId) {
        initiating.sent = false
      }
    },

    activated() {
      if (!prepared && !activationMayHaveStarted()) {
        return
      }

      activationObserved = true
      initiating?.permission.commit()
      initiating = undefined
      finishUpdate?.()
      finishUpdate = undefined
    },

    isPrepared: () => Boolean(prepared) || activationMayHaveStarted(),

    dispose() {
      disposed = true

      for (const abort of pending) {
        abort.abort()
      }

      pending.clear()

      if (!initiating?.sent) {
        initiating?.permission.cancel()
      }

      initiating = undefined
      finishUpdate?.()
      finishUpdate = undefined
      shared?.release()
      exclusive?.release()
      blocked.value = true
    },
  }
}
