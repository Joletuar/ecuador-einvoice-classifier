// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { invoiceDataFixture, invoiceFixture } from './fixtures/invoices'
import { readyProcessing } from './fixtures/processing'
import {
  useFileSelection,
  type SelectionStorage,
} from '../src/features/upload/composables/useFileSelection'
import { useUploadProcessing } from '../src/features/upload/composables/useUploadProcessing'
import {
  reconcileSelection,
  type SelectedFile,
} from '../src/features/upload/model/selection'
import { createUnavailableProcessingService } from '../src/features/upload/services/unavailableProcessingService'
import type { StorageLimits } from '../src/app/config/storageLimits'
import type {
  ProcessingService,
  ProcessingOptions,
  FileProcessingResult,
  ProcessingOutcome,
} from '../src/features/upload/services/processingService'
import type { Result } from '../src/shared/lib/result'
import { summarizeResults } from '../src/features/upload/model/processingLedger'

const wrappers: { unmount(): void }[] = []

beforeEach(() => {
  let frame = 0
  const cancelled = new Set<number>()

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frame

    queueMicrotask(() => {
      if (!cancelled.has(id)) {
        callback(0)
      }
    })

    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => cancelled.add(id))
})
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount())
  vi.unstubAllGlobals()
})

function host<T>(setup: () => T) {
  let value: T | undefined
  const wrapper = mount(
    defineComponent({
      setup() {
        value = setup()

        return () => h('div')
      },
    }),
  )

  wrappers.push(wrapper)

  return {
    wrapper,

    get value() {
      if (value === undefined) {
        throw new Error('Missing composable')
      }

      return value
    },
  }
}

function file(id: string): SelectedFile {
  return { id, file: new File(['xml'], `${id}.xml`) }
}

function selectionHost(
  limits: StorageLimits,
  getStorage: () => SelectionStorage = () => ({
    ready: true,
    files: 0,
    sourceIds: [],
    sourceNames: [],
  }),
) {
  return host(() => useFileSelection(limits, getStorage))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })

  return { promise, resolve }
}

function saved(entry: SelectedFile, retryable = false): FileProcessingResult {
  return {
    id: entry.id,
    name: entry.file.name,
    status: 'added',
    invoices: [invoiceFixture()],
    message: 'Guardada',
    retryable,
  }
}

function processingHost(service: ProcessingService, entries: SelectedFile[]) {
  let selection = [...entries]
  const publish = vi.fn()
  const finished = vi.fn()
  const setup = host(() =>
    useUploadProcessing(service, {
      publish,
      finished,

      reconcileSelection(results, pending) {
        selection = reconcileSelection(selection, results, pending)
      },
    }),
  )

  return {
    ...setup,
    publish,
    finished,

    get selection() {
      return selection
    },

    job: setup.value,
  }
}

