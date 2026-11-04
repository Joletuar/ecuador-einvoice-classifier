import { describe, expect, it } from 'vitest'
import { invoiceFixture } from './fixtures/invoices'
import {
  createProcessingLedger,
  summarizeResults,
} from '../src/features/upload/model/processingLedger'
import {
  reconcileSelection,
  validateSelection,
  type SelectedFile,
} from '../src/features/upload/model/selection'
import type { FileProcessingResult } from '../src/features/upload/services/processingService'

function input(id: string, name = `${id}.xml`): SelectedFile {
  return { id, file: new File(['xml'], name) }
}

function result(entry: SelectedFile): FileProcessingResult {
  return {
    id: entry.id,
    name: entry.file.name,
    message: 'Confirmada',
    status: 'added',
    invoices: [invoiceFixture({ id: entry.id })],
  }
}

describe('selection admission', () => {
  it('accepts the exact configured count and uppercase XML/ZIP extensions', () => {
    expect(
      validateSelection(
        9998,
        [input('a', 'a.XML').file, input('b', 'b.ZIP').file],
        10000,
        true,
      ).ok,
    ).toBe(true)
  })
  it('rejects overflow and unsupported extensions with the original selection consequence', () => {
    expect(
      validateSelection(1, [input('a').file, input('b').file], 2, true),
    ).toMatchObject({
      ok: false,
      code: 'file-limit',
      message: expect.stringContaining('Tu selección anterior se mantiene'),
    })
    expect(
      validateSelection(0, [input('a', 'xml.exe').file], 2, false),
    ).toMatchObject({ ok: false, code: 'unsupported-type' })
  })
  it('does not reinterpret raw file bytes as canonical JSON storage quota', () => {
    const file = input('big').file

    Object.defineProperty(file, 'size', { value: Number.MAX_SAFE_INTEGER })
    expect(validateSelection(0, [file], 1, false).ok).toBe(true)
  })
})

describe('confirmed result ledger', () => {
  it('accepts out-of-order identical events once and verifies the complete summary', () => {
    const a = input('a')
    const b = input('b')
    const ledger = createProcessingLedger([a, b])

    ledger.record(result(b))
    ledger.record(result(b))
    ledger.record(result(a))

    const files = [result(a), result(b)]

    expect(ledger.results()).toHaveLength(2)
    expect(
      ledger.complete({
        kind: 'completed',
        files,
        summary: summarizeResults(files),
      }).ok,
    ).toBe(true)
  })
  it('validates final-only facts and rejects foreign selection IDs, changed names and counts', () => {
    const a = input('a')
    const files = [result(a)]

    expect(
      createProcessingLedger([a]).complete({
        kind: 'completed',
        files,
        summary: summarizeResults(files),
      }).ok,
    ).toBe(true)
    expect(
      createProcessingLedger([a]).record(result(input('foreign'))).ok,
    ).toBe(false)
    expect(
      createProcessingLedger([a]).record({ ...result(a), name: 'foreign.xml' })
        .ok,
    ).toBe(false)
    expect(
      createProcessingLedger([a]).complete({
        kind: 'completed',
        files,
        summary: { ...summarizeResults(files), saved: 5 },
      }).ok,
    ).toBe(false)
  })
  it('rejects malformed invoice projections and changed final facts', () => {
    const a = input('a')
    const ledger = createProcessingLedger([a])

    expect(
      ledger.record({
        ...result(a),
        status: 'added',
        invoices: [invoiceFixture({ total: Number.NaN })],
      }).ok,
    ).toBe(false)

    const other = createProcessingLedger([a])

    other.record(result(a))
    expect(other.record({ ...result(a), message: 'changed' }).ok).toBe(false)
  })
  it('counts saved invoices separately from outer files and retains warnings on saved ZIPs', () => {
    const a = input('zip', 'zip.zip')
    const saved: FileProcessingResult = {
      ...result(a),
      status: 'added',
      invoices: [invoiceFixture({ id: 'one' }), invoiceFixture({ id: 'two' })],
      issues: ['INVALID_ZIP'],
    }

    expect(summarizeResults([saved])).toEqual({
      added: 1,
      saved: 2,
      duplicates: 0,
      failed: 1,
    })
  })
  it('protects nested confirmed snapshots and checks not-started identities', () => {
    const a = input('a')
    const ledger = createProcessingLedger([a])
    const original = result(a)

    ledger.record(original)

    if (original.status !== 'added') {
      throw new Error('Expected saved fixture')
    }

    original.invoices[0]!.concepts[0]!.name = 'mutated'

    const snapshot = ledger.results()[0]

    expect(
      snapshot?.status === 'added' && snapshot.invoices[0]?.concepts[0]?.name,
    ).toBe('Fruta')
    expect(ledger.notStarted(['foreign']).ok).toBe(false)
    expect(ledger.notStarted(['a', 'a']).ok).toBe(false)
  })
  it('preserves the same File and selection identity only for pending work', () => {
    const a = input('a')
    const b = input('b')
    const c = input('c')
    const files: FileProcessingResult[] = [
      result(a),
      { ...result(b), retryable: true },
      {
        id: c.id,
        name: c.file.name,
        status: 'error',
        message: 'invalid XML',
        retryable: false,
      },
    ]
    const remaining = reconcileSelection([a, b, c], files, new Set(['b']))

    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.file).toBe(b.file)
    expect(remaining[0]?.id).toBe('b')
    expect(remaining[0]?.unresolved).toBeUndefined()
  })
})
