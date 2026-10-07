import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
    // Relative asset paths, so dist/ works from any folder on any web server.
    base: './',
    plugins: [react()],
    // Import prefixes; keep in step with "paths" in tsconfig.app.json and tsconfig.e2e.json.
    resolve: {
        alias: {
            '@e2e': fileURLToPath(new URL('./e2e', import.meta.url)),
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    // Pre-bundle these at startup, so the first page using them doesn't trigger a reload.
    optimizeDeps: { include: ['mediabunny', 'mpg123-decoder', '@wasm-audio-decoders/flac'] },
});
