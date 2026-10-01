// The real app (production build): what hosts and guests see.

import { QUIET_FILE } from './fixtures.ts'
import { APP_URL, expect, fileUrl, test } from './test.ts'

test.describe.configure({ mode: 'parallel' })

const details = (page: import('@playwright/test').Page) => page.locator('#sync-details dl')

async function openDetails(page: import('@playwright/test').Page) {
  await page.locator('#sync-details summary').click()
}

test('host: checks the link, starts, plays in precise mode, shares an invite', async ({ page }) => {
  await page.goto(APP_URL)
  await page.getByPlaceholder('https://example.com/track.mp3').fill(fileUrl(QUIET_FILE))
  await expect(page.locator('.url-status')).toHaveText(/Playable · 1:00 · precise sync/)
  await page.getByRole('radio', { name: 'Right away' }).click()
  await page.getByRole('button', { name: 'Start & get invite link' }).click()

  await expect(page.locator('.status')).toContainText('Playing in sync', { timeout: 15_000 })
  await expect(page.locator('.status')).toContainText('Precise sync')
  await openDetails(page)
  await expect(details(page)).toContainText('Precise: MP3, 44.1 kHz, streamed')
  await expect(page.getByLabel('Invite link')).toHaveValue(/#u=.*quiet\.mp3&t=\d+/)
})

test('guest: opens an invite after the start and drops in', async ({ page }) => {
  const start = Date.now() - 5000
  await page.goto(`${APP_URL}/#u=${encodeURIComponent(fileUrl(QUIET_FILE))}&t=${start}`)
  await expect(page.locator('.status')).toContainText('already playing')
  await page.getByRole('button', { name: 'Tap to join now' }).click()
  await expect(page.locator('.status')).toContainText('Playing in sync', { timeout: 15_000 })
})

test('falls back to basic mode when the file’s server doesn’t allow CORS', async ({ page }) => {
  await page.goto(APP_URL)
  await page.getByPlaceholder('https://example.com/track.mp3').fill(fileUrl(QUIET_FILE, { cors: false }))
  await expect(page.locator('.url-status')).toHaveText(/basic sync only.*CORS/)
  await page.getByRole('radio', { name: 'Right away' }).click()
  await page.getByRole('button', { name: 'Start & get invite link' }).click()

  await expect(page.locator('.status')).toContainText('Basic sync', { timeout: 15_000 })
  await openDetails(page)
  await expect(details(page)).toContainText('Basic: media element. The file’s server doesn’t allow cross-origin access (CORS).')
})

test('explains links that can’t be played', async ({ page }) => {
  await page.goto(APP_URL)
  await page.getByPlaceholder('https://example.com/track.mp3').fill(fileUrl('missing.mp3'))
  await expect(page.locator('.url-status')).toHaveText(/can’t play this link/)
})
