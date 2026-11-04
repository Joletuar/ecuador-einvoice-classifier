// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { shallowRef } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { createApplication } from '../src/app/createApplication'
import { createUnavailableInvoiceService } from '../src/features/invoices/services/unavailableInvoiceService'
import { createUnavailableProcessingService } from '../src/features/upload/services/unavailableProcessingService'
import { useInvoiceListStore } from '../src/features/invoices/stores/useInvoiceListStore'
import type { InvoiceService } from '../src/features/invoices/services/invoiceService'
import { type InvoiceData } from '../src/features/invoices/domain/storageModel'
import type { Invoice } from '../src/features/invoices/domain/invoiceModel'
import { readyProcessing } from './fixtures/processing'
import type { ProcessingService } from '../src/features/upload/services/processingService'
import type { Result } from '../src/shared/lib/result'
import { invoiceFixture, invoiceDataFixture } from './fixtures/invoices'
import { toast } from 'vue-sonner'
import {
  updateInteractionKey,
  type UpdateInteraction,
} from '../src/app/updateCoordinator'

const mounted: ReturnType<typeof createApplication>[] = []
const targets: HTMLElement[] = []
const stored = invoiceDataFixture([invoiceFixture()])
const empty = invoiceDataFixture([])

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })

  return { promise, resolve }
}

async function start(
  clearAll: InvoiceService['clearAll'],
  read: InvoiceService['read'] = () => ({ ok: true, value: stored }),
  options: {
    path?: string
    invoices?: Partial<InvoiceService>
    processing?: ProcessingService
    interaction?: UpdateInteraction
  } = {},
) {
  const runtime = createApplication({
    limits: { maxFiles: 500, maxTotalBytes: 104857600 },
    history: createMemoryHistory(),
    services: {
      invoices: {
        ...createUnavailableInvoiceService(),
        read,
        clearAll,
        ...options.invoices,
      },
      processing: options.processing ?? createUnavailableProcessingService(),
      offline: {
        current: () => ({
          tone: 'neutral',
          label: 'Interfaz local',
          items: [],
          updateAvailable: false,
          updateLabel: '',
        }),

        subscribe: () => () => {},

        applyUpdate: async () => {},

        retry: async () => {},

        dispose() {},
      },
    },
  })

  if (options.interaction) {
    runtime.app.provide(updateInteractionKey, options.interaction)
  }

  await runtime.router.push(options.path ?? '/invoices/upload')
  await runtime.router.isReady()
  await runtime.invoices.initialize()

  const target = document.createElement('div')

  document.body.append(target)
  runtime.app.mount(target)
  mounted.push(runtime)
  targets.push(target)

  await flushPromises()

  return runtime
}

function button(name: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find(
    (element) =>
      element.textContent?.trim() === name ||
      element.getAttribute('aria-label') === name,
  )

  if (!result) {
    throw new Error('Missing button: ' + name)
  }

  return result
}

async function openStorage() {
  button('Almacenamiento').click()

  await flushPromises()
}

async function requestClear() {
  await openStorage()

  button('Borrar datos almacenados').click()

  await flushPromises()
}

function confirmation() {
  return [...document.querySelectorAll('[role="dialog"]')].find((dialog) =>
    [...dialog.querySelectorAll('h2')].some(
      (title) => title.textContent?.trim() === 'Borrar datos almacenados',
    ),
  )
}

beforeEach(() => {
  let frame = 0

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0))

    return ++frame
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubGlobal('matchMedia', () => ({
    matches: true,

    addEventListener() {},

    removeEventListener() {},
  }))
})

