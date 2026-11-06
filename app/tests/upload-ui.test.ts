// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { shallowRef } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import {
  createLeaveProtection,
  leaveProtectionKey,
} from '../src/app/navigation/leaveProtection'
import { storageLimitsKey } from '../src/app/config/storageLimits'
import { invoiceServiceKey } from '../src/features/invoices/services/invoiceService'
import { createUnavailableInvoiceService } from '../src/features/invoices/services/unavailableInvoiceService'
import { useInvoiceStore } from '../src/features/invoices/stores/useInvoiceStore'
import type { InvoiceData } from '../src/features/invoices/domain/storageModel'
import {
  processingServiceKey,
  type FileProcessingResult,
  type PreparationState,
  type ProcessingService,
} from '../src/features/upload/services/processingService'
import { createUnavailableProcessingService } from '../src/features/upload/services/unavailableProcessingService'
import UploadPage from '../src/features/upload/pages/UploadPage.vue'
import BatchActivityPanel from '../src/features/upload/components/BatchActivityPanel.vue'
import FileDropzone from '../src/features/upload/components/FileDropzone.vue'
import SelectedFileList from '../src/features/upload/components/SelectedFileList.vue'
import ProcessingResults from '../src/features/upload/components/ProcessingResults.vue'
import type { BatchActivity } from '../src/features/upload/model/activity'
import { summarizeResults } from '../src/features/upload/model/processingLedger'
import { invoiceDataFixture, invoiceFixture } from './fixtures/invoices'
import { readyProcessing } from './fixtures/processing'
import { offlineServiceKey } from '../src/features/offline/services/offlineService'
import {
  updateInteractionKey,
  type UpdateInteraction,
} from '../src/app/updateCoordinator'

const wrappers: { unmount(): void }[] = []

beforeEach(() => {
  let frame = 0

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0))

    return ++frame
  })
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  vi.stubGlobal('matchMedia', () => ({
    matches: true,

    addEventListener() {},

    removeEventListener() {},
  }))
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mountUpload(
  processing = createUnavailableProcessingService(),
  data: InvoiceData = invoiceDataFixture(),
  maxFiles = 10000,
  protection = createLeaveProtection(),
  interaction?: UpdateInteraction,
) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', component: { render: () => null } }],
  })
  const pinia = createPinia()
  const wrapper = mount(UploadPage, {
    global: {
      plugins: [pinia, router],
      provide: {
        [invoiceServiceKey]: createUnavailableInvoiceService(),
        [processingServiceKey]: processing,
        [storageLimitsKey]: { maxFiles, maxTotalBytes: 104857600 },
        [leaveProtectionKey]: protection,
        [offlineServiceKey]: { retry: vi.fn(async () => {}) },
        ...(interaction ? { [updateInteractionKey]: interaction } : {}),
      },
      stubs: { FirstInvoiceCelebration: true },
    },
  })

  wrappers.push(wrapper)

  const store = useInvoiceStore(pinia)

  store.publish(data)

  return { wrapper, store }
}

function action(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper
    .findAll('button')
    .find((element) => element.text() === text)

  if (!button) {
    throw new Error(`Missing ${text}`)
  }

  return button
}

