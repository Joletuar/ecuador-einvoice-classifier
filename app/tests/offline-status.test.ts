// @vitest-environment jsdom
import { createPinia } from 'pinia'
import { defineComponent, h } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'
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
    const Host = defineComponent({
      setup() {
        const status = useOfflineStatus()
        const invoices = useInvoiceStore()

        invoices.publish(invoiceDataFixture())

        return () =>
          h('div', [
            h('output', JSON.stringify(status.status.value)),
            h('button', { onClick: status.retryProcessing }, 'Reintentar'),
          ])
      },
    })
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
