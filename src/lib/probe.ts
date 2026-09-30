/** Duration of a media URL in seconds (Infinity for live streams). Rejects if unplayable. */
export function probeDuration(url: string, timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const audio = new Audio()
    const done = () => {
      clearTimeout(timer)
      audio.onloadedmetadata = audio.onerror = null
      audio.removeAttribute('src')
      audio.load()
    }
    const timer = setTimeout(() => {
      done()
      reject(new Error('Timed out'))
    }, timeoutMs)
    audio.onloadedmetadata = () => {
      const duration = audio.duration
      done()
      resolve(duration)
    }
    audio.onerror = () => {
      done()
      reject(new Error('Unplayable'))
    }
    audio.preload = 'metadata'
    audio.src = url
  })
}

/**
 * Can we download the file directly (needed for precise mode), and how big is it?
 * Returns null if cross-origin access (CORS) is not allowed.
 */
export async function probeDirect(url: string): Promise<{ bytes: number | null } | null> {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'omit' })
    return { bytes: Number(res.headers.get('content-length')) || null }
  } catch {
    return null
  }
}