describe('real upload presentation', () => {
  it('admits file selection only after its tab gate opens and preserves idle selection while frozen', async () => {
    const blocked = shallowRef(true)
    const protection = createLeaveProtection()
    const process = vi.fn<ProcessingService['process']>(() => ({
      ok: true,
      value: { kind: 'cancelled' },
    }))
    const { wrapper } = mountUpload(
      readyProcessing(process),
      invoiceDataFixture(),
      10000,
      protection,
      { blocked, message: shallowRef('Esperando otra pestaña…') },
    )
    const dropzone = wrapper.getComponent(FileDropzone)
    const add = () =>
      dropzone.vm.$emit('add', [new File(['one'], 'factura.xml')])

    add()

    await flushPromises()

    expect(wrapper.getComponent(SelectedFileList).props('files')).toHaveLength(
      0,
    )
    blocked.value = false

    await flushPromises()

    add()

    await flushPromises()

    expect(wrapper.getComponent(SelectedFileList).props('files')).toHaveLength(
      1,
    )
    expect(protection.isDirty()).toBe(false)
    blocked.value = true

    await flushPromises()

    add()

    await action(wrapper, 'Procesar archivos').trigger('click')
    await flushPromises()

    expect(wrapper.getComponent(SelectedFileList).props('files')).toHaveLength(
      1,
    )
    expect(process).not.toHaveBeenCalled()
  })
  it('admits repeated and stored filenames silently and submits all selections to the locked adapter', async () => {
    const process = vi.fn<ProcessingService['process']>((inputs, hooks) => {
      const files: FileProcessingResult[] = inputs.map((input) => ({
        id: input.id,
        name: input.file.name,
        message: 'Duplicado',
        status: 'duplicate',
        invoiceIds: ['existing'],
      }))

      files.forEach(hooks.onFileResult)

      return {
        ok: true,
        value: { kind: 'completed', files, summary: summarizeResults(files) },
      }
    })
    const { wrapper } = mountUpload(
      readyProcessing(process),
      invoiceDataFixture([invoiceFixture()]),
    )

    await flushPromises()

    const files = [
      new File(['one'], 'factura.xml'),
      new File(['two'], 'factura.xml'),
    ]

    wrapper.getComponent(FileDropzone).vm.$emit('add', files)

    await flushPromises()

    expect(wrapper.getComponent(SelectedFileList).props('files')).toHaveLength(
      2,
    )
    expect(process).not.toHaveBeenCalled()
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)

    await action(wrapper, 'Procesar archivos').trigger('click')
    await flushPromises()

    expect(process).toHaveBeenCalledTimes(1)
    expect(process.mock.calls[0]?.[0]).toHaveLength(2)
    expect(
      wrapper.getComponent(ProcessingResults).props('summary'),
    ).toMatchObject({ duplicates: 2, saved: 0 })
  })

  it('keeps processing disabled until ready without duplicate preparation notices or retry controls', async () => {
    let state: PreparationState = { kind: 'loading' }
    const listeners = new Set<(state: PreparationState) => void>()
    const port: ProcessingService = {
      get available() {
        return state.kind === 'ready'
      },

      get state() {
        return state
      },

      prepare: vi.fn(async () => {
        state = { kind: 'ready' }
        listeners.forEach((listener) => listener(state))
      }),

      subscribe(listener) {
        listeners.add(listener)

        return () => listeners.delete(listener)
      },

      process: vi.fn(),
    }
    const { wrapper } = mountUpload(port)

    await flushPromises()

    wrapper
      .getComponent(FileDropzone)
      .vm.$emit('add', [new File(['xml'], 'a.xml')])

    await flushPromises()

    expect(
      action(wrapper, 'Procesar archivos').attributes('disabled'),
    ).toBeDefined()
    expect(wrapper.text()).not.toContain('Preparando el modelo')
    state = { kind: 'error', message: 'Paquete no disponible' }
    listeners.forEach((listener) => listener(state))

    await flushPromises()
    expect(wrapper.text()).not.toContain('Paquete no disponible')
    expect(
      wrapper
        .findAll('button')
        .some((button) => button.text().includes('intentar')),
    ).toBe(false)
    await port.prepare()
    await flushPromises()

    expect(port.prepare).toHaveBeenCalledOnce()
    expect(
      action(wrapper, 'Procesar archivos').attributes('disabled'),
    ).toBeUndefined()
    expect(wrapper.text()).not.toContain(
      'Todo listo para procesar tus facturas.',
    )
  })

  it('keeps storage preconditions without duplicate inline storage notices or retry controls', async () => {
    const { wrapper, store } = mountUpload()

    store.snapshot = {
      kind: 'error',
      code: 'storage-unavailable',
      message: 'No se pudo consultar el almacenamiento.',
    }

    await flushPromises()

    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain(
      'No se pudo consultar el almacenamiento.',
    )
    expect(
      wrapper
        .findAll('button')
        .some((button) => button.text().includes('Reintentar')),
    ).toBe(false)
    expect(wrapper.getComponent(FileDropzone).props('disabled')).toBe(true)
  })

  it('opens accepted selection/results panels and clears them only after committed leave', async () => {
    const protection = createLeaveProtection()
    const process = readyProcessing((inputs, hooks) => {
      const files: FileProcessingResult[] = inputs.map((input) => ({
        id: input.id,
        name: input.file.name,
        status: 'error',
        message: 'invalid',
        retryable: false,
      }))

      files.forEach(hooks.onFileResult)

      return {
        ok: true,
        value: { kind: 'completed', files, summary: summarizeResults(files) },
      }
    })
    const { wrapper } = mountUpload(
      process,
      invoiceDataFixture(),
      10,
      protection,
    )

    await flushPromises()

    expect(wrapper.getComponent(SelectedFileList).props('open')).toBe(false)
    wrapper
      .getComponent(FileDropzone)
      .vm.$emit('add', [new File(['xml'], 'a.xml')])

    await flushPromises()

    expect(wrapper.getComponent(SelectedFileList).props('open')).toBe(true)

    await action(wrapper, 'Procesar archivos').trigger('click')
    await flushPromises()

    expect(wrapper.getComponent(ProcessingResults).props('open')).toBe(true)

    const leave = await protection.prepareLeave()

    leave.cancel()

    await flushPromises()

    expect(wrapper.getComponent(ProcessingResults).props('open')).toBe(true)

    const committed = await protection.prepareLeave()

    committed.commit()

    await flushPromises()

    expect(wrapper.getComponent(ProcessingResults).props('open')).toBe(false)
  })

  it('keeps accepted batch size independent of later selection removals and rejects a whole over-limit batch', async () => {
    const { wrapper } = mountUpload(undefined, invoiceDataFixture(), 2)

    await flushPromises()

    wrapper
      .getComponent(FileDropzone)
      .vm.$emit('add', [
        new File(['12345'], 'a.xml'),
        new File(['12345'], 'b.xml'),
      ])

    await flushPromises()

    expect(
      wrapper.getComponent(BatchActivityPanel).props('selectionSize'),
    ).toBe('10 B')

    const files = wrapper.getComponent(SelectedFileList).props('files')

    wrapper.getComponent(SelectedFileList).vm.$emit('remove', files[0]!.id)

    await flushPromises()

    expect(
      wrapper.getComponent(BatchActivityPanel).props('selectionSize'),
    ).toBe('10 B')
    wrapper
      .getComponent(FileDropzone)
      .vm.$emit('add', [new File(['x'], 'c.xml'), new File(['x'], 'd.xml')])

    await flushPromises()

    expect(wrapper.getComponent(SelectedFileList).props('files')).toHaveLength(
      1,
    )
    expect(wrapper.text().match(/No se pueden añadir más de 2/g)).toHaveLength(
      1,
    )
  })

  it('keeps the overall progress and concrete issues without redundant file statistics or status subtitles', () => {
    const wrapper = mount(BatchActivityPanel, {
      props: {
        activity: {
          operation: 'processing',
          phase: 'processing',
          metric: 'finished',
          completed: 0,
          total: 1,
          sourceName: 'mixed.zip',
          xml: {
            knownXml: 3,
            finishedXml: 2,
            savedXml: 1,
            failedXml: 1,
            omittedEntries: 0,
          },
        },
      },
    })

    wrappers.push(wrapper)
    expect(wrapper.text()).toContain('0 de 1 finalizados')
    expect(wrapper.text()).not.toContain('XML:')
    expect(wrapper.text()).not.toContain('1 guardados')

    const result = mount(ProcessingResults, {
      props: {
        attemptId: 1,
        open: true,
        results: [
          {
            id: 'zip',
            name: 'mixed.zip',
            status: 'added',
            invoices: [invoiceFixture()],
            issues: ['INVALID_ZIP'],
            message: 'INVALID_ZIP: archivo truncado.',
            retryable: false,
          },
          {
            id: 'saved',
            name: 'saved.xml',
            status: 'added',
            invoices: [invoiceFixture()],
            message: '1 factura guardada.',
          },
          {
            id: 'duplicate',
            name: 'duplicate.xml',
            status: 'duplicate',
            invoiceIds: ['existing'],
            message: 'La factura ya está guardada con esta clave de acceso.',
          },
        ],
        summary: { added: 1, duplicates: 0, failed: 1, saved: 1 },
      },
    })

    wrappers.push(result)
    expect(result.text()).toContain('Con incidencias')
    expect(result.text()).not.toContain('INVALID_ZIP')
    expect(result.text()).not.toContain('archivo truncado.')
    expect(result.text()).toContain(
      'Se guardaron facturas, pero hubo inconvenientes durante el procesamiento.',
    )
    expect(result.text()).not.toContain('1 factura guardada.')
    expect(result.text()).not.toContain('Ya existe un archivo con este nombre.')
  })
})

