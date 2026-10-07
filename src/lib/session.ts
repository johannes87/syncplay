import { titleFromUrl } from '@/lib/format.ts';

/**
 * Everything a device needs to play along. At reference time `start` (ms since
 * the epoch, see clock.ts) the track is at `pos` seconds; every device derives
 * "where should the song be right now" from that alone, so no server is needed
 * and late joiners simply drop in at the right spot.
 */
export interface Session {
    url: string;
    start: number;
    pos: number;
    loop: boolean;
    title: string;
}

/** Seconds until the start for "Right away": enough for this device to load the song. */
export const RIGHT_AWAY = 3;

/** The start time `delay` seconds from `nowMs`, rounded up to a full second so it reads nicely. */
export function startIn(nowMs: number, delay: number): number {
    return Math.ceil((nowMs + delay * 1000) / 1000) * 1000;
}

export function makeSession(s: Omit<Session, 'title'>): Session {
    return { ...s, title: titleFromUrl(s.url) };
}

/** Reads `#u=<song url>&t=<start>[&p=<seconds>][&l=1]`. */
export function parseSession(hash: string): Session | null {
    const q = new URLSearchParams(hash.replace(/^#/, ''));
    const url = q.get('u');
    const start = Number(q.get('t'));
    if (!url || !Number.isFinite(start) || start <= 0) return null;
    return makeSession({ url, start, pos: Number(q.get('p')) || 0, loop: q.get('l') === '1' });
}

export function sessionLink(s: Session, base = location.origin + location.pathname): string {
    const q = new URLSearchParams({ u: s.url, t: String(Math.round(s.start)) });
    if (s.pos) q.set('p', String(s.pos));
    if (s.loop) q.set('l', '1');
    return `${base}#${q}`;
}

export function sessionKey(s: Session | null): string {
    return s ? `${s.url}|${s.start}|${s.pos}|${s.loop}` : '';
}

/**
 * Song position (seconds) that should be audible at reference time `globalMs`,
 * or null once a non-looping song is over. `latencyMs` shifts this device
 * earlier to make up for output delay the browser can't see (e.g. Bluetooth).
 */
export function timelinePosition(
    s: Pick<Session, 'start' | 'pos' | 'loop'>,
    globalMs: number,
    duration: number,
    latencyMs = 0,
): number | null {
    const p = (globalMs + latencyMs - s.start) / 1000 + s.pos;
    if (s.loop) return ((p % duration) + duration) % duration;
    return p >= duration ? null : p;
}

/** Has a non-looping song finished for everyone? */
export function isOver(s: Session, globalMs: number, duration: number | null): boolean {
    return !s.loop && duration != null && (globalMs - s.start) / 1000 + s.pos >= duration;
}
