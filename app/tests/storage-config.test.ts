import { describe, expect, it } from 'vitest'
import { parseStorageLimits } from '../src/app/config/parseStorageLimits'

describe('build-time storage limits', () => {
  it('normalizes and freezes explicit valid configuration', () => {
    const limits = parseStorageLimits({
      VITE_STORAGE_MAX_FILES: '10000',
      VITE_STORAGE_MAX_BYTES: '104857600',
    })

    expect(limits).toEqual({ maxFiles: 10000, maxTotalBytes: 104857600 })
    expect(Object.isFrozen(limits)).toBe(true)
  })

  for (const value of [
    undefined,
    '',
    ' ',
    '0',
    '-1',
    '1.5',
    '1e3',
    '0x10',
    'NaN',
    'Infinity',
    '9007199254740992',
    '20files',
  ]) {
    it('rejects invalid configuration: ' + String(value), () => {
      expect(() =>
        parseStorageLimits({
          VITE_STORAGE_MAX_FILES: value,
          VITE_STORAGE_MAX_BYTES: '100',
        }),
      ).toThrow(/VITE_STORAGE_MAX_FILES/)
      expect(() =>
        parseStorageLimits({
          VITE_STORAGE_MAX_FILES: '50',
          VITE_STORAGE_MAX_BYTES: value,
        }),
      ).toThrow(/VITE_STORAGE_MAX_BYTES/)
    })
  }
})
