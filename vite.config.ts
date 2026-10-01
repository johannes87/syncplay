import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths, so dist/ works from any folder on any web server.
  base: './',
  plugins: [react()],
  // Pre-bundle these at startup, so the first page using them doesn't trigger a reload.
  optimizeDeps: { include: ['mediabunny', 'mpg123-decoder', '@wasm-audio-decoders/flac'] },
})
