import { Fragment, useEffect, useReducer, useRef, useState } from 'react';
import { useClock, useEngine } from '@/hooks/stores.ts';
import { fmtMs } from '@/lib/format.ts';
import { engine } from '@/lib/instances.ts';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function SyncDetails({ open, onOpenChange }: Props) {
    const clock = useClock();
    const e = useEngine();
    // The playback offset changes constantly; refresh while visible.
    const [, refresh] = useReducer((x: number) => x + 1, 0);
    useEffect(() => {
        if (!open) return;
        const id = setInterval(refresh, 250);
        return () => clearInterval(id);
    }, [open]);

    const rows: [string, string][] = [['Time server', clock.source]];
    if (clock.rtt != null) {
        rows.push(
            ['This device’s clock', `${fmtMs(clock.offset)} ${clock.offset > 0 ? 'behind' : 'ahead'} (corrected)`],
            ['Network round trip', `${clock.rtt.toFixed(1)} ms · ${clock.samples} samples`],
        );
    }
    if (e.mode) {
        rows.push([
            'Audio mode',
            e.mode === 'precise' ? `Precise: ${e.detail}` : `Basic: media element. ${e.fallbackReason ?? ''}`,
        ]);
    }
    const latency = engine.outputLatencyMs;
    if (latency != null) rows.push(['Output latency', `${latency.toFixed(0)} ms (compensated)`]);
    if (engine.syncError != null && e.state === 'playing') {
        rows.push(['Playback offset', `${(engine.syncError * 1000).toFixed(1)} ms · speed ×${engine.rate.toFixed(4)}`]);
    }
    if (e.latencyMs) rows.push(['Manual nudge', `${e.latencyMs} ms`]);

    const [copyLabel, setCopyLabel] = useState('Copy details');
    const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(resetTimer.current), []);

    /** Copies the details as plain text, with what else helps when reporting a sync problem. */
    const copy = async () => {
        const lines = [
            'SyncPlay sync details',
            ...rows.map(([k, v]) => `${k}: ${v}`),
            `State: ${e.state}${e.error ? ` (${e.error})` : ''}`,
            ...(engine.ctx ? [`Audio sample rate: ${engine.ctx.sampleRate / 1000} kHz`] : []),
            `Browser: ${navigator.userAgent}`,
            `Copied at: ${new Date().toISOString()}`,
        ];
        try {
            await navigator.clipboard.writeText(lines.join('\n'));
            setCopyLabel('Copied!');
        } catch {
            setCopyLabel('Couldn’t copy');
        }
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopyLabel('Copy details'), 1800);
    };

    return (
        <details className="diag" id="sync-details" open={open} onToggle={(ev) => onOpenChange(ev.currentTarget.open)}>
            <summary>Sync details</summary>
            <dl>
                {rows.map(([k, v]) => (
                    <Fragment key={k}>
                        <dt>{k}</dt>
                        <dd>{v}</dd>
                    </Fragment>
                ))}
            </dl>
            <button type="button" className="diag-copy" onClick={copy}>
                {copyLabel}
            </button>
        </details>
    );
}
