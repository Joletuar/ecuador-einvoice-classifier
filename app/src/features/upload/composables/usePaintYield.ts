import { nextTick, onScopeDispose } from 'vue'

export function usePaintYield() {
  const frames = new Map<number, () => void>()
  let disposed = false

  function frame(): Promise<void> {
    if (disposed) {
      return Promise.resolve()
    }

    return new Promise((resolve) => {
      const id = requestAnimationFrame(() => {
        frames.delete(id)
        resolve()
      })

      frames.set(id, resolve)
    })
  }

  onScopeDispose(() => {
    disposed = true

    for (const [id, resolve] of frames) {
      cancelAnimationFrame(id)
      resolve()
    }

    frames.clear()
  })

  return async function paint() {
    await nextTick()
    await frame()
    await frame()
  }
}
