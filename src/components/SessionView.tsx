import type { ReactNode } from 'react';
import { useEngine, useNow } from '../hooks/stores.ts';
import { navigate } from '../hooks/useHashSession.ts';
import { useProbedDuration } from '../hooks/useProbedDuration.ts';
import { useWakeLock } from '../hooks/useWakeLock.ts';
import { hostFromUrl } from '../lib/format.ts';
import { clock, engine } from '../lib/instances.ts';
import { isOver, type Session } from '../lib/session.ts';
import { LAST_URL_KEY, save } from '../lib/storage.ts';
import { ShareCard } from './ShareCard.tsx';
import { Stage } from './Stage.tsx';
import { SyncDetails } from './SyncDetails.tsx';
import { TuneCard } from './TuneCard.tsx';

interface Props {
    session: Session;
    detailsOpen: boolean;
    onDetailsOpenChange: (open: boolean) => void;
}

export function SessionView({ session, detailsOpen, onDetailsOpenChange }: Props) {
    const e = useEngine();
    const now = useNow(500);
    const probedDuration = useProbedDuration(session.url);
    const duration = e.duration ?? probedDuration;
    const { state } = e;
    const started = now >= session.start;
    const over = state === 'ended' || (state === 'idle' && isOver(session, now, duration));
    const active = state === 'waiting' || state === 'playing';
    useWakeLock(active);

    const join = () => {
        engine.unlock(); // we're inside the tap, so audio is allowed now
        void engine.join(session);
    };

    const replay = () => {
        const next = { ...session, start: Math.ceil((clock.now() + 30_000) / 1000) * 1000 };
        engine.unlock();
        void engine.join(next);
        navigate(next);
    };

    const badge = e.mode && (
        <span className={`badge ${e.mode}`} title={e.mode === 'basic' ? (e.fallbackReason ?? '') : undefined}>
            {e.mode === 'precise' ? 'Precise sync' : 'Basic sync'}
        </span>
    );

    const status: Record<typeof state, ReactNode> = {
        idle: over
            ? 'This song has finished. Start it again and share the new invite.'
            : started
              ? 'It’s already playing. Join and you’ll drop in at exactly the right spot.'
              : 'Tap join so your device is ready. It starts on its own.',
        loading:
            e.progress == null
                ? 'Loading the song…'
                : e.progress >= 1
                  ? 'Preparing audio…'
                  : `Loading the song… ${Math.round(e.progress * 100)}%`,
        waiting: <>You’re in. Starting in sync… {badge}</>,
        playing: <>Playing in sync {badge}</>,
        ended: 'That’s the end of the song.',
        error: <span className="error">{e.error ?? 'Something went wrong.'}</span>,
    };

    return (
        <main className="view">
            <div className="track-info">
                <div className="track-title">{session.title}</div>
                <div className="track-sub">
                    {hostFromUrl(session.url)} · starts {new Date(session.start).toLocaleTimeString()}
                    {session.loop && ' · looping'}
                </div>
            </div>

            <Stage session={session} duration={duration} state={over ? 'ended' : state} />

            <p className="status" aria-live="polite">
                {status[state]}
            </p>
            {state === 'loading' && (
                <div className={`loadbar${e.progress == null ? ' indeterminate' : ''}`}>
                    <span style={e.progress == null ? undefined : { width: `${e.progress * 100}%` }} />
                </div>
            )}

            <div className="actions">
                {!over && (state === 'idle' || state === 'error') && (
                    <button type="button" className="btn primary big" onClick={join}>
                        {state === 'error' ? 'Try again' : started ? 'Tap to join now' : 'Tap to join'}
                    </button>
                )}
                {over && (
                    <button type="button" className="btn primary big" onClick={replay}>
                        Play again for everyone
                    </button>
                )}
                {(state === 'loading' || active) && (
                    <button type="button" className="btn ghost" onClick={() => engine.leave()}>
                        Stop on this device
                    </button>
                )}
            </div>

            <ShareCard session={session} />
            {active && <TuneCard />}
            <SyncDetails open={detailsOpen} onOpenChange={onDetailsOpenChange} />

            <a
                className="new-song"
                href="./"
                onClick={(ev) => {
                    ev.preventDefault();
                    save(LAST_URL_KEY, session.url);
                    navigate(null);
                }}
            >
                ＋ Play a different song
            </a>
        </main>
    );
}
