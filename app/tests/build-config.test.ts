import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfigFromFile } from 'vite'

const configuration = new URL('../vite.config.ts', import.meta.url).pathname

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('Vite configuration boundary', () => {
  it('bakes normalized values from the selected build environment', async () => {
    vi.stubEnv('VITE_STORAGE_MAX_FILES', '2')
    vi.stubEnv('VITE_STORAGE_MAX_BYTES', '20')

    const loaded = await loadConfigFromFile(
      { command: 'build', mode: 'production' },
      configuration,
    )

    expect(JSON.parse(loaded?.config.define?.__STORAGE_LIMITS__)).toEqual({
      maxFiles: 2,
      maxTotalBytes: 20,
    })
  })

  it('rejects invalid build settings before output is emitted', async () => {
    vi.stubEnv('VITE_STORAGE_MAX_FILES', '0')
    vi.stubEnv('VITE_STORAGE_MAX_BYTES', '20')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(
      loadConfigFromFile(
        { command: 'build', mode: 'production' },
        configuration,
      ),
    ).rejects.toThrow('VITE_STORAGE_MAX_FILES')
  })

  it('serves an already built preview without reinterpreting current settings', async () => {
    vi.stubEnv('VITE_STORAGE_MAX_FILES', 'invalid')
    vi.stubEnv('VITE_STORAGE_MAX_BYTES', '')

    const loaded = await loadConfigFromFile(
      { command: 'serve', mode: 'production', isPreview: true },
      configuration,
    )

    expect(loaded?.config.define).toEqual({})
  })
})
