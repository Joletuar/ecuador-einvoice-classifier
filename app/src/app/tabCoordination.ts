import { StorageErrorCode } from '../features/invoices/domain/storageErrors'

export const TabEventType = {
  Busy: 'busy',
  Idle: 'idle',
  Changed: 'changed',
} as const

export type TabEventType = (typeof TabEventType)[keyof typeof TabEventType]

const coordinationUnavailable = 'coordination-unavailable' as const

export interface TabCoordinationEvent {
  type:
    | typeof TabEventType.Busy
    | typeof TabEventType.Idle
    | typeof TabEventType.Changed
  external: boolean
}

export interface TabCoordinator {
  readonly supported: boolean
  isLocallyBusy(): boolean
  withWriter<T>(work: () => Promise<T>): Promise<T>
  isBusy(): Promise<boolean>
  subscribe(listener: (event: TabCoordinationEvent) => void): () => void
  notifyChanged(): void
  dispose(): void
}

export class CoordinationFailure extends Error {
  constructor(
    readonly code:
      typeof StorageErrorCode.Busy | typeof coordinationUnavailable,
    message: string,
  ) {
    super(message)
    this.name = 'CoordinationFailure'
  }
}

export function createTabCoordinator(
  options: { name?: string } = {},
): TabCoordinator {
  const name = options.name ?? 'facturas-locales:writer'
  const locks = globalThis.navigator?.locks
  const supported =
    typeof locks?.request === 'function' && typeof locks?.query === 'function'

  const listeners = new Set<(event: TabCoordinationEvent) => void>()
  let channel: BroadcastChannel | null = null

  try {
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel(name)
    }
  } catch {
    /* El guardado sigue protegido por Web Locks aunque fallen las
     * notificaciones entre pestañas. */
  }

  let writing = false
  let disposed = false

  function emit(type: TabCoordinationEvent['type'], external: boolean) {
    for (const listener of listeners) {
      try {
        listener({ type, external })
      } catch {
        /* Los errores de las funciones que reciben el aviso no deben convertir
         * una escritura confirmada en un fallo. */
      }
    }
  }

  function publish(type: TabCoordinationEvent['type']) {
    if (disposed) {
      return
    }

    emit(type, false)

    try {
      channel?.postMessage({ type })
    } catch {
      // Los avisos a otras pestañas son opcionales. Un fallo al enviarlos
      // no debe interrumpir el guardado.
    }
  }

  if (channel) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const type = (event.data as { type?: unknown } | null)?.type

      if (
        type === TabEventType.Busy ||
        type === TabEventType.Idle ||
        type === TabEventType.Changed
      ) {
        emit(type, true)
      }
    }
  }

  return {
    supported,

    isLocallyBusy: () => writing,

    async withWriter(work) {
      if (!supported || disposed) {
        throw new CoordinationFailure(
          coordinationUnavailable,
          'Este navegador no permite coordinar el guardado entre pestañas.',
        )
      }

      if (writing) {
        throw new CoordinationFailure(
          StorageErrorCode.Busy,
          'Hay otra operación de facturas en curso.',
        )
      }

      return locks.request(
        name,
        { mode: 'exclusive', ifAvailable: true },
        async (lock) => {
          if (disposed) {
            throw new CoordinationFailure(
              coordinationUnavailable,
              'La coordinación de facturas está cerrada.',
            )
          }

          if (!lock) {
            throw new CoordinationFailure(
              StorageErrorCode.Busy,
              'Otra pestaña está modificando las facturas.',
            )
          }

          writing = true
          publish(TabEventType.Busy)

          try {
            return await work()
          } finally {
            writing = false
            publish(TabEventType.Idle)
          }
        },
      )
    },

    async isBusy() {
      if (writing) {
        return true
      }

      if (!supported || disposed) {
        return false
      }

      const state = await locks.query()

      return state.held?.some((lock) => lock.name === name) ?? false
    },

    subscribe(listener) {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },

    notifyChanged() {
      if (!disposed) {
        publish(TabEventType.Changed)
      }
    },

    dispose() {
      disposed = true

      try {
        channel?.close()
      } catch {
        // El cierre debe terminar aunque el canal de avisos ya se haya
        // cerrado.
      }

      listeners.clear()
    },
  }
}