afterEach(() => {
  toast.dismiss()

  for (const runtime of mounted.splice(0)) {
    runtime.app.unmount()
  }

  for (const target of targets.splice(0)) {
    target.remove()
  }

  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('stored-data deletion workflow', () => {
  it('blocks clearing before admission and freezes an already open confirmation without deleting', async () => {
    const blocked = shallowRef(true)
    const clearAll = vi.fn<InvoiceService['clearAll']>(() => ({
      ok: true,
      value: empty,
    }))

    await start(clearAll, undefined, {
      interaction: { blocked, message: shallowRef('Esperando…') },
    })
    await openStorage()

    expect(button('Borrar datos almacenados').disabled).toBe(true)
    blocked.value = false

    await flushPromises()

    button('Borrar datos almacenados').click()

    await flushPromises()

    expect(confirmation()).toBeDefined()
    blocked.value = true

    await flushPromises()

    button('Borrar todos los datos').click()

    await flushPromises()

    expect(clearAll).not.toHaveBeenCalled()
    expect(confirmation()).toBeDefined()
  })
  it('requires explicit confirmation and cancel preserves the collection and focus', async () => {
    const clearAll = vi.fn<InvoiceService['clearAll']>()

    const runtime = await start(clearAll)

    await requestClear()

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      '1 factura de 1 archivo almacenado',
    )
    expect(clearAll).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('Cancelar'))
    button('Cancelar').click()

    await flushPromises()

    expect(clearAll).not.toHaveBeenCalled()
    expect(runtime.invoices.snapshot).toMatchObject({
      kind: 'ready',
      ...stored,
    })
    expect(document.activeElement).toBe(button('Almacenamiento'))
    expect(
      document.querySelectorAll('header button[aria-haspopup="dialog"]'),
    ).toHaveLength(2)
  })

  it('clears from invoices without self-blocking, locks navigation until commit, and then redirects', async () => {
    const pending = deferred<Result<InvoiceData>>()
    const clearAll = vi.fn(() => pending.promise)

    const runtime = await start(clearAll, undefined, { path: '/invoices' })

    const preferences = useInvoiceListStore(runtime.pinia)

    preferences.setFilter('category', 'Salud')
    preferences.toggleExpanded('invoice-1')

    await requestClear()

    button('Borrar todos los datos').click()

    await flushPromises()

    expect(clearAll).toHaveBeenCalledOnce()
    expect(button('Borrando datos…').disabled).toBe(true)
    expect(button('Cancelar').disabled).toBe(true)
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1)
    expect(runtime.invoices.snapshot).toMatchObject({
      kind: 'ready',
      ...stored,
    })

    await runtime.router.push('/invoices/upload')

    expect(runtime.router.currentRoute.value.name).toBe('invoices')
    document
      .querySelector('[role="dialog"]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )

    await flushPromises()

    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    pending.resolve({ ok: true, value: empty })

    await flushPromises()

    expect(runtime.invoices.snapshot).toMatchObject({
      kind: 'ready',
      ...empty,
    })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(runtime.router.currentRoute.value.name).toBe('upload')
    expect(document.activeElement).toBe(button('Almacenamiento'))
    expect(button('Mis facturas').disabled).toBe(true)

    await openStorage()

    expect(button('Borrar datos almacenados').disabled).toBe(true)

    await runtime.router.push('/invoices')
    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe('upload')
    runtime.router.back()

    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe('upload')
    expect(preferences.filters).toEqual({ year: '', query: '', category: '' })
    expect(preferences.expanded).toEqual([])
  })

  it('cancels from invoices without replacing the active page or changing stored data', async () => {
    const clearAll = vi.fn<InvoiceService['clearAll']>()

    const runtime = await start(clearAll, undefined, { path: '/invoices' })

    await requestClear()

    expect((await runtime.protection.prepareLeave()).allowed).toBe(false)
    button('Cancelar').click()

    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe('invoices')
    expect(runtime.invoices.snapshot).toMatchObject({
      kind: 'ready',
      ...stored,
    })
    expect(clearAll).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(button('Almacenamiento'))
    expect((await runtime.protection.prepareLeave()).allowed).toBe(true)
  })

  it('keeps clear unavailable while the existing page policy is dirty or blocked', async () => {
    const clearAll = vi.fn<InvoiceService['clearAll']>()

    const runtime = await start(clearAll)

    const clean = {
      isBlocked: () => false,

      isDirty: () => false,

      confirmDiscard: async () => true,

      commitLeave() {},
    }

    runtime.protection.register({ ...clean, isDirty: () => true })

    await openStorage()

    expect(button('Borrar datos almacenados').disabled).toBe(true)
    runtime.protection.register({ ...clean, isBlocked: () => true })

    await flushPromises()

    expect(button('Borrar datos almacenados').disabled).toBe(true)
    runtime.protection.register(clean)

    await flushPromises()

    expect(button('Borrar datos almacenados').disabled).toBe(false)
    button('Borrar datos almacenados').click()

    await flushPromises()

    expect(button('Borrar todos los datos').disabled).toBe(false)
    expect(clearAll).not.toHaveBeenCalled()
  })

  it('preserves pending upload files while resetting only previously confirmed processing after a global clear', async () => {
    const records: Invoice[] = [invoiceFixture()]

    const runtime = await start(() => ({ ok: true, value: empty }), undefined, {
      processing: readyProcessing((inputs, options) => {
        const files = inputs.map((input) => ({
          id: input.id,
          name: input.file.name,
          status: 'added' as const,
          message: '',
          invoices: [
            invoiceFixture({
              id: input.id,
              importId: input.id,
              sourceName: input.file.name,
            }),
          ],
        }))

        records.push(...files.flatMap((file) => file.invoices))
        options.onData?.(invoiceDataFixture(records))
        files.forEach(options.onFileResult)

        return {
          ok: true,
          value: {
            kind: 'completed',
            files,
            summary: {
              added: files.length,
              duplicates: 0,
              failed: 0,
              saved: files.length,
            },
          },
        }
      }),
    })

    const select = async (name: string) => {
      const input =
        document.querySelector<HTMLInputElement>('input[type="file"]')

      if (!input) {
        throw new Error('Missing file picker')
      }

      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['xml'], name)],
      })
      input.dispatchEvent(new Event('change', { bubbles: true }))

      await flushPromises()
    }

    await select('processed.xml')

    button('Procesar archivos').click()

    await flushPromises()

    expect(runtime.invoices.snapshot).toMatchObject({
      kind: 'ready',
      usage: { files: 2 },
    })
    expect(
      document.querySelector('[aria-label="Resumen confirmado de archivos"] dd')
        ?.textContent,
    ).toBe('1')

    await select('pending.xml')
    await requestClear()

    button('Borrar todos los datos').click()

    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe('upload')
    expect(
      document.querySelector('[aria-label="Actividad de archivos"]'),
    ).toBeNull()
    expect(
      document.querySelector('[aria-label="Resumen confirmado de archivos"] dd')
        ?.textContent,
    ).toBe('0')
    expect(document.querySelector('main')?.textContent).toContain(
      'Archivos seleccionados (1)',
    )
    expect(document.querySelector('main')?.textContent).toContain('pending.xml')
    expect(document.querySelector('main')?.textContent).not.toContain(
      'processed.xml',
    )
    expect(button('Procesar archivos').disabled).toBe(false)
  })

  it.each(['returned', 'thrown'])(
    'preserves existing data and permits retry after a %s failure',
    async (failure) => {
      const clearAll = vi.fn<InvoiceService['clearAll']>()

      if (failure === 'returned') {
        clearAll.mockReturnValueOnce({
          ok: false,
          message: 'No se pudieron borrar los datos.',
        })
      } else {
        clearAll.mockRejectedValueOnce(new Error('Database failed'))
      }

      clearAll.mockReturnValueOnce({ ok: true, value: empty })

      const runtime = await start(clearAll, undefined, { path: '/invoices' })

      await requestClear()

      button('Borrar todos los datos').click()

      await flushPromises()

      expect(runtime.invoices.snapshot).toMatchObject({
        kind: 'ready',
        ...stored,
      })
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'No se pudieron borrar los datos',
      )
      expect(runtime.router.currentRoute.value.name).toBe('invoices')
      expect(confirmation()).toBeDefined()
      expect(document.activeElement?.closest('[role="dialog"]')).toBe(
        confirmation(),
      )
      expect(button('Borrar todos los datos').disabled).toBe(false)
      button('Borrar todos los datos').click()

      await flushPromises()

      expect(clearAll).toHaveBeenCalledTimes(2)
      expect(runtime.invoices.snapshot).toMatchObject({
        kind: 'ready',
        ...empty,
      })
    },
  )

  it.each(['empty', 'unavailable'])(
    'does not allow clearing an %s collection',
    async (state) => {
      const clearAll = vi.fn<InvoiceService['clearAll']>()

      await start(clearAll, () =>
        state === 'empty'
          ? { ok: true, value: empty }
          : {
              ok: false,
              code: 'storage-unavailable',
              message: 'Almacenamiento no disponible.',
            },
      )
      await openStorage()

      expect(button('Borrar datos almacenados').disabled).toBe(true)
      button('Borrar datos almacenados').click()

      await flushPromises()

      expect(confirmation()).toBeUndefined()
      expect(clearAll).not.toHaveBeenCalled()
    },
  )

  it('ignores a stale focus refresh that resolves after the collection was cleared', async () => {
    const pendingRead = deferred<Result<InvoiceData>>()
    const read = vi
      .fn<InvoiceService['read']>()
      .mockReturnValueOnce({ ok: true, value: stored })
      .mockReturnValue(pendingRead.promise)

    const runtime = await start(() => ({ ok: true, value: empty }), read)

    const refreshing = runtime.invoices.refresh()

    await requestClear()

    button('Borrar todos los datos').click()

    await flushPromises()

    pendingRead.resolve({ ok: true, value: stored })

    await refreshing

    expect(runtime.invoices.snapshot).toMatchObject({
      kind: 'ready',
      ...empty,
    })
  })
})
