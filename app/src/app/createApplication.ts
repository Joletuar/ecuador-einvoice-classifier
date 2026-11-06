import { createApp, defineComponent, h, onMounted, watch } from 'vue'
import { createPinia, disposePinia } from 'pinia'
import type { RouterHistory } from 'vue-router'

import App from './App.vue'
import { createAppRouter } from './router'
import { installNavigationGuards } from './router/guards'
import {
  createLeaveProtection,
  leaveProtectionKey,
} from './navigation/leaveProtection'
import { storageLimitsKey, type StorageLimits } from './config/storageLimits'

import {
  invoiceServiceKey,
  type InvoiceService,
} from '../features/invoices/services/invoiceService'
import { createIndexedDbInvoiceService } from '../features/invoices/services/indexedDbInvoiceService'
import { useInvoiceStore } from '../features/invoices/stores/useInvoiceStore'
import {
  processingServiceKey,
  type ProcessingService,
} from '../features/upload/services/processingService'
import { createWorkerProcessingService } from '../features/upload/services/workerProcessingService'
import { createClassificationWorkerClient } from '../workers/workerClient'
import { classifierPackage } from 'virtual:classifier-package'

import { TabEventType } from './tabCoordination'
import { processingLimits } from './config/processingLimits'
import { createTabCoordinator } from './tabCoordination'
import {
  createUpdateCoordinator,
  updateInteractionKey,
} from './updateCoordinator'
import {
  offlineServiceKey,
  type OfflineService,
} from '../features/offline/services/offlineService'
import { createBrowserOfflineService } from '../features/offline/services/browserOfflineService'

export interface ApplicationServices {
  invoices: InvoiceService
  processing: ProcessingService
  offline: OfflineService
}

export function createApplication(options: {
  limits: StorageLimits
  history?: RouterHistory
  services?: ApplicationServices
}) {
  const worker = options.services
    ? undefined
    : createClassificationWorkerClient()
  const coordinator = options.services ? undefined : createTabCoordinator()
  const protection = createLeaveProtection()
  const updates = coordinator
    ? createUpdateCoordinator({
        writer: coordinator,
        isBlocked: protection.isUpdateBlocked,
        isDirty: protection.isDirty,
      })
    : undefined

  const browserOffline = options.services
    ? undefined
    : createBrowserOfflineService({
        coordinator: updates,
        canReload: () => !protection.isDirty() && !protection.isUpdateBlocked(),
      })
  const invoiceService =
    options.services?.invoices ??
    createIndexedDbInvoiceService(options.limits, {
      coordinator,

      recalculate: (input) => worker!.recalculate(input),
    })
  const processingService =
    options.services?.processing ??
    createWorkerProcessingService({
      client: worker!,
      invoices: invoiceService,
      pack: classifierPackage,
      limits: processingLimits,
    })

  let preparationFrame: number | undefined
  let stopped = false

  const Root = defineComponent({
    setup() {
      onMounted(() => {
        if (updates && browserOffline) {
          void updates.admit(browserOffline.verifyVersion)
        }

        watch(
          () => updates?.interaction.blocked.value ?? false,
          (blocked) => {
            if (blocked) {
              return
            }

            preparationFrame = requestAnimationFrame(() => {
              preparationFrame = requestAnimationFrame(() => {
                if (!stopped && !updates?.interaction.blocked.value) {
                  void processingService.prepare()
                }
              })
            })
          },
          { immediate: true },
        )
      })

      return () => h(App)
    },
  })

  const app = createApp(Root)
  const pinia = createPinia()

  app.provide(invoiceServiceKey, invoiceService)
  app.provide(storageLimitsKey, Object.freeze({ ...options.limits }))
  app.provide(leaveProtectionKey, protection)

  if (updates) {
    app.provide(updateInteractionKey, updates.interaction)
    protection.registerNavigationBlocker(
      () => updates.interaction.blocked.value,
    )
  }

  app.use(pinia)

  const invoices = app.runWithContext(() => useInvoiceStore(pinia))
  const offlineService = options.services?.offline ?? browserOffline!

  app.provide(processingServiceKey, processingService)
  app.provide(offlineServiceKey, offlineService)

  const router = createAppRouter(options.history)
  const stopGuards = installNavigationGuards(router, invoices, protection)

  void invoices.initialize()
  app.use(router)

  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (protection.isDirty()) {
      event.preventDefault()
      event.returnValue = ''
    }
  }

  function refreshInvoices() {
    void invoices.refresh()
  }

  let externalChanges = false
  const stopCoordination = coordinator?.subscribe((event) => {
    if (!event.external) {
      return
    }

    if (event.type === TabEventType.Changed) {
      externalChanges = true
    }

    if (event.type === TabEventType.Idle && externalChanges) {
      externalChanges = false
      refreshInvoices()
    }
  })

  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener('focus', refreshInvoices)

  app.onUnmount(() => {
    stopped = true
    stopGuards()

    if (preparationFrame !== undefined) {
      cancelAnimationFrame(preparationFrame)
    }

    stopCoordination?.()
    processingService.dispose?.()
    offlineService.dispose()
    updates?.dispose()
    void (worker?.dispose() ?? Promise.resolve()).finally(() => {
      invoiceService.dispose?.()
      coordinator?.dispose()
    })
    window.removeEventListener('beforeunload', beforeUnload)
    window.removeEventListener('focus', refreshInvoices)
    disposePinia(pinia)
  })

  return { app, router, pinia, invoices, protection, updates }
}