describe('local file selection workflow', () => {
  it.each([0, 50])(
    'cancels admission after %i new files and keeps only accepted files without resuming',
    async (accepted) => {
      const selection = selectionHost({
        maxFiles: 500,
        maxTotalBytes: 104857600,
      }).value
      const previous = file('previous').file

      await selection.add([previous])

      const incoming = Array.from(
        { length: 200 },
        (_, index) => file(`new-${index}`).file,
      )
      let cancelled = false
      const stop = watch(
        () =>
          accepted === 0
            ? selection.activity.value.phase
            : selection.files.value.length,
        (value) => {
          if (
            !cancelled &&
            (accepted === 0 ? value === 'loading' : value === accepted + 1)
          ) {
            cancelled = true
            selection.cancel()
          }
        },
        { flush: 'sync' },
      )

      await selection.add(incoming)

      stop()

      await flushPromises()

      expect(selection.files.value.map((entry) => entry.file)).toEqual([
        previous,
        ...incoming.slice(0, accepted),
      ])
      expect(selection.files.value.every((entry) => !entry.unresolved)).toBe(
        true,
      )
      expect(selection.activity.value).toMatchObject({
        phase: 'cancelled',
        completed: accepted,
        total: 200,
      })
      expect(selection.busy.value).toBe(false)

      const later = file('later').file

      await selection.add([later])

      expect(selection.files.value.map((entry) => entry.file)).toEqual([
        previous,
        ...incoming.slice(0, accepted),
        later,
      ])
    },
  )

  it('requires ready storage before admitting files and schedules no work while unavailable', async () => {
    const selection = selectionHost(
      { maxFiles: 10000, maxTotalBytes: 100 },
      () => ({ ready: false }),
    ).value
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')

    await selection.add([file('a').file])

    expect(selection.files.value).toEqual([])
    expect(selection.busy.value).toBe(false)
    expect(selection.activity.value).toMatchObject({
      phase: 'failed',
      total: 0,
    })
    expect(frames).not.toHaveBeenCalled()
    expect(selection.validate()).toMatchObject({
      ok: false,
      code: 'storage-unavailable',
    })
  })

  it('checks selection limits while leaving canonical storage quota to the writer session', async () => {
    let storage: SelectionStorage = {
      ready: true,
      files: 9998,
      sourceIds: ['stored'],
      sourceNames: ['stored.xml'],
    }
    const selection = selectionHost(
      { maxFiles: 10000, maxTotalBytes: 1 },
      () => storage,
    ).value

    selection.replace([file('stored'), file('pending')])

    await selection.add([file('last').file])

    expect(selection.files.value).toHaveLength(3)
    expect(selection.validate().ok).toBe(true)

    storage = {
      ready: true,
      files: 9999,
      sourceIds: ['stored'],
      sourceNames: ['stored.xml'],
    }

    expect(selection.validate().ok).toBe(true)

    const previous = selection.files.value
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')

    frames.mockClear()

    await selection.add([file('overflow').file])

    expect(selection.files.value).toHaveLength(previous.length + 1)
    expect(selection.activity.value.phase).toBe('completed')
    expect(frames).toHaveBeenCalled()
    expect(selection.validate().ok).toBe(true)
  })

  it('admits repeated and stored filenames without duplicate feedback and checks unique work before processing', async () => {
    const selection = selectionHost(
      { maxFiles: 4, maxTotalBytes: 1000 },
      () => ({
        ready: true,
        files: 3,
        sourceIds: ['stored'],
        sourceNames: ['stored.xml'],
      }),
    ).value
    const first = new File(['first'], 'new.xml', { lastModified: 1 })

    await selection.add([
      new File(['changed'], 'stored.xml'),
      first,
      new File(['replacement'], 'new.xml', { lastModified: 10 }),
      new File(['duplicate'], 'stored.xml'),
    ])

    expect(selection.files.value).toHaveLength(4)
    expect(selection.files.value[1]?.file).toBe(first)
    expect(selection.notice.value).toBeUndefined()
    expect(selection.activity.value).toMatchObject({
      phase: 'completed',
      completed: 4,
      total: 4,
    })
    expect(selection.validate().ok).toBe(true)

    await selection.add([file('extra').file])

    expect(selection.files.value).toHaveLength(4)
    expect(selection.notice.value).toContain('más de 4')
  })

  it('admits duplicate-only uploads at full storage capacity', async () => {
    const selection = selectionHost(
      { maxFiles: 2, maxTotalBytes: 1000 },
      () => ({
        ready: true,
        files: 2,
        sourceIds: ['stored'],
        sourceNames: ['stored.xml'],
      }),
    ).value

    await selection.add([file('stored').file, file('stored').file])

    expect(selection.files.value).toHaveLength(2)
    expect(selection.notice.value).toBeUndefined()
    expect(selection.validate().ok).toBe(true)
  })

  it('reports real loading counters and preserves accumulated identities', async () => {
    const setup = selectionHost({ maxFiles: 100, maxTotalBytes: 1000 })
    const selection = setup.value
    const progress: string[] = []

    watch(
      selection.activity,
      (next) => progress.push(`${next.phase}:${next.completed}`),
      { flush: 'sync' },
    )

    const incoming = Array.from(
      { length: 50 },
      (_, index) => file(`file-${index}`).file,
    )
    const adding = selection.add(incoming)

    expect(selection.busy.value).toBe(true)
    expect(selection.files.value).toHaveLength(0)

    await adding

    expect(progress).toContain('loading:17')
    expect(selection.activity.value).toMatchObject({
      phase: 'completed',
      completed: 50,
      total: 50,
    })
    expect(selection.activity.value.message).toBeUndefined()

    const firstId = selection.files.value[0]!.id

    await selection.add([file('new').file])

    expect(selection.files.value[0]!.id).toBe(firstId)
    expect(selection.files.value).toHaveLength(51)
    expect(selection.activity.value.total).toBe(1)
  })

  it('rejects the complete incoming batch while preserving previous selection and IDs', async () => {
    const selection = selectionHost({ maxFiles: 2, maxTotalBytes: 9 }).value

    await selection.add([file('old').file])

    const original = selection.files.value[0]

    await selection.add([file('a').file, file('b').file])

    expect(selection.files.value).toEqual([original])
    expect(selection.activity.value).toMatchObject({
      phase: 'failed',
      completed: 0,
      total: 0,
    })
    expect(selection.notice.value).toContain('más de 2')

    await selection.add([new File(['bad'], 'bad.pdf')])

    expect(selection.files.value).toEqual([original])
    expect(selection.notice.value).toContain('XML o ZIP')
  })

  it('rejects excessive unique filenames synchronously without frames, size reads or selection changes', async () => {
    const selection = selectionHost({
      maxFiles: 500,
      maxTotalBytes: 104857600,
    }).value

    await selection.add([file('existing').file])

    const previous = selection.files.value
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')

    frames.mockClear()

    const readSize = vi.fn(() => {
      throw new Error('Size must not be read')
    })
    const incoming = Array.from({ length: 500 }, (_, index) => {
      const file = new File(['xml'], `incoming-${index}.xml`)

      Object.defineProperty(file, 'size', { get: readSize })

      return file
    })

    const phases: string[] = []

    watch(selection.activity, (next) => phases.push(next.phase), {
      flush: 'sync',
    })

    const rejected = selection.add(incoming)

    expect(selection.busy.value).toBe(false)
    expect(selection.activity.value).toMatchObject({
      phase: 'failed',
      completed: 0,
      total: 0,
    })
    expect(phases).toEqual(['failed'])
    expect(frames).not.toHaveBeenCalled()
    expect(readSize).not.toHaveBeenCalled()
    expect(selection.files.value).toBe(previous)

    await rejected

    expect(frames).not.toHaveBeenCalled()
  })

  it('rejects invalid types before loading and accepts raw sizes independently of storage bytes', async () => {
    const selection = selectionHost({ maxFiles: 10, maxTotalBytes: 2 }).value
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')

    frames.mockClear()

    const invalidType = selection.add([new File(['a'], 'a.pdf')])

    expect(selection.activity.value).toMatchObject({
      phase: 'failed',
      total: 0,
    })
    expect(selection.busy.value).toBe(false)
    expect(frames).not.toHaveBeenCalled()

    await invalidType

    await selection.add([new File(['abc'], 'a.xml')])

    expect(selection.activity.value.phase).toBe('completed')
    expect(selection.files.value).toHaveLength(1)
  })

  it('does not mutate an in-flight selection and disposes scheduled frames', async () => {
    const setup = selectionHost({ maxFiles: 10, maxTotalBytes: 100 })
    const selection = setup.value

    await selection.add([file('old').file])

    const id = selection.files.value[0]!.id
    const adding = selection.add([file('new').file])

    selection.remove(id)
    expect(selection.files.value[0]?.id).toBe(id)
    setup.wrapper.unmount()

    await adding

    expect(selection.files.value).toHaveLength(1)
  })

  it('creates distinct selection identities after a route instance is remounted', async () => {
    const first = selectionHost({ maxFiles: 10, maxTotalBytes: 100 }).value
    const second = selectionHost({ maxFiles: 10, maxTotalBytes: 100 }).value
    const source = file('same-name').file

    await first.add([source])
    await second.add([source])

    expect(first.files.value[0]?.id).not.toBe(second.files.value[0]?.id)
  })
})

