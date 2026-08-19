import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Bridge } from '@folderspec/core/api'
import { App } from './App.js'
import './styles.css'

declare global {
  interface Window {
    __folderspecBridge?: Bridge
    __folderspecRoot?: string
  }
}

const bridge = window.__folderspecBridge
if (!bridge) throw new Error('宿主未注入 window.__folderspecBridge')

const el = document.getElementById('root')
if (!el) throw new Error('缺少 #root 挂载点')

createRoot(el).render(
  <StrictMode>
    <App bridge={bridge} initialRoot={window.__folderspecRoot ?? '.'} />
  </StrictMode>,
)
