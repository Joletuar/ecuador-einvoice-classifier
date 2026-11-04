declare module 'virtual:app-release' {
  export const appRelease: import('./features/offline/services/offlineProtocol').OfflineIdentity
  export const classifierAssets: readonly {
    path: string
    url: string
    sha256: string
  }[]
}
