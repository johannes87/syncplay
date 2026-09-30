import { Fragment, useEffect, useReducer } from 'react'
import { useClock, useEngine } from '../hooks/stores.ts'
import { fmtMs } from '../lib/format.ts'
import { engine } from '../lib/instances.ts'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SyncDetails({ open, onOpenChange }: Props) {
  const clock = useClock()
  const e = useEngine()
  // The playback offset changes constantly; refresh while visible.
  const [, refresh] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!open) return
    const id = setInterval(refresh, 250)
    return () => clearInterval(id)
  }, [open])

  const rows: [string, string][] = [['Time server', clock.source]]
  if (clock.rtt != null) {
    rows.push(['This device’s clock', `${fmtMs(clock.offset)} ${clock.offset > 0 ? 'behind' : 'ahead'} (corrected)`])
    rows.push(['Network round trip', `${clock.rtt.toFixed(1)} ms · ${clock.samples} samples`])
  }
  if (e.mode) {
    rows.push([
      'Audio mode',
      e.mode === 'precise' ? 'Precise: Web Audio, sample-accurate' : `Basic: media element. ${e.fallbackReason ?? ''}`,
    ])
  }
  const latency = engine.outputLatencyMs
  if (latency != null) rows.push(['Output latency', `${latency.toFixed(0)} ms (compensated)`])
  if (engine.syncError != null && e.state === 'playing') {
    rows.push([
      'Playback offset',
      `${(engine.syncError * 1000).toFixed(1)} ms · speed ×${engine.rate.toFixed(4)}`,
    ])
  }
  if (e.latencyMs) rows.push(['Manual nudge', `${e.latencyMs} ms`])

  return (
    <details
      className="diag"
      id="sync-details"
      open={open}
      onToggle={(ev) => onOpenChange(ev.currentTarget.open)}
    >
      <summary>Sync details</summary>
      <dl>
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
    </details>
  )
}