describe('file picker and drop admission', () => {
  it('uses the same event for picker and drop and resets the picker', async () => {
    const wrapper = mount(FileDropzone, { props: { disabled: false } })

    wrappers.push(wrapper)

    const file = new File(['xml'], 'a.xml')
    const input = wrapper.get('input[type="file"]')

    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [file],
    })

    await input.trigger('change')
    await wrapper
      .get('button')
      .trigger('drop', { dataTransfer: { files: [file] } })

    expect(wrapper.emitted('add')).toEqual([[[file]], [[file]]])
    expect((input.element as HTMLInputElement).value).toBe('')
  })
  it('blocks picker and drop while an operation is active', async () => {
    const wrapper = mount(FileDropzone, { props: { disabled: true } })

    wrappers.push(wrapper)

    await wrapper.get('button').trigger('drop', {
      dataTransfer: { files: [new File(['xml'], 'a.xml')] },
    })

    expect(wrapper.emitted('add')).toBeUndefined()
    expect(wrapper.get('input').attributes('disabled')).toBeDefined()
  })
})
describe('prominent activity panel', () => {
  it('shows confirmed XML progress separately from the outer file counter once its total is known', async () => {
    const wrapper = mount(BatchActivityPanel, {
      props: {
        activity: {
          ...activity(),
          completed: 0,
          total: 1,
          xmlProgress: { completed: 0, total: 12 },
        },
      },
    })

    try {
      expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({
        'aria-valuenow': '0',
        'aria-valuemax': '12',
      })

      await wrapper.setProps({
        activity: {
          ...activity(),
          completed: 0,
          total: 1,
          xmlProgress: { completed: 3, total: 12 },
        },
      })

      expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({
        'aria-valuenow': '3',
        'aria-valuemax': '12',
      })
      expect(wrapper.text()).toContain('0 de 1 finalizados')
      expect(wrapper.text()).not.toContain('XML:')

      await wrapper.setProps({
        activity: {
          ...activity(),
          completed: 0,
          total: 1,
          xmlProgress: { completed: 3, total: null },
        },
      })

      expect(
        wrapper.get('[role="progressbar"]').attributes('aria-valuenow'),
      ).toBeUndefined()
    } finally {
      wrapper.unmount()
    }
  })

  it('does not present selection size as processing progress', () => {
    const wrapper = mount(BatchActivityPanel, {
      props: {
        activity: {
          operation: 'processing',
          phase: 'processing',
          metric: 'finished',
          completed: 0,
          total: 1,
        },
        selectionSize: '8 B',
      },
    })

    try {
      expect(wrapper.text()).toContain('0 de 1 finalizados')
      expect(wrapper.text()).not.toContain('8 B')
    } finally {
      wrapper.unmount()
    }
  })

  function activity(
    phase: BatchActivity['phase'] = 'processing',
  ): BatchActivity {
    return {
      operation: 'processing',
      phase,
      metric: 'finished',
      completed: 18,
      total: 50,
      summary: { added: 16, duplicates: 1, failed: 1, saved: 0 },
    }
  }

  it.each([1, 50])(
    'shows activity while waiting for the first of %i processing results without inventing progress',
    async (total) => {
      const wrapper = mount(BatchActivityPanel, {
        props: {
          activity: { ...activity(), completed: 0, total },
          canCancel: true,
        },
      })

      try {
        expect(wrapper.text()).toContain(`0 de ${total} finalizados`)

        const waitingBar = wrapper.get('[role="progressbar"]')

        expect(waitingBar.attributes('aria-valuenow')).toBeUndefined()
        expect(waitingBar.attributes('aria-label')).toBe('Procesando archivos')
        expect(waitingBar.element.children).toHaveLength(1)
        expect(wrapper.findAll('[role="progressbar"]')).toHaveLength(1)
        expect(wrapper.get('button').text()).toBe('Cancelar procesamiento')

        await wrapper.setProps({
          activity: {
            ...activity(total === 1 ? 'completed' : 'processing'),
            completed: 1,
            total,
          },
        })

        expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({
          'aria-valuenow': '1',
          'aria-valuemax': String(total),
        })
        expect(wrapper.text()).toContain(`1 de ${total} finalizados`)

        await wrapper.setProps({
          activity: { ...activity('cancelled'), completed: 0, total },
          canCancel: false,
        })

        expect(
          wrapper.get('[role="progressbar"]').attributes('aria-valuenow'),
        ).toBe('0')
        expect(wrapper.get('h2').text()).toBe('Procesamiento cancelado')
        expect(wrapper.find('button').exists()).toBe(false)
      } finally {
        wrapper.unmount()
      }
    },
  )

  it('shows counts and accessible progress without duplicating its visible stage heading', async () => {
    const wrapper = mount(BatchActivityPanel, {
      props: { activity: activity(), canCancel: true },
    })

    expect(wrapper.get('h2').text()).toBe('Procesando archivos')
    expect(wrapper.text()).toContain('18 de 50 finalizados')
    expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({
      'aria-valuenow': '18',
      'aria-valuemax': '50',
    })
    expect(wrapper.text()).not.toMatch(/correctos|duplicados|con error/)

    const statusBefore = wrapper.get('[role="status"]').text()

    await wrapper.setProps({ activity: { ...activity(), completed: 19 } })

    expect(wrapper.get('[role="status"]').text()).toBe(statusBefore)

    await wrapper.get('button').trigger('click')

    expect(wrapper.get('button').text()).toBe('Cancelar procesamiento')
    expect(wrapper.emitted('cancel')).toHaveLength(1)
    wrapper.unmount()
  })

  it('shows an immediate rejection without a progress bar or loading counter', () => {
    const wrapper = mount(BatchActivityPanel, {
      props: {
        activity: {
          operation: 'selection',
          phase: 'failed',
          metric: 'loaded',
          completed: 0,
          total: 0,
          message: 'No se añadió la tanda.',
        },
      },
    })

    expect(wrapper.find('[role="progressbar"]').exists()).toBe(false)
    expect(wrapper.text()).not.toMatch(/\d+ de \d+/)
    expect(wrapper.get('[role="alert"]').text()).toBe('No se añadió la tanda.')
    wrapper.unmount()
  })

  it('sticks only while an operation is running', async () => {
    const wrapper = mount(BatchActivityPanel, {
      props: { activity: activity() },
    })

    expect(wrapper.get('section').classes()).toContain('sticky')

    await wrapper.setProps({ activity: activity('completed') })

    expect(wrapper.get('section').classes()).not.toContain('sticky')

    await wrapper.setProps({ activity: activity('failed') })

    expect(wrapper.get('section').classes()).not.toContain('sticky')
    wrapper.unmount()
  })

  it('keeps the completed selection count without lines beneath the progress', () => {
    const wrapper = mount(BatchActivityPanel, {
      props: {
        activity: {
          operation: 'selection',
          phase: 'completed',
          metric: 'loaded',
          completed: 9,
          total: 9,
        },
      },
    })

    expect(wrapper.text().split('9 de 9 añadidos')).toHaveLength(2)
    expect(wrapper.get('h2').text()).toBe('Archivos añadidos')
    expect(wrapper.text()).not.toContain('archivos añadidos a la selección')
    wrapper.unmount()
  })

  it('keeps the completed processing bar without repeating the results', () => {
    const wrapper = mount(BatchActivityPanel, {
      props: {
        activity: {
          ...activity('completed'),
          completed: 50,
          message: '50 resultados guardados',
        },
      },
    })

    expect(wrapper.get('h2').text()).toBe(
      'Procesamiento terminado con incidencias',
    )
    expect(wrapper.text()).toContain('50 de 50 finalizados')
    expect(wrapper.text()).not.toMatch(
      /correctos|duplicados|con error|resultados guardados/,
    )
    wrapper.unmount()
  })

  it('leaves unavailable features to the navigation menu', () => {
    const wrapper = mount(BatchActivityPanel, {
      props: { activity: activity('unavailable') },
    })

    expect(wrapper.find('[aria-label="Actividad de archivos"]').exists()).toBe(
      false,
    )
    wrapper.unmount()
  })
})

