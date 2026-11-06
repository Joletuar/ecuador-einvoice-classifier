// @vitest-environment jsdom
import { createPinia } from 'pinia'
import { h, shallowRef } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { updateInteractionKey } from '../src/app/updateCoordinator'
import { useOfflineStatus } from '../src/features/offline/composables/useOfflineStatus'
import {
  offlineServiceKey,
  type OfflineService,
  type OfflineView,
} from '../src/features/offline/services/offlineService'
import {
  processingServiceKey,
  type PreparationState,
} from '../src/features/upload/services/processingService'
import { invoiceServiceKey } from '../src/features/invoices/services/invoiceService'
import { createUnavailableInvoiceService } from '../src/features/invoices/services/unavailableInvoiceService'
import { useInvoiceStore } from '../src/features/invoices/stores/useInvoiceStore'
import { invoiceDataFixture } from './fixtures/invoices'
import { readyProcessing } from './fixtures/processing'

describe('offline availability presentation', () => {
  it('keeps prepared session, persistent resources and storage distinct, and retries resources plus Worker initialization', async () => {
    let publishOffline!: (view: OfflineView) => void
    let publishProcessing!: (state: PreparationState) => void
    const base: OfflineView = {
      tone: 'success',
      label: 'Recursos preparados.',
      items: [],
      cacheReady: false,
      updateAvailable: false,
      updateLabel: 'Actualizar aplicación',
      canRetry: true,
    }
    const order: string[] = []
    const offline: OfflineService = {
      current: () => base,

      subscribe(listener) {
        publishOffline = listener
        listener(base)

        return () => {}
      },

      retry: vi.fn(async () => {
        order.push('resources')
        publishOffline({ ...base, cacheReady: true })
      }),

      applyUpdate: async () => {},

      dispose() {},
    }
    const processing = {
      ...readyProcessing(() => ({ ok: true, value: { kind: 'cancelled' } })),

      subscribe(listener: (state: PreparationState) => void) {
        publishProcessing = listener
        listener({ kind: 'ready' })

        return () => {}
      },

      prepare: vi.fn(async () => {
        order.push('worker')
        publishProcessing({ kind: 'ready' })
      }),
    }
    const Host = {
      setup() {
        const status = useOfflineStatus()
        const invoices = useInvoiceStore()

        invoices.publish(invoiceDataFixture())

        return () =>
          h('div', [
            h('output', JSON.stringify(status.status.value)),
            h('button', { onClick: status.retry }, 'Reintentar'),
          ])
      },
    }
    const wrapper = mount(Host, {
      global: {
        plugins: [createPinia()],
        provide: {
          [offlineServiceKey]: offline,
          [processingServiceKey]: processing,
          [invoiceServiceKey]: createUnavailableInvoiceService(),
        },
      },
    })

    await flushPromises()

    let status = JSON.parse(wrapper.get('output').text()) as OfflineView

    expect(status.tone).toBe('warning')
    expect(
      status.items.find((item) => item.label === 'Clasificación de facturas')
        ?.tone,
    ).toBe('success')
    publishProcessing({
      kind: 'error',
      message: 'No se pudo preparar el modelo.',
    })
    publishOffline({ ...base, cacheReady: true })

    await flushPromises()

    status = JSON.parse(wrapper.get('output').text()) as OfflineView
    expect(status.tone).toBe('warning')
    expect(status.cacheReady).toBe(true)

    await wrapper.get('button').trigger('click')
    await flushPromises()

    expect(order).toEqual(['resources', 'worker'])
    expect((JSON.parse(wrapper.get('output').text()) as OfflineView).tone).toBe(
      'success',
    )
    wrapper.unmount()
  })
})

