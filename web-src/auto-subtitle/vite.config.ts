import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

// The tool page (web-ui/tools/auto-subtitle/index.html) is hand-maintained for SEO and the shared
// site shell; this build only emits the app bundle it loads: app/auto-subtitle.{js,css}.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@resources': resolve(__dirname, 'resources')
    }
  },
  build: {
    outDir: resolve(__dirname, '../../web-ui/tools/auto-subtitle/app'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/renderer/src/main.tsx'),
      output: {
        entryFileNames: 'auto-subtitle.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: (info) =>
          info.names?.some((n) => n.endsWith('.css')) ? 'auto-subtitle.css' : 'assets/[name]-[hash][extname]'
      }
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
} as import('vite').UserConfig)
