import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteDB, openDB } from 'idb'
import { createIndexedDbInvoiceService } from '../src/features/invoices/services/indexedDbInvoiceService'
import type {
  InvoiceCommit,
  InvoiceService,
  InvoiceImportSession,
} from '../src/features/invoices/services/invoiceService'
import type {
  InvoiceRecord,
  LocalPersistenceSnapshot,
} from '../src/features/invoices/domain/persistenceRecords'
import {
  permitsStorageChange,
  persistenceUsage,
  serializedRecordBytes,
} from '../src/features/invoices/domain/storageModel'
import {
  cloneInvoiceRecord,
  validateInvoiceRecord,
  validateModelPackageRecord,
  validatePersistenceSnapshot,
} from '../src/features/invoices/domain/persistenceValidation'
import { amountToCents } from '../src/features/invoices/domain/invoiceProjection'
import {
  storageConcept,
  storageInvoice,
  storagePackage,
  storageSource,
  testCoordinator,
  testRecalculate,
} from './fixtures/storageFixtures'

const services: InvoiceService[] = []
const names: string[] = []
let sequence = 0

function databaseName() {
  const name = `canonical-storage-${++sequence}`

  names.push(name)

  return name
}

function adapter(
  options: Parameters<typeof createIndexedDbInvoiceService>[1] = {},
  limits = { maxFiles: 10000, maxTotalBytes: 104857600 },
) {
  const service = createIndexedDbInvoiceService(limits, {
    databaseName: options.databaseName ?? databaseName(),
    coordinator: testCoordinator(),
    recalculate: testRecalculate,
    ...options,
  })

  services.push(service)

  return service
}

async function read(service: InvoiceService) {
  const result = await service.read()

  if (!result.ok) {
    throw new Error(result.message)
  }

  return result.value
}

function payload(overrides: Partial<InvoiceCommit> = {}): InvoiceCommit {
  const source = overrides.source ?? storageSource()
  const modelPackage = overrides.modelPackage ?? storagePackage()

  return {
    source,
    modelPackage,
    invoice: storageInvoice(source, modelPackage),
    ...overrides,
  }
}

async function append(service: InvoiceService, input = payload()) {
  const result = await service.withImportSession((session) =>
    session.commit(input),
  )

  if (!result.ok) {
    return result
  }

  return result.value
}

async function records(name: string): Promise<LocalPersistenceSnapshot> {
  const db = await openDB(name)

  const tx = db.transaction(['imports', 'invoices', 'modelPackages'])

  const [imports, invoices, modelPackages] = await Promise.all([
    tx.objectStore('imports').getAll(),
    tx.objectStore('invoices').getAll(),
    tx.objectStore('modelPackages').getAll(),
  ])

  await tx.done

  db.close()

  return { imports, invoices, modelPackages }
}

afterEach(async () => {
  vi.restoreAllMocks()

  for (const service of services.splice(0)) {
    service.dispose?.()
  }

  for (const name of names.splice(0)) {
    await deleteDB(name)
  }
})

