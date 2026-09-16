import { createApp } from 'vue'
import App from './App.vue'
import './styles/main.css'

/**
 * 浏览器模式判定。
 *
 * 这套 UI 是为 Electron 透明窗口做的：没有背景色、文字是浅灰、靠窗口透明
 * 露出桌面。直接丢进浏览器会「看起来一片空白」—— 白底 + 浅灰字。
 *
 * 用 `window.nexus` 是否存在来判断，而不是 Vite 的 mode：
 * 这样不管用 `pnpm dev` 还是 `pnpm dev:web`，只要没跑在 Electron 里就生效。
 */
if (!window.nexus) {
  document.body.classList.add('browser-mode')
}

createApp(App).mount('#app')
