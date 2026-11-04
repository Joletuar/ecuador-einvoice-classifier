/// <reference lib="webworker" />
import {
  OfflineMessageType,
  OfflinePreparation,
  isOfflineRequest,
  offlineProtocol,
  offlineProtocolVersion,
  sameOfflineIdentity,
  type OfflineRequest,
  type OfflineStatus,
} from './features/offline/services/offlineProtocol'
/* global ServiceWorkerGlobalScope, Client */

import { cacheNames, setCacheNameDetails } from 'workbox-core'
import {
  createHandlerBoundToURL,
  getCacheKeyForURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { appRelease, classifierAssets } from 'virtual:app-release'

import {
  inspectResources,
  repairResources,
  type PrecacheResource,
} from './features/offline/services/offlineResources'
import { createOfflineUpdateRelay } from './features/offline/services/offlineUpdateRelay'
import {
  createReleaseControl,
  releaseControlCacheName,
} from './features/offline/services/releaseControl'

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: PrecacheResource[]
}

const cachePrefix = `einvoice-${encodeURIComponent(new URL(self.registration.scope).pathname)}`

setCacheNameDetails({ prefix: cachePrefix, suffix: appRelease.appReleaseId })

const resources = self.__WB_MANIFEST

precacheAndRoute(resources)

const scope = new URL(self.registration.scope)
const releaseControl = createReleaseControl({
  identity: appRelease,
  scope: scope.href,
  storage: caches,
})

// Al reiniciarse el Service Worker se conserva la autorización anterior. Solo
// una instalación nueva puede registrar que no hay una activación pendiente.
self.addEventListener('install', (event) => {
  event.waitUntil(releaseControl.install())
})

const indexUrl = new URL('index.html', scope).href

registerRoute(
  new NavigationRoute(createHandlerBoundToURL(indexUrl), {
    denylist: [/\.[^/]+$/, /\/classifier\//, /\/assets\//],
  }),
)

function inScope(client: Client): boolean {
  const url = new URL(client.url)

  return (
    client.type === 'window' &&
    url.origin === scope.origin &&
    url.pathname.startsWith(scope.pathname)
  )
}

async function inspect() {
  const cache = await caches.open(cacheNames.precache)

  return inspectResources({
    resources,
    classifier: classifierAssets,
    origin: scope.href,

    async read(url) {
      const key = getCacheKeyForURL(url)

      return key ? cache.match(key) : undefined
    },
  })
}

let preparation: Promise<void> | null = null

async function repair() {
  if (preparation) {
    return preparation
  }

  preparation = (async () => {
    const current = await inspect()
    const cache = await caches.open(cacheNames.precache)

    await repairResources({
      resources: current.invalid,
      origin: scope.href,

      fetch: (request) => fetch(request),

      async write(url, response) {
        const key = getCacheKeyForURL(url)

        if (!key) {
          throw new Error('El recurso no pertenece a esta versión.')
        }

        await cache.put(key, response)
      },
    })
  })()

  try {
    await preparation
  } finally {
    preparation = null
  }
}

async function status(request: OfflineRequest): Promise<OfflineStatus> {
  const matchesExpected = sameOfflineIdentity(request.expected, appRelease)
  let error: string | undefined

  if (matchesExpected && request.type === OfflineMessageType.PrepareResources) {
    try {
      await repair()
    } catch {
      error = 'No se pudieron descargar todos los recursos de esta versión.'
    }
  }

  let uiComplete = false
  let classifierComplete = false

  try {
    const inspection = await inspect()

    uiComplete = inspection.uiComplete
    classifierComplete = inspection.classifierComplete
  } catch {
    error = 'No se pudo comprobar la caché de esta versión.'
  }

  return {
    protocol: offlineProtocol,
    version: offlineProtocolVersion,
    type: OfflineMessageType.Status,
    requestId: request.requestId,
    identity: appRelease,
    matchesExpected,
    preparation: error
      ? OfflinePreparation.Error
      : matchesExpected && uiComplete && classifierComplete
        ? OfflinePreparation.Ready
        : OfflinePreparation.Incomplete,
    uiComplete: matchesExpected && uiComplete,
    classifierComplete: matchesExpected && classifierComplete,
    ...(error ? { error } : {}),
  }
}

const updates = createOfflineUpdateRelay({
  identity: appRelease,
  control: releaseControl,

  async clients() {
    return (
      await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    ).filter(inScope)
  },

  async ready() {
    const inspection = await inspect()

    return inspection.uiComplete && inspection.classifierComplete
  },

  async activate() {
    await self.skipWaiting()
  },
})

self.addEventListener('message', (event) => {
  const request = event.data as unknown
  const port = event.ports[0]

  if (!port || !isOfflineRequest(request)) {
    return
  }

  const source = event.source

  if (!source || !('id' in source)) {
    return
  }

  event.waitUntil(
    (async () => {
      const client = await self.clients.get(source.id)

      if (!client || !inScope(client)) {
        return
      }

      const response =
        request.type === OfflineMessageType.GetStatus ||
        request.type === OfflineMessageType.PrepareResources
          ? await status(request)
          : request.type === OfflineMessageType.GetCandidateState
            ? await updates.candidateState(request)
            : await updates.handle(request, client.id)

      port.postMessage(response)

      if (request.type === OfflineMessageType.PrepareUpdate) {
        await updates.settled()
      }

      await updates.pendingActivation()
    })().catch(() => {}),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const inspection = await inspect()

      if (!inspection.uiComplete || !inspection.classifierComplete) {
        throw new Error('La versión offline está incompleta.')
      }

      for (const name of await caches.keys()) {
        if (name === releaseControlCacheName(scope.href)) {
          continue
        }

        if (
          name.startsWith(`${cachePrefix}-`) &&
          name !== cacheNames.precache
        ) {
          await caches.delete(name)
        }
      }

      await self.clients.claim()
    })(),
  )
})
