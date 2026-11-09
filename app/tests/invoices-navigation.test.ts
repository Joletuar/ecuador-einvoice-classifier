// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { InvoiceData } from '../src/features/invoices/domain/storageModel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { nextTick, shallowRef } from 'vue'
import { createMemoryHistory } from 'vue-router'
import { createApplication } from '../src/app/createApplication'
import { RouteName } from '../src/app/router/routeNames'
import { createUnavailableInvoiceService } from '../src/features/invoices/services/unavailableInvoiceService'
import { createIndexedDbInvoiceService } from '../src/features/invoices/services/indexedDbInvoiceService'
import type { InvoiceService } from '../src/features/invoices/services/invoiceService'
import { createUnavailableProcessingService } from '../src/features/upload/services/unavailableProcessingService'
import type {
  ProcessingOutcome,
  ProcessingService,
} from '../src/features/upload/services/processingService'
import type { OfflineService } from '../src/features/offline/services/offlineService'
import type { Result } from '../src/shared/lib/result'
import { toast } from 'vue-sonner'
import { categories } from '../src/features/invoices/domain/categoryModel'
import { testCoordinator, testRecalculate } from './fixtures/storageFixtures'
import {
  invoiceFixture,
  invoiceDataFixture,
  seedInvoice,
} from './fixtures/invoices'
import {
  createUpdateCoordinator,
  updateInteractionKey,
  type UpdateInteraction,
} from '../src/app/updateCoordinator'
import { webLocks } from './fixtures/webLocks'

const mounted: {
  runtime: ReturnType<typeof createApplication>
  target: HTMLElement
}[] = []

function offlineService(): OfflineService {
  return {
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
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })

  return { promise, resolve }
}

async function startApplication(
  overrides: Partial<InvoiceService> = {},
  interaction?: UpdateInteraction,
  options: { path?: string; processing?: ProcessingService } = {},
) {
  const runtime = createApplication({
    limits: { maxFiles: 500, maxTotalBytes: 104857600 },
    history: createMemoryHistory(),
    services: {
      invoices: {
        ...createUnavailableInvoiceService(),

        read: () => ({
          ok: true,
          value: invoiceDataFixture([invoiceFixture()]),
        }),

        ...overrides,
      },
      processing: options.processing ?? createUnavailableProcessingService(),
      offline: offlineService(),
    },
  })

  if (interaction) {
    runtime.app.provide(updateInteractionKey, interaction)
  }

  await runtime.router.push(options.path ?? '/invoices')
  await runtime.router.isReady()
  await runtime.invoices.initialize()

  const target = document.createElement('div')

  document.body.append(target)
  runtime.app.mount(target)
  mounted.push({ runtime, target })

  await flushPromises()

  return runtime
}

function button(name: string): HTMLButtonElement {
  const result = [...document.querySelectorAll('button')].find(
    (element) =>
      element.getAttribute('aria-label') === name ||
      element.textContent?.trim() === name,
  )

  if (!result) {
    throw new Error(`Missing button: ${name}`)
  }

  return result
}

function navigationLink(name: string): HTMLAnchorElement {
  const result = [
    ...document.querySelectorAll<HTMLAnchorElement>(
      'nav[aria-label="Navegación principal"] a',
    ),
  ].find((element) => element.textContent?.trim() === name)

  if (!result) {
    throw new Error(`Missing navigation link: ${name}`)
  }

  return result
}

function categorySelect(): HTMLSelectElement {
  const label = [...document.querySelectorAll('label')].find(
    (element) => element.textContent?.trim() === 'Categoría de Fruta',
  )
  const result = label ? document.getElementById(label.htmlFor) : null

  if (!(result instanceof HTMLSelectElement)) {
    throw new Error('Missing category editor')
  }

  return result
}

async function beginConceptDraft() {
  button('Ver detalles de Comercio del barrio').click()

  await flushPromises()

  button('Editar categoría de Fruta').click()

  await nextTick()

  categorySelect().value = 'Salud'
  categorySelect().dispatchEvent(new Event('change', { bubbles: true }))

  await nextTick()
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  )
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
  vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,

    addListener() {},

    removeListener() {},

    addEventListener() {},

    removeEventListener() {},

    dispatchEvent: () => true,
  }))
})

