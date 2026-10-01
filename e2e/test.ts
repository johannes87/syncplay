// Shared setup for the end-to-end tests.

import { test as base, type Page, type Route } from '@playwright/test'
import type { Harness, PlayOptions } from './harness.ts'

export { expect } from '@playwright/test'

/** Vite dev server with the test harness (see playwright.config.ts). */
export const DEV_URL = 'http://localhost:5199'
/** Production build. */
export const APP_URL = 'http://localhost:5197'
const FILES_URL = 'http://127.0.0.1:5198'
const FILES_NO_CORS_URL = 'http://127.0.0.1:5196'

/** URL of a test file. `tag` groups requests for counting bytes (see bytesSent). */
export function fileUrl(file: string, { cors = true, tag = 'default' } = {}) {
  return `${cors ? FILES_URL : FILES_NO_CORS_URL}/${tag}/${file}`
}

/** Bytes the file server has sent for URLs with `tag`. */
export async function bytesSent(tag: string): Promise<number> {
  return Number(await (await fetch(`${FILES_URL}/stats/${tag}`)).text())
}

export interface TimeServerOptions {
  /** How far the reference time is ahead of this machine's clock, ms (simulates a device clock that's off). */
  offsetMs?: number
  /** Extra delay for an answer after its timestamp was taken, ms (simulates a congested network). */
  delayMs?: () => number
  akamaiDown?: boolean
  timeapiDown?: boolean
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Timing-Allow-Origin': '*', 'Cache-Control': 'no-store' }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Answers the app's time-server requests locally, so the tests don't depend on
 * the internet and can simulate clock offsets and network trouble.
 */
async function serveTime(page: Page, o: TimeServerOptions) {
  const answer = (down: boolean | undefined, body: (now: number) => string) => async (route: Route) => {
    if (down) return route.abort()
    const now = Date.now() + (o.offsetMs ?? 0)
    await sleep(o.delayMs?.() ?? 0)
    await route.fulfill({ headers: CORS, body: body(now) })
  }
  await page.route(/^https:\/\/time\.akamai\.com\//, answer(o.akamaiDown, (now) => (now / 1000).toFixed(3)))
  await page.route(
    /^https:\/\/timeapi\.io\//,
    answer(o.timeapiDown, (now) => JSON.stringify({ dateTime: new Date(now).toISOString().slice(0, 23) + '0000' })),
  )
}

export type HarnessApi = {
  [K in keyof Harness]: Harness[K] extends (...args: infer A) => infer R ? (...args: A) => R : Promise<Harness[K]>
}

export const test = base.extend<{ timeServer: TimeServerOptions; harness: HarnessApi }>({
  timeServer: [{}, { option: true }],

  page: async ({ page, timeServer }, use) => {
    await serveTime(page, timeServer)
    await use(page)
  },

  harness: async ({ page }, use) => {
    await page.goto(`${DEV_URL}/e2e/harness.html`)
    await page.waitForFunction(() => 'harness' in window)
    const call =
      <K extends keyof Harness>(name: K) =>
      (...args: unknown[]) =>
        page.evaluate(
          ([name, args]) => {
            const h = (window as unknown as { harness: Record<string, unknown> }).harness
            const member = h[name as string]
            return typeof member === 'function' ? member(...(args as unknown[])) : member
          },
          [name, args] as const,
        )
    await use({
      play: call('play') as (o: PlayOptions) => ReturnType<Harness['play']>,
      decode: call('decode') as Harness['decode'],
      pieceAudio: call('pieceAudio') as Harness['pieceAudio'],
      joinLate: call('joinLate') as Harness['joinLate'],
      clockAfterSync: call('clockAfterSync') as Harness['clockAfterSync'],
      clockState: call('clockState') as Harness['clockState'],
      PREROLL: call('PREROLL')() as Promise<number>,
    })
  },
})