describe('canonical persistence', () => {
  it('uses the current database namespace and retains real imports when reopened', async () => {
    const name = 'facturas-locales'

    names.push(name)

    const service = createIndexedDbInvoiceService(
      { maxFiles: 100, maxTotalBytes: 1_000_000 },
      { coordinator: testCoordinator() },
    )

    services.push(service)
    expect((await read(service)).invoices).toEqual([])
    expect((await append(service)).ok).toBe(true)
    service.dispose?.()

    const reopened = createIndexedDbInvoiceService(
      { maxFiles: 100, maxTotalBytes: 1_000_000 },
      { coordinator: testCoordinator() },
    )

    services.push(reopened)
    expect((await read(reopened)).invoices).toHaveLength(1)

    const db = await openDB(name)

    expect(db.version).toBe(1)
    expect((await db.getAll('invoices'))[0].accessKey).toBe(
      payload().invoice.accessKey,
    )
    db.close()
  })

  it('preserves buyer identity and issuer RUC through DB reload and category edits', async () => {
    const name = databaseName()
    const service = adapter({ databaseName: name })
    const invoice = storageInvoice(undefined, undefined, {
      issuer: {
        legalName: 'Legal',
        tradeName: 'Comercial',
        ruc: '0012345678001',
      },
      buyer: { name: 'Ana & José', identification: '00AB-09/XYZ' },
    })

    expect((await append(service, payload({ invoice }))).ok).toBe(true)
    expect((await records(name)).invoices[0]).toEqual(invoice)
    service.dispose?.()

    const reopened = adapter({ databaseName: name })
    const projected = (await read(reopened)).invoices[0]

    expect(projected).toMatchObject({
      issuer: 'Comercial',
      issuerRuc: '0012345678001',
      buyerName: 'Ana & José',
      buyerIdentification: '00AB-09/XYZ',
    })
    expect(
      (
        await reopened.correct({
          invoiceId: invoice.id,
          conceptId: invoice.concepts[0].id,
          selection: { mode: 'manual', category: 'Alimentación' },
          expectedRevision: 1,
        })
      ).ok,
    ).toBe(true)
    expect(
      (
        await reopened.correctInvoiceCategory({
          invoiceId: invoice.id,
          selection: { mode: 'manual', category: null },
          expectedRevision: 2,
        })
      ).ok,
    ).toBe(true)

    const saved = (await records(name)).invoices[0]!

    expect(saved.issuer).toEqual(invoice.issuer)
    expect(saved.buyer).toEqual(invoice.buyer)
    expect(saved.revision).toBe(3)
    expect((await read(reopened)).usage).toEqual(
      persistenceUsage(await records(name)),
    )
    reopened.dispose?.()
    expect(
      (await read(adapter({ databaseName: name }))).invoices[0],
    ).toMatchObject({
      buyerName: 'Ana & José',
      buyerIdentification: '00AB-09/XYZ',
      issuerRuc: '0012345678001',
      revision: 3,
    })
  })

  it('accepts absent optional identity fields without changing canonical bytes', async () => {
    const name = databaseName()
    const service = adapter({ databaseName: name })
    const invoice = storageInvoice()
    const serialized = JSON.stringify(invoice)
    const cloned = cloneInvoiceRecord(invoice)

    expect(validateInvoiceRecord(invoice)).toBe(true)
    expect(JSON.stringify(cloned)).toBe(serialized)
    expect(serializedRecordBytes(cloned)).toBe(serializedRecordBytes(invoice))
    expect((await append(service, payload({ invoice }))).ok).toBe(true)
    service.dispose?.()
    expect(
      (await read(adapter({ databaseName: name }))).invoices[0],
    ).toMatchObject({
      buyerName: null,
      buyerIdentification: null,
      issuerRuc: null,
    })
    expect(JSON.stringify((await records(name)).invoices[0])).toBe(serialized)
    expect(validateInvoiceRecord({ ...invoice, buyer: null })).toBe(false)
    expect(
      validateInvoiceRecord({
        ...invoice,
        buyer: { name: null, identification: 123 },
      }),
    ).toBe(false)
    expect(
      validateInvoiceRecord({
        ...invoice,
        issuer: { ...invoice.issuer, ruc: 123 },
      }),
    ).toBe(false)
  })

  it('creates the current schema directly with three stores and the declared unique indexes', async () => {
    const name = databaseName()
    const service = adapter({ databaseName: name })

    expect((await read(service)).usage).toEqual({ files: 0, bytes: 0 })

    const db = await openDB(name)

    expect(db.version).toBe(1)
    expect([...db.objectStoreNames]).toEqual([
      'imports',
      'invoices',
      'modelPackages',
    ])

    const tx = db.transaction(['imports', 'invoices'])

    expect(tx.objectStore('imports').index('byName').unique).toBe(false)
    expect(tx.objectStore('invoices').index('byAccessKey').unique).toBe(true)
    expect(tx.objectStore('invoices').index('byImportEntry').unique).toBe(true)
    expect([...tx.objectStore('invoices').indexNames]).toEqual([
      'byAccessKey',
      'byImport',
      'byImportEntry',
      'byModelPackage',
    ])

    await tx.done

    db.close()
  })

  it('stores source + metadata + one invoice atomically and counts canonical JSON once', async () => {
    const name = databaseName()
    const service = adapter({ databaseName: name })
    const input = payload({
      source: storageSource({ originalBytes: Number.MAX_SAFE_INTEGER }),
    })

    const saved = await append(service, input)

    expect(saved.ok).toBe(true)

    const data = await read(service)
    const canonical = await records(name)

    expect(canonical.imports).toEqual([input.source])
    expect(canonical.invoices).toEqual([input.invoice])
    expect(canonical.modelPackages).toEqual([input.modelPackage])
    expect(data.usage).toEqual(persistenceUsage(canonical))
    expect(data.usage.bytes).toBe(
      new TextEncoder().encode(
        [
          ...canonical.imports,
          ...canonical.invoices,
          ...canonical.modelPackages,
        ]
          .map((record) => JSON.stringify(record))
          .join(''),
      ).byteLength,
    )
    expect(data.usage.bytes).toBeLessThan(10000)
    expect(data.invoices[0]?.number).toBe('001-002-000000012')
  })

  it('rejects invalid references, foreign fields and package metadata collisions', async () => {
    const service = adapter()
    const badFk = payload()

    badFk.invoice = { ...badFk.invoice, importId: 'wrong' }
    expect(await append(service, badFk)).toMatchObject({
      ok: false,
      code: 'invalid-payload',
    })
    expect(
      await append(service, {
        ...payload(),
        invoice: { ...storageInvoice(), unknown: true },
      } as unknown as InvoiceCommit),
    ).toMatchObject({ ok: false, code: 'invalid-payload' })
    expect((await read(service)).usage).toEqual({ files: 0, bytes: 0 })
    expect((await append(service)).ok).toBe(true)

    const source = storageSource({ id: 'source-2', name: 'other.xml' })
    const pack = { ...storagePackage(), ortVersion: 'other' }

    expect(
      await append(service, {
        source,
        modelPackage: pack,
        invoice: storageInvoice(source, pack, { id: 'invoice-2' }),
      }),
    ).toMatchObject({ ok: false, code: 'invalid-payload' })
    expect((await read(service)).invoices).toHaveLength(1)
  })

  it('rolls back parents when the invoice transaction fails after add', async () => {
    const name = databaseName()
    const service = adapter({ databaseName: name })

    await read(service)

    const original = IDBObjectStore.prototype.add

    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      ...args
    ) {
      const request = original.apply(this, args)

      if (this.name === 'invoices') {
        request.addEventListener('success', () => request.transaction!.abort())
      }

      return request
    })
    expect((await append(service)).ok).toBe(false)
    expect(await records(name)).toEqual({
      imports: [],
      invoices: [],
      modelPackages: [],
    })
  })

  it('keeps append idempotent after corrections and reuses one metadata record', async () => {
    const name = databaseName()
    const service = adapter({ databaseName: name })
    const source = storageSource({ kind: 'zip', name: 'batch.zip' })
    const first = payload({ source })

    expect((await append(service, first)).ok).toBe(true)
    expect(
      (
        await service.correct({
          invoiceId: first.invoice.id,
          conceptId: first.invoice.concepts[0].id,
          selection: { mode: 'manual', category: 'Vivienda' },
        })
      ).ok,
    ).toBe(true)

    const duplicate = await append(service, first)

    expect(duplicate).toMatchObject({
      ok: true,
      value: {
        status: 'already_saved',
        revision: 2,
        invoice: {
          concepts: [{ category: 'Vivienda', selectionMode: 'manual' }],
        },
      },
    })

    const second = {
      ...first,
      invoice: storageInvoice(source, first.modelPackage, {
        id: 'invoice-2',
        entryIndex: 1,
        entryPath: 'second.xml',
      }),
    }

    expect((await append(service, second)).ok).toBe(true)

    const canonical = await records(name)

    expect(canonical.imports).toHaveLength(1)
    expect(canonical.invoices).toHaveLength(2)
    expect(canonical.modelPackages).toHaveLength(1)
    expect((await read(service)).usage).toEqual(persistenceUsage(canonical))
  })

  it('allows repeated filenames and releases unused sources and packages', async () => {
    const service = adapter()

    expect((await append(service)).ok).toBe(true)

    const collision = storageSource({ id: 'different' })

    expect(
      await append(
        service,
        payload({
          source: collision,
          invoice: storageInvoice(collision, storagePackage(), {
            id: 'second',
          }),
        }),
      ),
    ).toMatchObject({ ok: true, value: { status: 'saved' } })

    const capital = storageSource({ id: 'capital', name: 'Invoice.xml' })

    expect(
      (
        await append(
          service,
          payload({
            source: capital,
            invoice: storageInvoice(capital, storagePackage(), {
              id: 'capital-invoice',
            }),
          }),
        )
      ).ok,
    ).toBe(true)
    expect((await service.remove('invoice-1')).ok).toBe(true)
    expect((await read(service)).sourceNames).toEqual([
      'Invoice.xml',
      'invoice.xml',
    ])
    expect((await service.remove('second')).ok).toBe(true)
    expect((await service.remove('capital-invoice')).ok).toBe(true)
    expect((await read(service)).usage).toEqual({ files: 0, bytes: 0 })
    expect((await append(service)).ok).toBe(true)
  })

  it('retains an origin and model until their last ZIP sibling is deleted', async () => {
    const name = databaseName()
    const service = adapter({ databaseName: name })
    const source = storageSource({ kind: 'zip', name: 'siblings.zip' })
    const modelPackage = storagePackage()

    await append(service, {
      source,
      modelPackage,
      invoice: storageInvoice(source, modelPackage),
    })
    await append(service, {
      source,
      modelPackage,
      invoice: storageInvoice(source, modelPackage, {
        id: 'sibling',
        entryIndex: 1,
        entryPath: 'sibling.xml',
      }),
    })
    await service.remove('invoice-1')

    const remaining = await records(name)

    expect(remaining.imports).toEqual([source])
    expect(remaining.modelPackages).toEqual([modelPackage])
    expect(remaining.invoices.map((invoice) => invoice.id)).toEqual(['sibling'])

    const duplicate = storageSource({
      id: 'new-origin',
      kind: 'zip',
      name: 'siblings.zip',
    })

    expect(
      await append(
        service,
        payload({
          source: duplicate,
          invoice: storageInvoice(duplicate, modelPackage, {
            id: 'new-invoice',
          }),
        }),
      ),
    ).toMatchObject({ ok: true, value: { status: 'saved' } })

    await service.remove('sibling')
    await service.remove('new-invoice')

    expect(await records(name)).toEqual({
      imports: [],
      invoices: [],
      modelPackages: [],
    })
  })

  it('enforces exact byte/file limits atomically and permits reducing already excessive data', async () => {
    const input = payload()
    const bytes =
      serializedRecordBytes(input.source) +
      serializedRecordBytes(input.modelPackage) +
      serializedRecordBytes(input.invoice)
    const tight = adapter({}, { maxFiles: 1, maxTotalBytes: bytes - 1 })

    expect(await append(tight, input)).toMatchObject({
      ok: false,
      code: 'storage-limit',
    })
    expect((await read(tight)).usage.bytes).toBe(0)

    const name = databaseName()
    const first = adapter(
      { databaseName: name },
      { maxFiles: 1, maxTotalBytes: bytes },
    )

    expect((await append(first, input)).ok).toBe(true)

    const extraSource = storageSource({ id: 'extra', name: 'extra.xml' })

    expect(
      await append(
        first,
        payload({
          source: extraSource,
          invoice: storageInvoice(extraSource, input.modelPackage, {
            id: 'extra-invoice',
          }),
        }),
      ),
    ).toMatchObject({ ok: false, code: 'storage-limit' })

    const lower = adapter(
      { databaseName: name },
      { maxFiles: 1, maxTotalBytes: 1 },
    )

    expect((await lower.remove('invoice-1')).ok).toBe(true)
    expect((await read(lower)).usage.bytes).toBe(0)
    expect(
      permitsStorageChange(
        { files: 3, bytes: 300 },
        { files: 2, bytes: 250 },
        { maxFiles: 1, maxTotalBytes: 100 },
      ),
    ).toBe(true)
    expect(
      permitsStorageChange(
        { files: 3, bytes: 300 },
        { files: 2, bytes: 301 },
        { maxFiles: 1, maxTotalBytes: 100 },
      ),
    ).toBe(false)
  })

  it('clears all canonical stores without touching classifier resources', async () => {
    const name = databaseName()
    const service = adapter({ databaseName: name })

    await append(service)

    const cache = { delete: vi.fn() }

    vi.stubGlobal('caches', cache)
    expect(await service.clearAll()).toMatchObject({
      ok: true,
      value: { usage: { files: 0, bytes: 0 } },
    })
    expect(await records(name)).toEqual({
      imports: [],
      invoices: [],
      modelPackages: [],
    })
    expect(cache.delete).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('corrections and revision checks', () => {
  it('preserves original predictions/initial rule, supports manual null and restores modes even when labels match', async () => {
    const name = databaseName()
    const service = adapter({ databaseName: name })
    const input = payload()

    await append(service, input)

    expect(
      (
        await service.correct({
          invoiceId: 'invoice-1',
          conceptId: 'concept-0',
          selection: { mode: 'manual', category: 'Salud' },
        })
      ).ok,
    ).toBe(true)
    expect((await read(service)).invoices[0]?.concepts[0]).toMatchObject({
      category: 'Salud',
      original: 'Salud',
      selectionMode: 'manual',
    })
    expect(
      (
        await service.correct({
          invoiceId: 'invoice-1',
          conceptId: 'concept-0',
          selection: { mode: 'manual', category: null },
        })
      ).ok,
    ).toBe(true)
    expect((await read(service)).invoices[0]).toMatchObject({
      principal: 'Sin clasificar',
      automatic: { status: 'unassigned' },
      concepts: [{ category: 'Sin clasificar', selectionMode: 'manual' }],
    })
    expect(
      (
        await service.correct({
          invoiceId: 'invoice-1',
          conceptId: 'concept-0',
          selection: { mode: 'model' },
        })
      ).ok,
    ).toBe(true)

    const record = (await records(name)).invoices[0]!

    expect(record.concepts[0].prediction).toEqual(
      input.invoice.concepts[0].prediction,
    )
    expect(record.classification.initial).toEqual(
      input.invoice.classification.initial,
    )
    expect(record.concepts[0].selection).toEqual({ mode: 'model' })
    expect(record.revision).toBe(4)
  })

  it('preserves manual principal priority and restores automatic from CURRENT concepts', async () => {
    const service = adapter()

    await append(service)
    await service.correctInvoiceCategory({
      invoiceId: 'invoice-1',
      selection: { mode: 'manual', category: 'Salud' },
    })
    await service.correct({
      invoiceId: 'invoice-1',
      conceptId: 'concept-0',
      selection: { mode: 'manual', category: 'Alimentación' },
    })

    expect((await read(service)).invoices[0]).toMatchObject({
      principal: 'Salud',
      principalMode: 'manual',
      automatic: { category: 'Alimentación' },
    })

    await service.correctInvoiceCategory({
      invoiceId: 'invoice-1',
      selection: { mode: 'manual', category: null },
    })

    expect((await read(service)).invoices[0]).toMatchObject({
      principal: 'Sin clasificar',
      principalMode: 'manual',
    })

    await service.correctInvoiceCategory({
      invoiceId: 'invoice-1',
      selection: { mode: 'automatic' },
    })

    expect((await read(service)).invoices[0]).toMatchObject({
      principal: 'Alimentación',
      originalPrincipal: 'Salud',
      principalMode: 'automatic',
    })
  })

  it('rejects stale user revisions without calling Worker or overwriting data', async () => {
    const recalculate = vi.fn(testRecalculate)
    const service = adapter({ recalculate })

    await append(service)
    await service.correct({
      invoiceId: 'invoice-1',
      conceptId: 'concept-0',
      selection: { mode: 'manual', category: 'Vivienda' },
      expectedRevision: 1,
    })

    expect(
      await service.correct({
        invoiceId: 'invoice-1',
        conceptId: 'concept-0',
        selection: { mode: 'model' },
        expectedRevision: 1,
      }),
    ).toMatchObject({ ok: false, code: 'storage-conflict' })
    expect(recalculate).toHaveBeenCalledTimes(1)
    expect((await read(service)).invoices[0]?.concepts[0]?.category).toBe(
      'Vivienda',
    )
  })

  it('does Worker recalculation outside transactions and detects a CAS race', async () => {
    const name = databaseName()
    const service = adapter({
      databaseName: name,

      recalculate: async (input) => {
        const db = await openDB(name)

        const tx = db.transaction('invoices', 'readwrite')

        const latest = (await tx.store.get(input.invoiceId)) as InvoiceRecord

        await tx.store.put({ ...latest, revision: latest.revision + 1 })
        await tx.done

        db.close()

        return testRecalculate(input)
      },
    })

    await append(service)

    expect(
      await service.correct({
        invoiceId: 'invoice-1',
        conceptId: 'concept-0',
        selection: { mode: 'manual', category: 'Otros' },
      }),
    ).toMatchObject({ ok: false, code: 'storage-conflict' })
    expect((await read(service)).invoices[0]?.concepts[0]?.category).toBe(
      'Salud',
    )
  })

  it('rejects failed or wrong-revision recalculation without writes', async () => {
    const name = databaseName()
    const service = adapter({
      databaseName: name,

      recalculate: async (input) => ({
        ...(await testRecalculate(input)),
        expectedRevision: 999,
      }),
    })

    await append(service)

    const before = await records(name)

    expect(
      await service.correctInvoiceCategory({
        invoiceId: 'invoice-1',
        selection: { mode: 'manual', category: null },
      }),
    ).toMatchObject({ ok: false, code: 'rules-failed' })
    expect(await records(name)).toEqual(before)
  })
})

describe('sessions and projection', () => {
  it('holds a shared writer lock through callback and all outstanding commits', async () => {
    const name = databaseName()
    const coordinator = testCoordinator()
    const service = adapter({ databaseName: name, coordinator })
    const other = adapter({ databaseName: name, coordinator })
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    let session!: InvoiceImportSession
    const attempt = service.withImportSession(async (current) => {
      session = current
      expect(current.sourceNames).toEqual([])
      started()

      await gate

      void current.commit(payload())

      return 'finished'
    })

    await ready

    expect(await coordinator.isBusy()).toBe(true)
    expect(await other.clearAll()).toMatchObject({
      ok: false,
      code: 'storage-busy',
    })
    expect((await read(other)).usage.files).toBe(0)
    release()
    expect(await attempt).toEqual({ ok: true, value: 'finished' })
    expect(await coordinator.isBusy()).toBe(false)
    expect((await read(other)).usage.files).toBe(1)
    expect(await session.commit(payload())).toMatchObject({
      ok: false,
      code: 'storage-session-closed',
    })
    expect(
      await other.withImportSession(async (current) => current.sourceNames),
    ).toEqual({ ok: true, value: ['invoice.xml'] })
  })

  it('loads/serializes existing records once per processing session, not per XML', async () => {
    const name = databaseName()
    const service = adapter({ databaseName: name })
    const source = storageSource({ kind: 'zip', name: 'many.zip' })
    const pack = storagePackage()

    await read(service)

    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll')

    const attempt = await service.withImportSession(async (session) => {
      for (let index = 0; index < 8; index++) {
        const result = await session.commit({
          source,
          modelPackage: pack,
          invoice: storageInvoice(source, pack, {
            id: `i-${index}`,
            entryIndex: index,
            entryPath: `${index}.xml`,
          }),
        })

        expect(result.ok).toBe(true)
      }

      expect(session.findSaved(source.id, 6)?.id).toBe('i-6')

      return session.snapshot()
    })

    expect(attempt).toMatchObject({
      ok: true,
      value: { usage: { files: 1 }, invoices: expect.any(Array) },
    })
    expect(getAll).toHaveBeenCalledTimes(3)
  })

  it('preserves unavailable fields, exact amounts, blank description and stored class order', async () => {
    const service = adapter()
    const pack = storagePackage([
      'Vivienda',
      'Vestimenta',
      'Turismo Nacional',
      'Otros',
      'Salud',
      'Educación, Arte y Cultura',
      'Alimentación',
    ])
    const source = storageSource()
    const concept = {
      ...storageConcept(),
      description: '',
      netAmount: { raw: '12.345', decimal: '12.345' },
    } as const
    const invoice = storageInvoice(source, pack, {
      issuer: { legalName: null, tradeName: null },
      number: {
        establishment: '001',
        pointOfIssue: null,
        sequential: '000012',
      },
      date: { raw: 'invalid', iso: null },
      currency: { raw: 'EUR', code: null },
      total: { raw: '9999999999999999999', decimal: '9999999999999999999' },
      concepts: [concept],
    })

    expect(
      (await append(service, { source, modelPackage: pack, invoice })).ok,
    ).toBe(true)
    expect((await read(service)).invoices[0]).toMatchObject({
      issuer: null,
      number: null,
      date: null,
      dateRaw: 'invalid',
      total: null,
      currency: { code: null },
      concepts: [
        { name: '', descriptionPresent: true, cents: null, original: 'Otros' },
      ],
    })
    expect(amountToCents({ raw: '-0.0100', decimal: '-0.0100' })).toBe(-1)
    expect(amountToCents({ raw: '0.001', decimal: '0.001' })).toBeNull()
  })

  it('keeps confirmed commits when an import observer fails and releases its session', async () => {
    const coordinator = testCoordinator()
    const service = adapter({ coordinator })

    const result = await service.withImportSession(async (session) => {
      expect((await session.commit(payload())).ok).toBe(true)

      throw new Error('observer failure')
    })

    expect(result.ok).toBe(false)
    expect(await coordinator.isBusy()).toBe(false)
    expect((await read(service)).invoices).toHaveLength(1)
    expect((await append(service)).ok).toBe(true)
  })

  it('preserves a missing description as status 1 rather than a blank known description', async () => {
    const source = storageSource()
    const modelPackage = storagePackage()
    const service = adapter()
    const prediction = {
      status: 1,
      categoryIndex: -1,
      probabilities: [0, 0, 0, 0, 0, 0, 0],
    } as const
    const rule = {
      rulesVersion: 'DN-0001@2026-11-03',
      status: 'unassigned',
      category: null,
      criterion: null,
      reason: 'NO_CLASSIFIED_CONCEPTS',
    } as const
    const invoice = storageInvoice(source, modelPackage, {
      concepts: [
        {
          id: 'missing',
          position: 0,
          descriptionPresent: false,
          description: null,
          prediction,
          selection: { mode: 'model' },
          netAmount: { raw: null, decimal: null },
        },
      ],
      classification: {
        initial: rule,
        automatic: rule,
        selection: { mode: 'automatic' },
      },
    })

    expect((await append(service, { source, modelPackage, invoice })).ok).toBe(
      true,
    )
    expect((await read(service)).invoices[0]?.concepts[0]).toMatchObject({
      name: null,
      descriptionPresent: false,
      category: 'Sin clasificar',
      prediction,
    })
  })

  it('validates conditional prediction/description/manual modes and rejects extra nested fields', () => {
    const invoice = storageInvoice()

    expect(validateInvoiceRecord(invoice)).toBe(true)
    expect(
      validateInvoiceRecord({
        ...invoice,
        concepts: [
          {
            ...invoice.concepts[0],
            prediction: {
              status: 0,
              categoryIndex: 0,
              probabilities: Array(7),
            },
          },
        ],
      }),
    ).toBe(false)
    expect(
      validatePersistenceSnapshot({
        imports: [storageSource()],
        invoices: [invoice],
        modelPackages: [storagePackage()],
      }),
    ).toBe(true)
    expect(
      validateInvoiceRecord({
        ...invoice,
        concepts: [{ ...invoice.concepts[0], descriptionPresent: false }],
      }),
    ).toBe(false)
    expect(
      validateInvoiceRecord({
        ...invoice,
        concepts: [
          {
            ...invoice.concepts[0],
            prediction: {
              status: 1,
              categoryIndex: -1,
              probabilities: [0, 0, 0, 0, 0, 0, 0],
            },
          },
        ],
      }),
    ).toBe(false)
    expect(
      validateInvoiceRecord({
        ...invoice,
        concepts: [{ ...invoice.concepts[0], position: 2 }],
      }),
    ).toBe(false)
    expect(
      validateInvoiceRecord({ ...invoice, total: { raw: null, decimal: '0' } }),
    ).toBe(false)
    expect(
      validateInvoiceRecord({
        ...invoice,
        issuer: { ...invoice.issuer, secret: 'no' },
      }),
    ).toBe(false)
    expect(
      validateModelPackageRecord({
        ...storagePackage(),
        classes: [
          'Salud',
          'Salud',
          'Otros',
          'Vivienda',
          'Vestimenta',
          'Alimentación',
          'Turismo Nacional',
        ],
      }),
    ).toBe(false)

    const clone = cloneInvoiceRecord(invoice)

    expect(clone).toEqual(invoice)
    expect(clone.concepts).not.toBe(invoice.concepts)
    expect(clone.concepts[0].prediction.probabilities).not.toBe(
      invoice.concepts[0].prediction.probabilities,
    )
  })
})
