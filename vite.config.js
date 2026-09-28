/// <reference types="vitest" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import path from 'path'

export default defineConfig({
  plugins: [react()],
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
