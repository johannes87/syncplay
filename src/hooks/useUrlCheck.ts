import { useEffect, useState } from 'react'
import { fmtTime, isHttpUrl } from '../lib/format.ts'
import { probeCors, probeDuration } from '../lib/probe.ts'

export interface UrlCheck {
  state: '' | 'checking' | 'ok' | 'warn' | 'bad'
  text: string
}

const EMPTY: UrlCheck = { state: '', text: '' }

async function check(url: string): Promise<UrlCheck> {
  const [duration, cors] = await Promise.allSettled([probeDuration(url), probeCors(url)])
  if (duration.status === 'rejected') {
    return { state: 'bad', text: 'Your browser can’t play this link. Is it a direct link to an audio file?' }
  }
  if (!Number.isFinite(duration.value)) {
    return { state: 'bad', text: 'This looks like a live stream. SyncPlay needs a file with a fixed length.' }
  }
  const length = fmtTime(duration.value)
  if (cors.status === 'fulfilled' && cors.value) {
    return { state: 'ok', text: `✓ Playable · ${length} · precise sync` }
  }
  return {
    state: 'warn',
    text:
      `✓ Playable · ${length} · basic sync only: the file’s server doesn’t allow ` +
      `precise mode (CORS). Beats may be a few ms apart.`,
  }
}

/** Checks (debounced) that the browser can play the link, and whether precise mode will work. */
export function useUrlCheck(url: string): UrlCheck {
  const [result, setResult] = useState<{ url: string; check: UrlCheck } | null>(null)
  const trimmed = url.trim()
  const valid = isHttpUrl(trimmed)

  useEffect(() => {
    if (!valid) return
    let cancelled = false
    const timer = setTimeout(() => {
      void check(trimmed).then((c) => !cancelled && setResult({ url: trimmed, check: c }))
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [trimmed, valid])

  if (!trimmed) return EMPTY
  if (!valid) return { state: 'bad', text: 'Paste a full link, starting with https://' }
  if (result?.url !== trimmed) return { state: 'checking', text: 'Checking the link…' }
  return result.check
}
