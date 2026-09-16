import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'
import { resolve } from 'path'

export default defineConfig({
  // Electron 打包后通过 file:// 加载，必须用相对路径
  base: './',
  plugins: [
    vue(),
    electron({
      main: { entry: 'electron/main.ts' },
      preload: { input: 'electron/preload.ts' },
      renderer: {},
    }),
  ],
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: {
    port: 5176,
    strictPort: false,
  },
  // Live2D SDK 与 pixi 体积较大，单独分包避免首屏警告
  build: {
    chunkSizeWarningLimit: 2000,
  },
})
