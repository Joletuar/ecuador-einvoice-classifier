import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import { parseStorageLimits } from './src/app/config/parseStorageLimits'
import { classifierAssets } from './build/classifierAssets'
import {
  precacheIntegrity,
  offlineReleasePlugin,
  readOfflineRelease,
} from './build/offlineRelease'

export default defineConfig(({ mode, isPreview }) => {
  const storageLimits = isPreview
    ? undefined
    : parseStorageLimits(loadEnv(mode, process.cwd(), 'VITE_'))

  const release = readOfflineRelease(undefined, { mode, storageLimits })
  const integrity = precacheIntegrity()

  return {
    build: {
      rollupOptions: {
        maxParallelFileOps: 64,
      },
    },
    define: isPreview
      ? {}
      : {
          __STORAGE_LIMITS__: JSON.stringify(storageLimits),
        },
    plugins: [
      classifierAssets(),
      offlineReleasePlugin(release),
      integrity.plugin,
      vue(),
      tailwindcss(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: null,
        integration: {
          beforeBuildServiceWorker: integrity.beforeBuildServiceWorker,
        },
        manifest: {
          id: '/',
          name: 'Mis facturas',
          short_name: 'Mis facturas',
          description:
            'Organiza y clasifica tus facturas electrónicas ecuatorianas en tu dispositivo.',
          lang: 'es-EC',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          theme_color: '#1456a0',
          background_color: '#ffffff',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
            },
          ],
        },
        injectManifest: {
          globPatterns: [
            '**/*.{js,css,html,svg,png,woff2}',
            `classifier/${release.identity.modelPackageId}/**/*`,
          ],
          maximumFileSizeToCacheInBytes: 12 * 1024 * 1024,
          manifestTransforms: [integrity.transform],
          buildPlugins: { vite: [offlineReleasePlugin(release)] },
        },
      }),
    ],
    worker: { format: 'es' },
  }
})
