import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths, so dist/ works from any folder on any web server.
  base: './',
  plugins: [react()],
})
