import { useEffect } from 'react'

/** Keeps the screen on while `active`, so the phone doesn't lock mid-song. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let disposed = false
    const acquire = async () => {
      if (lock || document.visibilityState !== 'visible') return
      try {
        const l = await navigator.wakeLock.request('screen')
        if (disposed) return void l.release()
        lock = l
        l.addEventListener('release', () => (lock = null))
      } catch {
        // denied, e.g. battery saver
      }
    }
    void acquire()
    // The lock is dropped whenever the page is hidden; take it again on return.
    document.addEventListener('visibilitychange', acquire)
    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', acquire)
      void lock?.release()
    }
  }, [active])
}