describe('upload empty states', () => {
  it('explains both empty file views without file rows or removal actions', () => {
    const stubs = {
      AnimatedScrollList: { template: '<section><slot /></section>' },
    }
    const selected = mount(SelectedFileList, {
      props: { files: [] },
      global: { stubs },
    })
    const results = mount(ProcessingResults, {
      props: { results: [], attemptId: 0 },
      global: { stubs },
    })

    expect(selected.text()).toBe('Aún no has seleccionado archivos.')
    expect(results.text()).toBe('No hay resultados todavía.')

    for (const wrapper of [selected, results]) {
      expect(wrapper.find('[data-row-key]').exists()).toBe(false)
      expect(wrapper.find('button').exists()).toBe(false)
    }

    selected.unmount()
    results.unmount()
  })
})

describe('selected-file heading count', () => {
  it('derives the visible count from files while keeping the region label stable', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))

    const wrapper = mount(SelectedFileList, { props: { files: [] } })
    const a = { id: 'a', file: new File(['xml'], 'a.xml') }
    const b = { id: 'b', file: new File(['xml'], 'b.xml') }

    try {
      expect(wrapper.get('h2').text()).toBe('Archivos seleccionados (0)')

      await wrapper.setProps({ files: [a, b] })

      expect(wrapper.get('h2').text()).toBe('Archivos seleccionados (2)')
      expect(wrapper.get('[role="region"]').attributes('aria-label')).toBe(
        'Archivos seleccionados',
      )

      await wrapper.setProps({ files: [b] })

      expect(wrapper.get('h2').text()).toBe('Archivos seleccionados (1)')

      await wrapper.setProps({ files: [] })

      expect(wrapper.get('h2').text()).toBe('Archivos seleccionados (0)')
    } finally {
      wrapper.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('keeps standalone file panels closed while data changes until the user opens them', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }))

    const selected = mount(SelectedFileList, { props: { files: [] } })
    const results = mount(ProcessingResults, {
      props: { results: [], attemptId: 0 },
    })
    const failure: FileProcessingResult = {
      id: 'failed',
      name: 'failed.xml',
      status: 'error',
      message:
        'El resultado no se pudo guardar. El archivo se puede reintentar.',
    }

    try {
      for (const wrapper of [selected, results]) {
        const disclosure = wrapper.get('details')

        expect((disclosure.element as HTMLDetailsElement).open).toBe(false)
        ;(disclosure.element as HTMLDetailsElement).open = false

        await disclosure.trigger('toggle')
      }

      await selected.setProps({
        files: [{ id: 'new', file: new File(['xml'], 'new.xml') }],
      })
      await results.setProps({ results: [failure], attemptId: 1 })

      for (const wrapper of [selected, results]) {
        expect(
          (wrapper.get('details').element as HTMLDetailsElement).open,
        ).toBe(false)
        expect(wrapper.findAll('[data-row-key]')).toHaveLength(1)

        const disclosure = wrapper.get('details')

        ;(disclosure.element as HTMLDetailsElement).open = true

        await disclosure.trigger('toggle')

        expect((disclosure.element as HTMLDetailsElement).open).toBe(true)
      }

      expect(selected.text()).toContain('new.xml')
      expect(results.text()).not.toContain(failure.message)
      expect(results.text()).toContain(
        'Hubo un problema al procesar este archivo.',
      )
    } finally {
      selected.unmount()
      results.unmount()
      vi.unstubAllGlobals()
    }
  })
})

