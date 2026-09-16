import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ mode }) => {
  // 纯浏览器模式：不加载 Electron 插件，UI 调试不必等 Electron 二进制就位
  // 用法：pnpm dev:web
  const withElectron = mode !== 'web'

  return {
    // Electron 打包后通过 file:// 加载，必须用相对路径
    base: './',

    plugins: [
      vue(),
      ...(withElectron
        ? [
            electron({
              main: { entry: 'electron/main.ts' },
              preload: { input: 'electron/preload.ts' },
              renderer: {},
            }),
          ]
        : []),
    ],

    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },

    server: {
      port: 5176,
      strictPort: false,
    },

    // Live2D SDK 与 pixi 体积较大，放宽警告阈值
    build: {
      chunkSizeWarningLimit: 2000,
    },
  }
})
