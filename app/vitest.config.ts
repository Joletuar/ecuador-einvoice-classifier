import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { classifierAssets } from './build/classifierAssets'
import {
  offlineReleasePlugin,
  readOfflineRelease,
} from './build/offlineRelease'

export default defineConfig({
  plugins: [
    vue(),
    classifierAssets(),
    offlineReleasePlugin(readOfflineRelease()),
  ],
  test: { include: ['tests/**/*.test.ts'] },
})