describe('confirmed processing workflow', () => {
  it('finishes all five outer files when four saves and one duplicate settle before the next frame', async () => {
    const entries = ['duplicate', 'a', 'b', 'c', 'd'].map(file)
    const files: FileProcessingResult[] = [
      {
        id: entries[0]!.id,
        name: entries[0]!.file.name,
        status: 'duplicate',
        duplicateFileName: entries[0]!.file.name,
        message: 'Ya existe un archivo con este nombre.',
      },
      ...entries.slice(1).map((entry): FileProcessingResult => ({
        ...saved(entry),
        status: 'added',
        invoices: [invoiceFixture({ id: `invoice:${entry.id}` })],
      })),
    ]
    const pendingFrames = new Map<number, FrameRequestCallback>()
    let frame = 100
    const setup = processingHost(
      readyProcessing((_inputs, options) => {
        vi.stubGlobal(
          'requestAnimationFrame',
          (callback: FrameRequestCallback) => {
            pendingFrames.set(++frame, callback)

            return frame
          },
        )
        vi.stubGlobal('cancelAnimationFrame', (id: number) =>
          pendingFrames.delete(id),
        )
        options.onFileResult(files[0]!)
        options.onProgress?.({
          name: entries[1]!.file.name,
          completed: 1,
          total: 5,
          stage: 'read',
          xml: {
            knownXml: 1,
            finishedXml: 0,
            savedXml: 0,
            failedXml: 0,
            omittedEntries: 0,
          },
        })
        files.slice(1).forEach(options.onFileResult)

        return {
          ok: true,
          value: { kind: 'completed', files, summary: summarizeResults(files) },
        }
      }),
      entries,
    )
    const completed: number[] = []
    const stop = watch(
      () => setup.job.activity.value.completed,
      (count) => completed.push(count),
      { flush: 'sync' },
    )

    await setup.job.start(entries)

    stop()
    expect(setup.job.confirmedSummary.value).toMatchObject({
      saved: 4,
      duplicates: 1,
    })
    expect(setup.job.activity.value).toMatchObject({
      phase: 'completed',
      completed: 5,
      total: 5,
    })
    expect(completed).toContain(1)
    expect(completed.at(-1)).toBe(5)
    expect(
      completed.every((count, index) => count >= (completed[index - 1] ?? 0)),
    ).toBe(true)
    expect(setup.selection).toEqual([])
  })

  it('keeps cancellation and leave blocking active until the adapter has settled writes', async () => {
    const response = deferred<Result<ProcessingOutcome>>()
    let hooks: ProcessingOptions | undefined
    const adapter = readyProcessing((_inputs, options) => {
      hooks = options

      return response.promise
    })
    const a = file('a')
    const setup = processingHost(adapter, [a])
    const running = setup.job.start([a])

    await flushPromises()

    setup.job.cancel()
    expect(hooks?.signal.aborted).toBe(true)
    expect(setup.job.busy.value).toBe(true)
    expect(setup.job.canCancel.value).toBe(false)
    expect(setup.selection).toEqual([a])

    const result = saved(a, true)

    hooks?.onData?.(invoiceDataFixture([invoiceFixture()]))
    hooks?.onFileResult(result)
    response.resolve({
      ok: true,
      value: { kind: 'cancelled', files: [result], notStartedIds: [] },
    })

    await running

    expect(setup.job.busy.value).toBe(false)
    expect(setup.job.confirmedSummary.value?.saved).toBe(1)
    expect(setup.job.activity.value).toMatchObject({
      phase: 'cancelled',
      completed: 0,
      total: 1,
    })
    expect(setup.selection[0]?.file).toBe(a.file)
    expect(setup.selection[0]?.unresolved).toBeUndefined()
    expect(setup.publish).toHaveBeenCalledTimes(1)
  })
  it('publishes confirmed end-attempt data and removes only completed source selections', async () => {
    const a = file('a')
    const b = file('b')
    const accepted = saved(a)
    const failed: FileProcessingResult = {
      id: b.id,
      name: b.file.name,
      status: 'error',
      message: 'retry',
      retryable: true,
    }
    const setup = processingHost(
      readyProcessing((_inputs, hooks) => {
        hooks.onData?.(invoiceDataFixture([invoiceFixture()]))
        hooks.onFileResult(accepted)
        hooks.onFileResult(failed)

        return {
          ok: true,
          value: {
            kind: 'completed',
            files: [accepted, failed],
            summary: summarizeResults([accepted, failed]),
          },
        }
      }),
      [a, b],
    )

    await setup.job.start([a, b])

    expect(setup.selection.map((x) => x.id)).toEqual(['b'])
    expect(setup.publish).toHaveBeenCalledTimes(1)
    expect(setup.job.outcome.value?.summary.saved).toBe(1)
    expect(setup.job.activity.value).toMatchObject({ completed: 1, total: 2 })
  })
  it('does not remove selections when no writer session could start', async () => {
    const a = file('a')
    const setup = processingHost(
      readyProcessing(() => ({
        ok: false,
        code: 'storage-busy',
        message: 'Otra pestaña está escribiendo.',
      })),
      [a],
    )

    await setup.job.start([a])

    expect(setup.selection).toEqual([a])
    expect(setup.job.notice.value).toContain('Otra pestaña')
    expect(setup.job.confirmedSummary.value).toBeUndefined()
    expect(setup.job.activity.value).toMatchObject({
      phase: 'failed',
      completed: 0,
      total: 1,
    })
  })
  it('shows unavailable preparation without scheduling persistence or clearing selection', async () => {
    const a = file('a')
    const setup = processingHost(createUnavailableProcessingService(), [a])

    await setup.job.start([a])

    expect(setup.job.activity.value.phase).toBe('unavailable')
    expect(setup.selection).toEqual([a])
    expect(setup.publish).not.toHaveBeenCalled()
  })
  it('uses each attempt denominator and clears obsolete outcomes for the new attempt', async () => {
    const a = file('a')
    const b = file('b')
    const setup = processingHost(
      readyProcessing((inputs, hooks) => {
        const files = inputs.map((x) => saved(x))

        files.forEach(hooks.onFileResult)

        return {
          ok: true,
          value: { kind: 'completed', files, summary: summarizeResults(files) },
        }
      }),
      [a, b],
    )

    await setup.job.start([a, b])

    expect(setup.job.activity.value.total).toBe(2)

    await setup.job.start([b])

    expect(setup.job.activity.value.total).toBe(1)
    expect(setup.job.attemptId.value).toBe(2)
  })
  it('disposes selection contexts and aborts an active operation without publishing late state', async () => {
    const response = deferred<Result<ProcessingOutcome>>()
    let hooks: ProcessingOptions | undefined
    const a = file('a')
    const forgetSelection = vi.fn()
    const adapter = {
      ...readyProcessing((_inputs, options) => {
        hooks = options

        return response.promise
      }),
      forgetSelection,
    }
    const setup = processingHost(adapter, [a])
    const running = setup.job.start([a])

    await flushPromises()

    setup.wrapper.unmount()
    expect(hooks?.signal.aborted).toBe(true)
    hooks?.onData?.(invoiceDataFixture([invoiceFixture()]))
    response.resolve({ ok: true, value: { kind: 'cancelled', files: [] } })

    await running

    expect(setup.publish).not.toHaveBeenCalled()
    expect(forgetSelection).toHaveBeenCalled()
  })
})
