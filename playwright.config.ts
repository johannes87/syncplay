import { defineConfig, devices } from '@playwright/test'

const chrome = {
  ...devices['Desktop Chrome'],
  // Real Chrome: Playwright's Chromium can't play AAC.
  channel: 'chrome',
  launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
}
const webkit = devices['Desktop Safari']

// End-to-end tests: npm run test:e2e (needs Google Chrome and ffmpeg; see e2e/).
export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.e2e.ts',
  globalSetup: './e2e/global-setup.ts',
  timeout: 90_000,
  fullyParallel: true,
  workers: 3,
  reporter: [['list']],
  projects: [
    { name: 'chrome', testIgnore: 'sync.e2e.ts', use: chrome },
    { name: 'webkit', testIgnore: 'sync.e2e.ts', use: webkit },
    // Real-time playback: one test per browser at a time, after the rest, because a busy
    // machine disturbs audio timing in headless browsers. One retry absorbs a rare
    // disturbance; a real regression fails twice.
    {
      name: 'chrome-sync',
      testMatch: 'sync.e2e.ts',
      use: chrome,
      workers: 1,
      retries: 1,
      dependencies: ['chrome', 'webkit'],
    },
    {
      name: 'webkit-sync',
      testMatch: 'sync.e2e.ts',
      use: webkit,
      workers: 1,
      retries: 1,
      dependencies: ['chrome', 'webkit'],
    },
  ],
  webServer: [
    {
      command: 'npx vite --port 5199 --strictPort',
      url: 'http://localhost:5199/e2e/harness.html',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'node e2e/file-server.ts',
      url: 'http://127.0.0.1:5198/health',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite build --outDir e2e/.dist --emptyOutDir && npx vite preview --outDir e2e/.dist --port 5197 --strictPort',
      url: 'http://localhost:5197/',
      reuseExistingServer: !process.env.CI,
    },
  ],
})
