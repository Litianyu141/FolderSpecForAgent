import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Bridge } from '@folderspec/core/api'
import { App } from './App.js'
import { createWebSocketBridge } from './ws-bridge.js'
import './styles.css'

declare global {
  interface Window {
    __folderspecBridge?: Bridge
    __folderspecRoot?: string
  }
}

// VSCode 宿主会预先注入 __folderspecBridge；浏览器宿主则连同源 WebSocket
const bridge = window.__folderspecBridge
  ?? createWebSocketBridge(`ws://${window.location.host}/`)

const el = document.getElementById('root')
if (!el) throw new Error('缺少 #root 挂载点')

createRoot(el).render(
  <StrictMode>
    <App bridge={bridge} initialRoot={window.__folderspecRoot ?? '.'} />
  </StrictMode>,
)
