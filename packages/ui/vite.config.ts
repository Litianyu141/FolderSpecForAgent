import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // 两个宿主都以本地文件方式加载产物，必须用相对路径
  base: './',
  build: { outDir: 'dist', emptyOutDir: true },
})
