import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Bridge } from '@folderspec/core/api'
import { App } from './App.js'
import { createWebSocketBridge } from './ws-bridge.js'
import { createVscodeBridge } from './vscode-bridge.js'
import './styles.css'
import './layout.css'

declare global {
  interface Window {
    __folderspecRoot?: string
    /** CLI 宿主注入的一次性令牌；ws-bridge 会把它拼到 WebSocket URL 上 */
    __folderspecToken?: string
    acquireVsCodeApi?: unknown
  }
}

// 宿主自识别：VSCode webview 里有 acquireVsCodeApi，浏览器里没有
const bridge: Bridge = typeof window.acquireVsCodeApi === 'function'
  ? createVscodeBridge()
  : createWebSocketBridge(`ws://${window.location.host}/`)

const el = document.getElementById('root')
if (!el) throw new Error('缺少 #root 挂载点')

createRoot(el).render(
  <StrictMode>
    <App bridge={bridge} initialRoot={window.__folderspecRoot ?? '.'} />
  </StrictMode>,
)
