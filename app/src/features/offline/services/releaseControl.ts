import {
  offlineProtocol,
  offlineProtocolVersion,
  type OfflineIdentity,
} from './offlineProtocol'

export const ReleaseControlKind = {
  Idle: 'idle',
  Unknown: 'unknown',
  ActivationCommitted: 'activation-committed',
} as const

export type ReleaseControlKind =
  (typeof ReleaseControlKind)[keyof typeof ReleaseControlKind]

export type ReleaseControlState =
  | { state: typeof ReleaseControlKind.Idle }
  | {
      state: typeof ReleaseControlKind.ActivationCommitted
      attemptId: string
    }
  | { state: typeof ReleaseControlKind.Unknown }

export interface ReleaseControl {
  read(): Promise<ReleaseControlState>
  commit(attemptId: string): Promise<ReleaseControlState>
}

// La autorización de actualización cambia durante el uso. Se guarda en otra
// caché para no invalidar la comprobación de los archivos estáticos.
export function releaseControlCacheName(scope: string) {
  return `einvoice-release-control-${encodeURIComponent(new URL(scope).pathname)}`
}

export function createReleaseControl(options: {
  identity: OfflineIdentity
  scope: string
  storage: CacheStorage
}): ReleaseControl & { install(): Promise<void> } {
  const name = releaseControlCacheName(options.scope)
  const releaseId = encodeURIComponent(options.identity.appReleaseId)
  const modelId = encodeURIComponent(options.identity.modelPackageId)
  const key = new URL(
    `__release-control__/${releaseId}/${modelId}`,
    options.scope,
  ).href

  function record(
    state:
      | typeof ReleaseControlKind.Idle
      | typeof ReleaseControlKind.ActivationCommitted,
    attemptId: string | null,
  ) {
    return {
      protocol: offlineProtocol,
      version: offlineProtocolVersion,
      appReleaseId: options.identity.appReleaseId,
      modelPackageId: options.identity.modelPackageId,
      state,
      attemptId,
    }
  }

  async function write(
    state:
      | typeof ReleaseControlKind.Idle
      | typeof ReleaseControlKind.ActivationCommitted,
    attemptId: string | null,
  ) {
    const cache = await options.storage.open(name)

    await cache.put(
      key,
      new Response(JSON.stringify(record(state, attemptId)), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  }

  async function read(): Promise<ReleaseControlState> {
    try {
      const cache = await options.storage.open(name)
      const response = await cache.match(key)

      if (!response?.ok) {
        return { state: ReleaseControlKind.Unknown }
      }

      const value: unknown = await response.json()

      if (!value || typeof value !== 'object') {
        return { state: ReleaseControlKind.Unknown }
      }

      const fields = value as Record<string, unknown>
      const keys = Object.keys(fields).sort()

      if (
        keys.join(',') !==
          'appReleaseId,attemptId,modelPackageId,protocol,state,version' ||
        fields.protocol !== offlineProtocol ||
        fields.version !== offlineProtocolVersion ||
        fields.appReleaseId !== options.identity.appReleaseId ||
        fields.modelPackageId !== options.identity.modelPackageId
      ) {
        return { state: ReleaseControlKind.Unknown }
      }

      if (
        fields.state === ReleaseControlKind.Idle &&
        fields.attemptId === null
      ) {
        return { state: ReleaseControlKind.Idle }
      }

      if (
        fields.state === ReleaseControlKind.ActivationCommitted &&
        typeof fields.attemptId === 'string' &&
        fields.attemptId.length > 0 &&
        fields.attemptId.length <= 200
      ) {
        return {
          state: ReleaseControlKind.ActivationCommitted,
          attemptId: fields.attemptId,
        }
      }
    } catch {
      /* Si no se puede leer la autorización guardada, no se asume que la
       * aplicación esté libre para actualizarse. */
    }

    return { state: ReleaseControlKind.Unknown }
  }

  return {
    read,

    async install() {
      await write(ReleaseControlKind.Idle, null)
    },

    async commit(attemptId) {
      if (!attemptId || attemptId.length > 200) {
        return { state: ReleaseControlKind.Unknown }
      }

      const previous = await read()

      if (previous.state !== ReleaseControlKind.Idle) {
        return previous
      }

      await write(ReleaseControlKind.ActivationCommitted, attemptId)

      return read()
    },
  }
}
