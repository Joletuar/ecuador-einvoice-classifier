export function webLocks() {
  interface Entry {
    name: string
    mode: 'shared' | 'exclusive'
    run(lock: Lock | null): void
    abort(): void
  }

  const held = new Set<Entry>()
  const pending: Entry[] = []

  function conflicts(entry: Entry) {
    return [...held].some(
      (other) =>
        other.name === entry.name &&
        (other.mode === 'exclusive' || entry.mode === 'exclusive'),
    )
  }

  function drain() {
    for (let index = 0; index < pending.length;) {
      const entry = pending[index]!

      if (
        conflicts(entry) ||
        pending.slice(0, index).some((other) => other.name === entry.name)
      ) {
        index++
        continue
      }

      pending.splice(index, 1)
      held.add(entry)
      entry.run({ name: entry.name, mode: entry.mode } as Lock)
    }
  }

  const manager = {
    request<T>(
      name: string,
      options: {
        mode?: 'shared' | 'exclusive'
        signal?: AbortSignal
        ifAvailable?: boolean
      },
      work: (lock: Lock | null) => Promise<T>,
    ) {
      return new Promise<T>((resolve, reject) => {
        const entry: Entry = {
          name,
          mode: options.mode ?? 'exclusive',

          run(lock) {
            options.signal?.removeEventListener('abort', entry.abort)
            void Promise.resolve()
              .then(() => work(lock))
              .then(resolve, reject)
              .finally(() => {
                held.delete(entry)
                drain()
              })
          },

          abort() {
            const index = pending.indexOf(entry)

            if (index >= 0) {
              pending.splice(index, 1)
            }

            reject(new DOMException('Aborted', 'AbortError'))
            drain()
          },
        }

        if (options.signal?.aborted) {
          entry.abort()

          return
        }

        if (
          options.ifAvailable &&
          (conflicts(entry) || pending.some((other) => other.name === name))
        ) {
          entry.run(null)

          return
        }

        options.signal?.addEventListener('abort', entry.abort, { once: true })
        pending.push(entry)
        drain()
      })
    },

    async query() {
      return {
        held: [...held].map(({ name, mode }) => ({
          name,
          mode,
          clientId: 'test',
        })),
        pending: pending.map(({ name, mode }) => ({
          name,
          mode,
          clientId: 'test',
        })),
      }
    },
  }

  return manager as LockManager
}