function recoveryHost(
  options: {
    storageError?: boolean
    storageLoading?: boolean
    modelError?: boolean
    modelLoading?: boolean
    resourceError?: boolean
    blocked?: boolean
    remainBlocked?: boolean
    updatePending?: boolean
    storageWait?: Promise<void>
    resourcesWait?: Promise<void>
    rejectResources?: boolean
  } = {},
) {
  const blocked = shallowRef(options.blocked ?? false)
  const order: string[] = []
  let current: OfflineView = {
    tone: options.resourceError ? 'warning' : 'success',
    label: 'Todo listo para usar la aplicación sin internet.',
    items: [
      {
        label: 'Uso sin conexión',
        detail: 'Puedes abrir la aplicación sin internet.',
        tone: 'success',
      },
    ],
    cacheReady: !options.resourceError,
    canRetry: options.resourceError,
    updateAvailable: false,
    updateLabel: 'Actualizar aplicación',
    updatePending: options.updatePending,
  }
  let notifyOffline: (view: OfflineView) => void = () => undefined
  let notifyProcessing: (state: PreparationState) => void = () => undefined
  const state: PreparationState = options.modelError
    ? { kind: 'error', message: 'No se pudo preparar el modelo.' }
    : options.modelLoading
      ? { kind: 'loading' }
      : { kind: 'ready' }
  const storage = {
    ...createUnavailableInvoiceService(),
    read: vi.fn(async () => {
      order.push('storage')
      await options.storageWait

      return { ok: true as const, value: invoiceDataFixture() }
    }),
  }
  const processing = {
    ...readyProcessing(() => ({ ok: true, value: { kind: 'cancelled' } })),
    state,
    subscribe(listener: (next: PreparationState) => void) {
      notifyProcessing = listener
      listener(state)

      return () => undefined
    },
    prepare: vi.fn(async () => {
      order.push('model')
      notifyProcessing({ kind: 'ready' })
    }),
  }
  const offline: OfflineService = {
    current: () => current,
    subscribe(listener) {
      notifyOffline = listener

      return () => undefined
    },
    retry: vi.fn(async () => {
      order.push('resources')
      await options.resourcesWait

      if (options.rejectResources) {
        throw new Error('Fallo de recursos')
      }

      blocked.value = options.remainBlocked ?? false
      current = {
        ...current,
        tone: 'success',
        cacheReady: true,
        canRetry: false,
      }
      notifyOffline(current)
    }),
    applyUpdate: async () => undefined,
    dispose: () => undefined,
  }
  let controller!: ReturnType<typeof useOfflineStatus>
  const Host = {
    setup() {
      const invoices = useInvoiceStore()

      if (options.storageLoading) {
        invoices.snapshot = { kind: 'loading' }
      } else if (options.storageError) {
        invoices.snapshot = {
          kind: 'error',
          code: 'storage-unavailable',
          message: 'No se pudieron cargar las facturas.',
        }
      } else {
        invoices.publish(invoiceDataFixture())
      }

      controller = useOfflineStatus()

      return () =>
        h('div', [
          h('output', JSON.stringify(controller.status.value)),
          h(
            'button',
            {
              disabled: controller.retrying.value || current.updatePending,
              onClick: controller.retry,
            },
            'Reintentar',
          ),
        ])
    },
  }
  const wrapper = mount(Host, {
    global: {
      plugins: [createPinia()],
      provide: {
        [offlineServiceKey]: offline,
        [processingServiceKey]: processing,
        [invoiceServiceKey]: storage,
        [updateInteractionKey]: {
          blocked,
          message: shallowRef('Verificando la pestaña…'),
        },
      },
    },
  })

  return { wrapper, controller, storage, offline, processing, order, blocked }
}

