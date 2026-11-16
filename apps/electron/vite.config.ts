import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import pkg from './package.json' with { type: 'json' }

export const developmentContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' http://127.0.0.1:5173",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: proma-file: http: https:",
  "font-src 'self' data: blob: proma-file: http: https:",
  "media-src 'self' data: blob: proma-file: http: https:",
  "connect-src 'self' data: blob: http: https: ws: wss:",
  "frame-src 'self' data: blob: proma-file: http: https:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

export const developmentCspPlugin = {
  name: 'proma-development-csp',
  apply: 'serve' as const,
  transformIndexHtml() {
    return [{
      tag: 'meta' as const,
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content: developmentContentSecurityPolicy,
      },
      injectTo: 'head-prepend' as const,
    }]
  },
}

export default defineConfig({
  plugins: [react(), developmentCspPlugin],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, 'dist/renderer'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@/types': resolve(__dirname, 'src/types'),
      '@': resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    // Chromium can resolve localhost to IPv4 while Vite binds only ::1 on macOS.
    // Use the same explicit IPv4 loopback address as Electron's dev windows.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true, // 确保使用指定端口，如被占用则报错
    open: false,
  },
})