afterEach(() => {
  toast.dismiss()

  for (const { runtime, target } of mounted.splice(0)) {
    runtime.app.unmount()
    target.remove()
  }

  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('invoice route lifecycle', () => {
  it('opens Information directly without invoices and removes its players when navigating away', async () => {
    const runtime = await startApplication(
      { read: () => ({ ok: true, value: invoiceDataFixture([]) }) },
      undefined,
      { path: '/information' },
    )

    expect(runtime.router.currentRoute.value.name).toBe(RouteName.Information)
    expect(button('Facturas').disabled).toBe(true)
    expect(navigationLink('Información').getAttribute('aria-current')).toBe(
      'page',
    )
    expect(document.querySelector('main h1')?.textContent).toBe(
      'Sobre Mis facturas',
    )

    const players = [...document.querySelectorAll('main iframe')]

    expect(players).toHaveLength(2)
    navigationLink('Cargar').click()

    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe(RouteName.Upload)
    expect(document.querySelector('main iframe')).toBeNull()
    expect(players.every((player) => !player.isConnected)).toBe(true)
    navigationLink('Información').click()

    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe(RouteName.Information)
    expect(document.querySelectorAll('main iframe')).toHaveLength(2)
    expect(document.querySelector('main iframe')).not.toBe(players[0])
    expect(button('Facturas').disabled).toBe(true)

    await runtime.router.push('/invoices')
    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe(RouteName.Upload)
  })

  it('closes a clean invoice detail on leaving for Information and keeps it closed on return', async () => {
    const runtime = await startApplication()

    button('Ver detalles de Comercio del barrio').click()

    await flushPromises()

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Detalle de factura',
    )

    await runtime.router.push('/information')
    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe(RouteName.Information)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    navigationLink('Facturas').click()

    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe(RouteName.Invoices)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(button('Ver detalles de Comercio del barrio')).toBeDefined()
  })

  it('blocks Information while processing and resets upload selection and results only after committed departure', async () => {
    const pending = deferred<Result<ProcessingOutcome>>()
    const process = vi.fn<ProcessingService['process']>(() => pending.promise)
    const runtime = await startApplication({}, undefined, {
      path: '/invoices/upload',
      processing: {
        ...createUnavailableProcessingService(),
        available: true,
        state: { kind: 'ready' },

        subscribe(listener) {
          listener({ kind: 'ready' })

          return () => {}
        },

        process,
      },
    })
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')

    if (!input) {
      throw new Error('Missing file picker')
    }

    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [new File(['<factura />'], 'pending.xml')],
    })
    input.dispatchEvent(new Event('change', { bubbles: true }))

    await nextTick()

    expect(button('Procesar archivos').disabled).toBe(true)

    await runtime.router.push('/information')

    expect(runtime.router.currentRoute.value.name).toBe(RouteName.Upload)

    await vi.waitFor(() =>
      expect(button('Procesar archivos').disabled).toBe(false),
    )

    const removeGuard = runtime.router.beforeEach((to) =>
      to.name === RouteName.Information ? false : true,
    )

    await runtime.router.push('/information')
    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe(RouteName.Upload)
    expect(document.querySelector('main')?.textContent).toContain('pending.xml')
    expect(button('Procesar archivos').disabled).toBe(false)
    removeGuard()
    button('Procesar archivos').click()

    await vi.waitFor(() => expect(process).toHaveBeenCalledOnce())

    await runtime.router.push('/information')

    expect(runtime.router.currentRoute.value.name).toBe(RouteName.Upload)

    const selected = process.mock.calls[0]![0][0]!

    pending.resolve({
      ok: true,
      value: {
        kind: 'completed',
        files: [
          {
            id: selected.id,
            name: selected.file.name,
            status: 'error',
            message: 'No se pudo leer el XML.',
            retryable: true,
          },
        ],
        summary: { added: 0, duplicates: 0, failed: 1, saved: 0 },
      },
    })

    await flushPromises()

    expect(
      [
        ...document.querySelectorAll(
          '[aria-label="Resumen confirmado de archivos"] dd',
        ),
      ].map((count) => count.textContent?.trim()),
    ).toEqual(['0', '0', '1'])

    await runtime.router.push('/information')
    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe(RouteName.Information)

    await runtime.router.push('/invoices/upload')
    await flushPromises()

    expect(button('Procesar archivos').disabled).toBe(true)
    expect(document.querySelector('main')?.textContent).not.toContain(
      'pending.xml',
    )
    expect(
      [
        ...document.querySelectorAll(
          '[aria-label="Resumen confirmado de archivos"] dd',
        ),
      ].map((count) => count.textContent?.trim()),
    ).toEqual(['0', '0', '0'])
  })

  it('uses the visible issuer fallback in all accessible action names', async () => {
    await startApplication({
      read: () => ({
        ok: true,
        value: invoiceDataFixture([invoiceFixture({ issuer: null })]),
      }),
    })

    expect(button('Ver detalles de No disponible')).toBeDefined()
    expect(button('Eliminar factura de No disponible')).toBeDefined()

    const toggle = button('Mostrar conceptos de No disponible')

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    toggle.click()

    await nextTick()

    expect(
      button('Ocultar conceptos de No disponible').getAttribute(
        'aria-expanded',
      ),
    ).toBe('true')
    expect(
      document.querySelector('main button[aria-label$=" de null"]'),
    ).toBeNull()
  })

  it('identifies the requested invoice snapshot and preserves focus without scrolling after cancel or deletion', async () => {
    const victim = invoiceFixture({
      issuer: 'factura-del-proveedor.xml',
      number: 'FAC-007',
    })
    const remaining = invoiceFixture({
      id: 'remaining',
      issuer: 'Otro comercio',
    })
    const remove = vi.fn<InvoiceService['remove']>(() => ({
      ok: true,
      value: invoiceDataFixture([remaining]),
    }))

    const runtime = await startApplication({
      read: () => ({
        ok: true,
        value: invoiceDataFixture([victim, remaining]),
      }),

      remove,
    })

    const opener = button('Eliminar factura de factura-del-proveedor.xml')
    const table = document.querySelector<HTMLElement>(
      '[aria-label="Listado de facturas"]',
    )
    const heading = document.getElementById('invoices-heading')

    if (!table || !heading) {
      throw new Error('Missing invoice table or heading')
    }

    table.scrollTop = 140
    opener.focus()

    const restoreFocus = vi.spyOn(opener, 'focus')
    const headingFocus = vi.spyOn(heading, 'focus')

    vi.mocked(window.scrollTo).mockClear()
    opener.click()

    await flushPromises()

    const dialog = document.querySelector('[role="dialog"]')

    expect(dialog?.textContent).toContain('FAC-007')
    expect(dialog?.textContent).toContain('factura-del-proveedor.xml')
    expect(
      [...(dialog?.querySelectorAll('strong') ?? [])].map(
        (item) => item.textContent,
      ),
    ).toEqual(['FAC-007', 'factura-del-proveedor.xml'])

    runtime.invoices.publish(
      invoiceDataFixture([
        { ...victim, issuer: 'Nombre actualizado', number: 'FAC-NEW' },
        remaining,
      ]),
    )

    await flushPromises()

    expect(dialog?.textContent).toContain('FAC-007')
    expect(dialog?.textContent).not.toContain('FAC-NEW')
    button('Cancelar').click()

    await flushPromises()

    expect(remove).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(opener)
    expect(restoreFocus).toHaveBeenCalledWith({ preventScroll: true })
    expect(table.scrollTop).toBe(140)

    opener.click()

    await flushPromises()

    button('Eliminar').click()

    await flushPromises()

    expect(remove).toHaveBeenCalledWith(victim.id)
    expect(runtime.router.currentRoute.value.name).toBe('invoices')
    expect(headingFocus).toHaveBeenCalledWith({ preventScroll: true })
    expect(table.scrollTop).toBe(140)
    expect(window.scrollTo).not.toHaveBeenCalled()
  })

  it('enables clear only for effective filters and composes the existing draft lock', async () => {
    await startApplication()

    const clear = button('Limpiar filtros')
    const query = document.querySelector<HTMLInputElement>(
      'input[placeholder="Emisor o número"]',
    )

    if (!query) {
      throw new Error('Missing invoice query')
    }

    expect(clear.disabled).toBe(true)
    query.value = '   '
    query.dispatchEvent(new Event('input', { bubbles: true }))

    await nextTick()

    expect(clear.disabled).toBe(true)
    query.value = 'Comercio'
    query.dispatchEvent(new Event('input', { bubbles: true }))

    await nextTick()

    expect(clear.disabled).toBe(false)

    await beginConceptDraft()

    expect(clear.disabled).toBe(true)
    button('Cancelar edición de Fruta').click()

    await nextTick()

    expect(clear.disabled).toBe(false)
    button('Cerrar detalle').click()

    await flushPromises()

    clear.click()

    await nextTick()

    expect(query.value).toBe('')
    expect(clear.disabled).toBe(true)

    for (const [label, value] of [
      ['Año', '2026'],
      ['Categoría', 'Salud'],
    ]) {
      const field = [...document.querySelectorAll('label')]
        .find((element) => element.firstChild?.textContent?.trim() === label)
        ?.querySelector('select')

      if (!field || !value) {
        throw new Error('Missing invoice filter')
      }

      field.value = value
      field.dispatchEvent(new Event('change', { bubbles: true }))

      await nextTick()

      expect(clear.disabled).toBe(false)
      clear.click()

      await nextTick()

      expect(field.value).toBe('')
      expect(clear.disabled).toBe(true)
    }
  })

  it('waits for persisted collection hydration before deciding direct invoice access', async () => {
    const pending = deferred<Result<InvoiceData>>()
    const read = vi.fn<InvoiceService['read']>(() => pending.promise)
    let hydrated = false
    const starting = startApplication({ read }).then((runtime) => {
      hydrated = true

      return runtime
    })

    await flushPromises()

    expect(read).toHaveBeenCalledOnce()
    expect(hydrated).toBe(false)

    pending.resolve({
      ok: true,
      value: invoiceDataFixture([invoiceFixture()]),
    })

    const runtime = await starting

    expect(runtime.router.currentRoute.value.name).toBe('invoices')
    expect(runtime.invoices.hasInvoices).toBe(true)
    expect(document.getElementById('invoices-heading')).not.toBeNull()
  })

  it('preserves the route and draft while a focus refresh is pending', async () => {
    const pending = deferred<Result<InvoiceData>>()
    let reads = 0

    const runtime = await startApplication({
      read: () => {
        reads++

        if (reads === 1) {
          return { ok: true, value: invoiceDataFixture([invoiceFixture()]) }
        }

        return pending.promise
      },
    })

    await beginConceptDraft()

    window.dispatchEvent(new Event('focus'))

    await nextTick()

    expect(reads).toBe(2)
    expect(runtime.invoices.hasInvoices).toBe(true)
    expect(runtime.router.currentRoute.value.name).toBe('invoices')
    expect(categorySelect().value).toBe('Salud')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Detalle de factura',
    )

    pending.resolve({
      ok: true,
      value: invoiceDataFixture([invoiceFixture()]),
    })

    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe('invoices')
    expect(categorySelect().value).toBe('Salud')
  })

  it('redirects only after a focus refresh confirms a cross-adapter deletion', async () => {
    const name = `invoice-focus-${crypto.randomUUID()}`
    const limits = { maxFiles: 500, maxTotalBytes: 104857600 }
    const first = createIndexedDbInvoiceService(limits, {
      coordinator: testCoordinator(),
      recalculate: testRecalculate,
      databaseName: name,
    })
    const second = createIndexedDbInvoiceService(limits, {
      coordinator: testCoordinator(),
      recalculate: testRecalculate,
      databaseName: name,
    })

    await seedInvoice(first)

    const runtime = await startApplication(first)

    await second.remove('invoice-1')

    expect(runtime.invoices.hasInvoices).toBe(true)
    window.dispatchEvent(new Event('focus'))

    await vi.waitFor(() =>
      expect(runtime.router.currentRoute.value.name).toBe('upload'),
    )

    expect(runtime.invoices.snapshot).toMatchObject({
      kind: 'ready',
      invoices: [],
      usage: { files: 0, bytes: 0 },
    })
    second.dispose?.()
  })

  it('notifies concept, principal, restore and deletion success only after durable changes', async () => {
    const service = createIndexedDbInvoiceService(
      { maxFiles: 500, maxTotalBytes: 104857600 },
      {
        coordinator: testCoordinator(),
        recalculate: testRecalculate,
        databaseName: `invoice-notifications-${crypto.randomUUID()}`,
      },
    )

    await seedInvoice(service)

    const runtime = await startApplication(service)

    const success = vi.spyOn(toast, 'success')

    await beginConceptDraft()

    button('Guardar cambios de Fruta').click()

    await vi.waitFor(() =>
      expect(success).toHaveBeenCalledWith('Categoría guardada.'),
    )

    let stored = await service.read()

    expect(stored.ok && stored.value.invoices[0]?.concepts[0]?.category).toBe(
      'Salud',
    )

    success.mockClear()
    button('Editar categoría de factura 001-001-000000001').click()

    await nextTick()

    const label = [...document.querySelectorAll('label')].find(
      (element) =>
        element.textContent?.trim() ===
        'Categoría de factura 001-001-000000001',
    )
    const principal = label ? document.getElementById(label.htmlFor) : null

    if (!(principal instanceof HTMLSelectElement)) {
      throw new Error('Missing principal category selector')
    }

    principal.value = 'Vivienda'
    principal.dispatchEvent(new Event('change', { bubbles: true }))

    await nextTick()

    button('Guardar cambios de factura 001-001-000000001').click()

    await vi.waitFor(() =>
      expect(success).toHaveBeenCalledWith('Categoría guardada.'),
    )

    stored = await service.read()

    expect(stored.ok && stored.value.invoices[0]?.principal).toBe('Vivienda')

    success.mockClear()
    button('Restaurar categoría original de factura 001-001-000000001').click()

    await vi.waitFor(() =>
      expect(success).toHaveBeenCalledWith('Modo automático restaurado.'),
    )

    stored = await service.read()

    expect(stored.ok && stored.value.invoices[0]?.principal).toBe('Salud')

    button('Cerrar detalle').click()

    await flushPromises()

    success.mockClear()
    button('Eliminar factura de Comercio del barrio').click()

    await flushPromises()

    button('Eliminar').click()

    await vi.waitFor(() =>
      expect(success).toHaveBeenCalledWith('Factura eliminada.'),
    )
    await vi.waitFor(() =>
      expect(runtime.router.currentRoute.value.name).toBe('upload'),
    )

    expect(document.body.textContent).toContain('Factura eliminada.')

    stored = await service.read()

    expect(stored.ok && stored.value.invoices).toEqual([])
  })

  it('renders the real invoice page and restores focus after closing its detail dialog', async () => {
    await startApplication()

    expect(document.querySelector('h1')?.textContent?.trim()).toBe(
      'Mis facturas',
    )

    const opener = button('Ver detalles de Comercio del barrio')

    opener.focus()
    opener.click()

    await flushPromises()

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Detalle de factura',
    )
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Vitaminas',
    )
    button('Cerrar detalle').click()

    await flushPromises()

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps expanded concepts read-only even while the modal edits the same concept', async () => {
    await startApplication()

    button('Mostrar conceptos de Comercio del barrio').click()

    await nextTick()

    const main = document.querySelector('main')
    const concepts = main?.querySelector('tbody table')

    expect(concepts?.textContent).toContain('Fruta')
    expect(concepts?.querySelector('button, select')).toBeNull()
    expect(concepts?.textContent).not.toContain('Acciones')

    await beginConceptDraft()

    expect(categorySelect().value).toBe('Salud')
    expect(concepts?.querySelector('button, select')).toBeNull()
    expect(
      concepts?.querySelector('[data-category="Alimentación"]'),
    ).not.toBeNull()
    expect(
      main?.querySelector('button[aria-label^="Editar categoría"]'),
    ).toBeNull()
  })

  it('shows all categories as passive summaries and filters only from the dropdown', async () => {
    await startApplication()

    const summary = document.querySelector(
      'section[aria-labelledby="summary-heading"]',
    )
    const labels = () =>
      [...(summary?.querySelectorAll('dt') ?? [])].map((label) =>
        label.textContent?.trim(),
      )

    expect(labels()).toEqual(categories)
    expect(summary?.querySelector('button, a, [tabindex]')).toBeNull()
    summary
      ?.querySelectorAll('dt')[1]
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    await nextTick()

    const filter = [...document.querySelectorAll('select')].find(
      (select) => select.querySelector('option')?.textContent === 'Todas',
    )

    if (!filter) {
      throw new Error('Missing category filter')
    }

    expect(filter.value).toBe('')
    filter.value = 'Turismo'
    filter.dispatchEvent(new Event('change', { bubbles: true }))

    await nextTick()

    expect(document.body.textContent).toContain(
      'No encontramos facturas con estos filtros.',
    )
    expect(labels()).toEqual(categories)
    expect(
      summary?.textContent?.match(/Sin gastos en esta categoría/g),
    ).toHaveLength(8)
  })

  it.each(['/invoices/upload', '/information'])(
    'preserves a draft and its native unload warning when departure to %s is canceled',
    async (destination) => {
      const runtime = await startApplication()

      await beginConceptDraft()

      const unload = new Event('beforeunload', { cancelable: true })

      window.dispatchEvent(unload)
      expect(unload.defaultPrevented).toBe(true)

      const navigating = runtime.router.push(destination)

      await flushPromises()

      expect(
        [...document.querySelectorAll('[role="dialog"]')].some((dialog) =>
          dialog.textContent?.includes('Descartar corrección'),
        ),
      ).toBe(true)
      button('Cancelar').click()

      await navigating
      await flushPromises()

      expect(runtime.router.currentRoute.value.name).toBe('invoices')
      expect(categorySelect().value).toBe('Salud')
      expect(categorySelect().disabled).toBe(false)
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
        'Detalle de factura',
      )

      button('Cancelar edición de Fruta').click()

      await nextTick()

      const cleanUnload = new Event('beforeunload', { cancelable: true })

      window.dispatchEvent(cleanUnload)
      expect(cleanUnload.defaultPrevented).toBe(false)
    },
  )

  it.each(['/invoices/upload', '/information'])(
    'keeps discard provisional until all later guards accept departure to %s',
    async (destination) => {
      const runtime = await startApplication()

      await beginConceptDraft()

      const laterGuard = deferred<boolean>()
      const removeGuard = runtime.router.beforeEach((to) =>
        to.path === destination ? laterGuard.promise : true,
      )
      const navigating = runtime.router.push(destination)

      await flushPromises()

      button('Descartar').click()

      await flushPromises()

      expect(categorySelect().value).toBe('Salud')
      expect(categorySelect().disabled).toBe(true)
      laterGuard.resolve(false)

      await navigating
      await flushPromises()

      expect(runtime.router.currentRoute.value.name).toBe('invoices')
      expect(categorySelect().value).toBe('Salud')
      expect(categorySelect().disabled).toBe(false)
      removeGuard()

      const accepted = runtime.router.push(destination)

      await flushPromises()

      button('Descartar').click()

      await accepted
      await flushPromises()

      expect(runtime.router.currentRoute.value.path).toBe(destination)
      expect(document.querySelector('[role="dialog"]')).toBeNull()

      const unload = new Event('beforeunload', { cancelable: true })

      window.dispatchEvent(unload)
      expect(unload.defaultPrevented).toBe(false)

      await runtime.router.push('/invoices')
      await flushPromises()

      expect(document.querySelector('[role="dialog"]')).toBeNull()
      expect(runtime.protection.isDirty()).toBe(false)
    },
  )

  it('keeps the real discard reservation reversible until activation is observed', async () => {
    const runtime = await startApplication()

    await beginConceptDraft()

    const consentPromise = runtime.protection.prepareLeave()

    await flushPromises()

    button('Descartar').click()

    const consent = await consentPromise

    expect(consent.allowed).toBe(true)
    expect(runtime.protection.isDirty()).toBe(true)
    expect(runtime.protection.isUpdateBlocked()).toBe(false)

    const locks = webLocks()
    const updates = createUpdateCoordinator({
      writer: testCoordinator(),
      locks,
      isDirty: runtime.protection.isDirty,
      isBlocked: runtime.protection.isUpdateBlocked,
    })

    await updates.admit(async () => true)
    await expect(
      updates.withUpdate('aborted', consent, async () => {
        expect(await updates.prepare('aborted')).toBe(true)

        throw new Error('Another tab declined')
      }),
    ).rejects.toThrow('Another tab declined')
    await flushPromises()

    expect(categorySelect().value).toBe('Salud')
    expect(categorySelect().disabled).toBe(false)
    expect(runtime.protection.isDirty()).toBe(true)
    updates.dispose()
  })

  it('blocks invoice removal before tab admission is complete', async () => {
    const blocked = shallowRef(true)
    const remove = vi.fn<InvoiceService['remove']>(() => ({
      ok: true,
      value: invoiceDataFixture([]),
    }))

    await startApplication(
      { remove },
      { blocked, message: shallowRef('Esperando…') },
    )

    expect(document.querySelector('main [inert]')).not.toBeNull()
    expect(document.querySelector('main')?.textContent).not.toContain(
      'Esperando…',
    )

    button('Eliminar factura de Comercio del barrio').click()

    await flushPromises()

    expect(remove).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    blocked.value = false

    await nextTick()

    button('Eliminar factura de Comercio del barrio').click()

    await flushPromises()

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Eliminar factura',
    )
  })

  it.each(['/invoices/upload', '/information'])(
    'blocks departure to %s while an invoice correction is being saved',
    async (destination) => {
      const pending = deferred<Result<InvoiceData>>()

      const runtime = await startApplication({ correct: () => pending.promise })

      await beginConceptDraft()

      button('Guardar cambios de Fruta').click()

      await nextTick()
      await runtime.router.push(destination)

      expect(runtime.router.currentRoute.value.name).toBe('invoices')
      expect(categorySelect().disabled).toBe(true)
      pending.resolve({
        ok: true,
        value: invoiceDataFixture([invoiceFixture()]),
      })

      await flushPromises()
      await runtime.router.push(destination)

      expect(runtime.router.currentRoute.value.path).toBe(destination)
    },
  )

  it.each(['/invoices/upload', '/information'])(
    'preserves and unlocks a draft when a later guard throws on departure to %s',
    async (destination) => {
      const runtime = await startApplication()

      await beginConceptDraft()

      const removeGuard = runtime.router.beforeEach((to) => {
        if (to.path === destination) {
          throw new Error('Later navigation failed')
        }
      })
      const navigating = runtime.router.push(destination)
      const failure = navigating.catch((error: unknown) => error)

      await flushPromises()

      button('Descartar').click()
      expect(await failure).toBeInstanceOf(Error)

      await flushPromises()

      expect(runtime.router.currentRoute.value.name).toBe('invoices')
      expect(categorySelect().value).toBe('Salud')
      expect(categorySelect().disabled).toBe(false)

      categorySelect().value = 'Vivienda'
      categorySelect().dispatchEvent(new Event('change', { bubbles: true }))

      await nextTick()

      expect(categorySelect().value).toBe('Vivienda')

      removeGuard()

      const accepted = runtime.router.push(destination)

      await flushPromises()

      button('Descartar').click()

      await accepted
      await flushPromises()

      expect(runtime.router.currentRoute.value.path).toBe(destination)
    },
  )

  it('redirects after the last invoice is authoritatively removed', async () => {
    const remove = vi.fn<InvoiceService['remove']>(() => ({
      ok: true,
      value: invoiceDataFixture([]),
    }))

    const runtime = await startApplication({ remove })

    button('Eliminar factura de Comercio del barrio').click()

    await flushPromises()

    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Eliminar factura',
    )
    button('Eliminar').click()

    await flushPromises()

    expect(remove).toHaveBeenCalledWith('invoice-1')
    expect(runtime.invoices.snapshot).toMatchObject({
      kind: 'ready',
      invoices: [],
    })
    expect(runtime.router.currentRoute.value.name).toBe('upload')
  })

  it.each(['/invoices/upload', '/information'])(
    'retains list filters, current page, page size and expanded rows after visiting %s',
    async (destination) => {
      const runtime = await startApplication({
        read: () => ({
          ok: true,
          value: invoiceDataFixture(
            Array.from({ length: 35 }, (_, index) =>
              invoiceFixture({
                id: `invoice-${index + 1}`,
                issuer: `Comercio ${index + 1}`,
              }),
            ),
          ),
        }),
      })

      const query = document.querySelector<HTMLInputElement>(
        'input[placeholder="Emisor o número"]',
      )

      if (!query) {
        throw new Error('Missing search field')
      }

      query.value = 'Comercio'
      query.dispatchEvent(new Event('input', { bubbles: true }))

      for (const [label, value] of [
        ['Año', '2026'],
        ['Categoría', 'Alimentación'],
      ]) {
        const field = [...document.querySelectorAll('label')]
          .find((element) => element.firstChild?.textContent?.trim() === label)
          ?.querySelector('select')

        if (!field || !value) {
          throw new Error('Missing invoice filter')
        }

        field.value = value
        field.dispatchEvent(new Event('change', { bubbles: true }))
      }

      const pageSize = [...document.querySelectorAll('select')].find((select) =>
        select.querySelector('option[value="30"]'),
      )

      if (!pageSize) {
        throw new Error('Missing page size')
      }

      pageSize.value = '30'
      pageSize.dispatchEvent(new Event('change', { bubbles: true }))

      await nextTick()

      button('Siguiente').click()

      await nextTick()

      const expand = document.querySelector<HTMLButtonElement>(
        'button[aria-label^="Mostrar conceptos de Comercio"]',
      )
      const expandLabel = expand?.getAttribute('aria-label')

      if (!expand || !expandLabel) {
        throw new Error('Missing concept toggle')
      }

      expand.click()

      await nextTick()

      expect(document.querySelector('main')?.textContent).toContain(
        'Página 2 de 2',
      )

      await runtime.router.push(destination)
      await flushPromises()
      await runtime.router.push('/invoices')
      await flushPromises()

      expect(
        document.querySelector<HTMLInputElement>(
          'input[placeholder="Emisor o número"]',
        )?.value,
      ).toBe('Comercio')
      expect(
        [...document.querySelectorAll('select')].find((select) =>
          select.querySelector('option[value="30"]'),
        )?.value,
      ).toBe('30')
      expect(
        [...document.querySelectorAll('label')]
          .find((element) => element.firstChild?.textContent?.trim() === 'Año')
          ?.querySelector('select')?.value,
      ).toBe('2026')
      expect(
        [...document.querySelectorAll('label')]
          .find(
            (element) =>
              element.firstChild?.textContent?.trim() === 'Categoría',
          )
          ?.querySelector('select')?.value,
      ).toBe('Alimentación')
      expect(document.querySelector('main')?.textContent).toContain(
        'Página 2 de 2',
      )
      expect(
        button(expandLabel.replace('Mostrar', 'Ocultar')).getAttribute(
          'aria-expanded',
        ),
      ).toBe('true')
    },
  )

  it('keeps unavailable invoice data distinct from an empty collection and disables its header action', async () => {
    const runtime = await startApplication({
      read: () => ({
        ok: false,
        code: 'unavailable',
        message: 'Integración pendiente.',
      }),
    })

    expect(runtime.router.currentRoute.value.name).toBe('invoices')
    expect(button('Facturas').disabled).toBe(true)
    expect(
      document.querySelector('main [role="alert"]')?.textContent,
    ).toContain('Integración pendiente.')
    button('Modo offline limitado').click()

    await flushPromises()

    const availability = document.querySelector(
      '[data-reka-popper-content-wrapper]',
    )

    expect(availability?.textContent).toContain('Funciones no disponibles')

    for (const feature of [
      'Seleccionar archivos',
      'Procesar archivos',
      'Consultar facturas',
      'Editar categorías',
      'Eliminar facturas',
      'Consultar capacidad',
      'Borrar datos almacenados',
    ]) {
      expect(availability?.textContent).toContain(feature)
    }

    expect(runtime.invoices.snapshot.kind).toBe('error')
    expect(document.getElementById('summary-heading')).toBeNull()
  })
  it('keeps a ready-empty collection distinct while denying invoice access', async () => {
    const runtime = await startApplication({
      read: () => ({ ok: true, value: invoiceDataFixture([]) }),
    })

    expect(runtime.router.currentRoute.value.name).toBe('upload')
    expect(runtime.invoices.snapshot).toMatchObject({
      kind: 'ready',
      invoices: [],
    })
    expect(button('Facturas').disabled).toBe(true)
    expect(document.getElementById('summary-heading')).toBeNull()
  })

  it('offers global collection recovery without redirecting after a transient read failure', async () => {
    const read = vi
      .fn<InvoiceService['read']>()
      .mockReturnValueOnce({
        ok: false,
        message: 'No se pudo consultar el listado.',
      })
      .mockReturnValue({
        ok: true,
        value: invoiceDataFixture([invoiceFixture()]),
      })

    const runtime = await startApplication({ read })

    expect(runtime.router.currentRoute.value.name).toBe('invoices')
    button('Modo offline limitado').click()

    await flushPromises()

    button('Reintentar').click()

    await flushPromises()

    expect(runtime.invoices.hasInvoices).toBe(true)

    await runtime.router.push('/invoices')
    await flushPromises()

    expect(runtime.router.currentRoute.value.name).toBe('invoices')
  })
})