describe('single offline recovery action', () => {
  it.each([
    {
      storageError: true,
      modelError: false,
      storageCalls: 1,
      resourceCalls: 0,
      modelCalls: 0,
    },
    {
      storageError: false,
      modelError: true,
      storageCalls: 0,
      resourceCalls: 1,
      modelCalls: 1,
    },
    {
      storageError: true,
      modelError: true,
      storageCalls: 1,
      resourceCalls: 1,
      modelCalls: 1,
    },
  ])(
    'recovers applicable storage/model failures once: $storageError/$modelError',
    async (scenario) => {
      const host = recoveryHost(scenario)

      try {
        expect(host.controller.canRetry.value).toBe(true)
        await host.wrapper.get('button').trigger('click')
        await flushPromises()
        expect(host.storage.read).toHaveBeenCalledTimes(scenario.storageCalls)
        expect(host.offline.retry).toHaveBeenCalledTimes(scenario.resourceCalls)
        expect(host.processing.prepare).toHaveBeenCalledTimes(
          scenario.modelCalls,
        )
        expect(host.controller.canRetry.value).toBe(false)
        expect(host.controller.retrying.value).toBe(false)

        if (scenario.modelError) {
          expect(host.order.indexOf('resources')).toBeLessThan(
            host.order.indexOf('model'),
          )
        }
      } finally {
        host.wrapper.unmount()
      }
    },
  )

  it('keeps one busy state until both paths settle and ignores repeated clicks', async () => {
    let finishStorage!: () => void
    const storageWait = new Promise<void>((resolve) => {
      finishStorage = resolve
    })
    const host = recoveryHost({
      storageError: true,
      modelError: true,
      storageWait,
    })

    try {
      const first = host.controller.retry()

      await host.controller.retry()
      await flushPromises()
      expect(host.controller.retrying.value).toBe(true)
      expect(host.wrapper.get('button').attributes('disabled')).toBeDefined()
      expect(host.storage.read).toHaveBeenCalledOnce()
      expect(host.offline.retry).toHaveBeenCalledOnce()
      expect(host.processing.prepare).toHaveBeenCalledOnce()
      finishStorage()
      await first
      await flushPromises()
      expect(host.controller.retrying.value).toBe(false)
    } finally {
      host.wrapper.unmount()
    }
  })

  it('runs resource/version admission before the model and respects a blocked tab', async () => {
    const host = recoveryHost({
      modelError: true,
      blocked: true,
      remainBlocked: true,
    })

    try {
      await host.controller.retry()
      expect(host.offline.retry).toHaveBeenCalledOnce()
      expect(host.processing.prepare).not.toHaveBeenCalled()
      expect(host.blocked.value).toBe(true)
      expect(host.controller.canRetry.value).toBe(true)
    } finally {
      host.wrapper.unmount()
    }

    const admitted = recoveryHost({ modelError: true, blocked: true })

    try {
      await admitted.controller.retry()
      expect(admitted.order).toEqual(['resources', 'model'])
      expect(admitted.blocked.value).toBe(false)
    } finally {
      admitted.wrapper.unmount()
    }
  })

  it('blocks all retries while an application update is pending', async () => {
    const host = recoveryHost({
      storageError: true,
      modelError: true,
      updatePending: true,
    })

    try {
      await host.controller.retry()
      expect(host.storage.read).not.toHaveBeenCalled()
      expect(host.offline.retry).not.toHaveBeenCalled()
      expect(host.processing.prepare).not.toHaveBeenCalled()
      expect(host.wrapper.get('button').attributes('disabled')).toBeDefined()
    } finally {
      host.wrapper.unmount()
    }
  })

  it('finishes storage recovery when resource recovery fails and releases the busy state', async () => {
    const host = recoveryHost({
      storageError: true,
      resourceError: true,
      rejectResources: true,
    })

    try {
      await host.controller.retry()
      expect(host.storage.read).toHaveBeenCalledOnce()
      expect(host.offline.retry).toHaveBeenCalledOnce()
      expect(host.processing.prepare).not.toHaveBeenCalled()
      expect(host.controller.retrying.value).toBe(false)
      expect(host.controller.canRetry.value).toBe(true)
      expect(
        host.controller.status.value.items.some(
          (item) => item.label === 'Consultar facturas',
        ),
      ).toBe(false)
    } finally {
      host.wrapper.unmount()
    }
  })
})

describe('effective offline readiness during admission', () => {
  it('does not promise classification or model preparation before version admission', () => {
    const host = recoveryHost({ blocked: true, modelLoading: true })

    try {
      const view = host.controller.status.value

      expect(view.label).not.toContain('Todo listo')

      const classifier = view.items.find(
        (item) => item.label === 'Clasificación de facturas',
      )!

      expect(classifier.tone).toBe('warning')
      expect(classifier.detail).not.toContain('Preparando el modelo')
      expect(classifier.detail).toMatch(/pestaña|versión/)
      expect(
        view.items.find((item) => item.label === 'Uso sin conexión')?.detail,
      ).not.toContain('clasificar facturas')
    } finally {
      host.wrapper.unmount()
    }
  })

  it('does not report all capabilities ready while the classifier failed', () => {
    const host = recoveryHost({ modelError: true })

    try {
      expect(host.controller.status.value.label).not.toContain('Todo listo')
      expect(
        host.controller.status.value.items.find(
          (item) => item.label === 'Uso sin conexión',
        )?.detail,
      ).not.toContain('clasificar facturas')
    } finally {
      host.wrapper.unmount()
    }
  })
})

describe('storage readiness in the offline summary', () => {
  it('waits for a usable invoice snapshot before announcing full readiness', () => {
    const host = recoveryHost({ storageLoading: true })

    try {
      expect(host.controller.status.value.label).toBe(
        'Consultando tus facturas…',
      )
      expect(host.controller.status.value.tone).toBe('warning')
      expect(
        host.controller.status.value.items.find(
          (item) => item.label === 'Seleccionar archivos',
        )?.tone,
      ).toBe('warning')
    } finally {
      host.wrapper.unmount()
    }
  })

  it('prioritizes a storage failure over model preparation in the summary', () => {
    const host = recoveryHost({ storageError: true, modelLoading: true })

    try {
      expect(host.controller.status.value.label).toBe(
        'El almacenamiento local no está disponible.',
      )
      expect(host.controller.status.value.label).not.toContain('Preparando')
    } finally {
      host.wrapper.unmount()
    }
  })
})
