/// <reference types="vitest" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'path'
import { pdfjsAssets } from './scripts/pdfjs-assets.mjs'

// A public page's module lives under src/features/<domain>/public/. Its chunk is named
// `public-*` so src/__tests__/bundleBoundary.test.ts can prove, after a build, that no
// public page loads supabase-js.
const PUBLIC_PAGE = /[\\/]src[\\/]features[\\/][^\\/]+[\\/]public[\\/]/

export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    // A syntax-lowering floor, not a runtime polyfill: without it a Radix class
    // static block reaches the entry chunk and older Safari renders a blank page.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14', 'ios14'],
    sourcemap: false,
    rollupOptions: {
      output: {
        chunkFileNames: (chunk) =>
          chunk.facadeModuleId && PUBLIC_PAGE.test(chunk.facadeModuleId)
            ? 'assets/public-[name]-[hash].js'
            : 'assets/[name]-[hash].js',
        // Rolldown merges small unmatched shared modules into the largest chunk,
        // which is the Supabase client. Pinning the known strays keeps the client
        // out of chunks that never use it.
        codeSplitting: {
          groups: [
            { name: 'preload-helper', test: /vite\/preload-helper/ },
            { name: 'vendor-shared-utils', test: /node_modules\/(?:tslib|use-sidecar|use-callback-ref|react-style-singleton|aria-hidden|get-nonce)\// },
            { name: 'vendor-react', test: /node_modules\/(?:react|react-dom|scheduler|react-router|react-router-dom|@remix-run)\// },
            { name: 'vendor-supabase', test: /node_modules\/@supabase\// },
            { name: 'vendor-query', test: /node_modules\/@tanstack\// },
            // pdf.js is large and only the document and e-sign screens load it.
            { name: 'vendor-pdfjs', test: /node_modules\/pdfjs-dist\// },
          ],
        },
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