describe('plain language file outcomes', () => {
  it('uses one short sentence per file even for long XML/ZIP technical payloads', () => {
    const technical = Array.from(
      { length: 25 },
      (_, index) =>
        `nested/${index}.xml: INVALID_XML: claveAcceso ${'1'.repeat(49)}`,
    ).join(' ')
    const wrapper = mount(ProcessingResults, {
      props: {
        open: true,
        attemptId: 4,
        results: [
          {
            id: 'broken',
            name: 'broken.zip',
            status: 'error',
            retryable: false,
            message: technical,
            issues: [technical],
          },
          {
            id: 'partial',
            name: 'partial.zip',
            status: 'added',
            invoices: [invoiceFixture()],
            message: technical,
            issues: [technical],
          },
          {
            id: 'pending',
            name: 'pending.zip',
            status: 'error',
            retryable: true,
            message: technical,
            issues: [technical],
          },
        ],
      },
    })

    wrappers.push(wrapper)

    const rows = wrapper.findAll('[data-row-key]')

    expect(rows).toHaveLength(3)
    expect(rows[0]!.text()).toContain(
      'Hubo un problema al procesar este archivo.',
    )
    expect(rows[1]!.text()).toContain(
      'Se guardaron facturas, pero hubo inconvenientes durante el procesamiento.',
    )
    expect(rows[2]!.text()).toContain(
      'El procesamiento quedó pendiente y puedes volver a intentarlo.',
    )

    for (const row of rows) {
      expect(row.findAll('p')).toHaveLength(2)
    }

    expect(wrapper.text()).not.toContain('INVALID_XML')
    expect(wrapper.text()).not.toContain('nested/')
    expect(wrapper.text()).not.toContain('1'.repeat(49))
    expect(rows[0]!.text()).not.toContain('volver a intentarlo')
    expect(rows[2]!.text()).toContain('Pendiente')
  })

  it('keeps technical details out of retained selections and failed processing activity', () => {
    const technical = 'part/one.xml: INVALID_XML: claveAcceso de 49 dígitos'
    const selection = mount(SelectedFileList, {
      props: {
        open: true,
        files: [
          {
            id: 'pending',
            file: new File(['xml'], 'pending.zip'),
            failure: technical,
          },
        ],
      },
    })
    const activity = mount(BatchActivityPanel, {
      props: {
        activity: {
          operation: 'processing',
          phase: 'failed',
          metric: 'finished',
          completed: 0,
          total: 1,
          message: technical,
        },
      },
    })

    wrappers.push(selection, activity)
    expect(selection.text()).toContain(
      'El procesamiento quedó pendiente y puedes volver a intentarlo.',
    )
    expect(activity.text()).toContain(
      'Hubo un problema al procesar los archivos.',
    )
    expect(selection.text()).not.toContain(technical)
    expect(activity.text()).not.toContain(technical)
  })
})
