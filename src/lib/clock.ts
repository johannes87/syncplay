// Client-side NTP over HTTPS.
//
// Browsers can't speak real NTP (UDP), so we do the same math over HTTP:
// for each request we note when it left (t1) and when the first byte of the
// answer arrived (t2) on the monotonic performance clock, and read the
// server's timestamp S from the body. Assuming the network path is roughly
// symmetric, the server read its clock half-way through, so
//
//     offset = S - (t1 + t2) / 2          (error is at most RTT / 2)
//
// Requests that got stuck in a queue have a large RTT and a skewed midpoint,
// so we keep only the fastest third of recent samples and take their median.
//
// All devices must use the same reference, so we stick with the first source
// and only fall back to the next one if it is unreachable.

export interface TimeSource {
    name: string;
    url: () => string;
    /** Server time in ms since the epoch. */
    parse: (body: string) => number;
}

export interface Sample {
    /** Reference time minus local time, ms. */
    offset: number;
    /** Round trip time, ms. */
    rtt: number;
    /** performance.now() when the sample was taken. */
    at: number;
}

export type ClockState = 'idle' | 'syncing' | 'synced' | 'failed';

export interface ClockSnapshot {
    state: ClockState;
    offset: number;
    rtt: number | null;
    /** How far the best samples disagree, ms. */
    spread: number | null;
    samples: number;
    source: string;
}

const rand = () => Math.random().toString(36).slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const TIME_SOURCES: TimeSource[] = [
    {
        // Answers "1790806668.777" (seconds, ms precision), sends CORS and
        // Timing-Allow-Origin, and is served from NTP-disciplined edge servers.
        name: 'time.akamai.com',
        url: () => `https://time.akamai.com/?ms&r=${rand()}`,
        parse: (body) => parseFloat(body) * 1000,
    },
    {
        name: 'timeapi.io',
        url: () => `https://timeapi.io/api/Time/current/zone?timeZone=UTC&r=${rand()}`,
        parse: (body) => Date.parse(JSON.parse(body).dateTime.slice(0, 23) + 'Z'),
    },
];

/** Median offset of the fastest third (at least 3) of the samples. */
export function estimate(samples: Sample[]): { offset: number; rtt: number; spread: number } | null {
    if (!samples.length) return null;
    const best = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(3, Math.ceil(samples.length / 3)));
    const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
    const mid = offsets.length >> 1;
    return {
        offset: offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2,
        rtt: best[0].rtt,
        spread: offsets[offsets.length - 1] - offsets[0],
    };
}

export class ClockSync {
    readonly sources: TimeSource[];
    readonly windowMs: number;
    /** Reference time minus local time, ms. */
    offset = 0;
    #sourceIndex = 0;
    #samples: Sample[] = [];
    #busy = false;
    #state: ClockState = 'idle';
    #snapshot: ClockSnapshot;
    #listeners = new Set<() => void>();

    constructor(sources = TIME_SOURCES, windowMs = 180_000) {
        this.sources = sources;
        this.windowMs = windowMs;
        this.#snapshot = this.#makeSnapshot(null);
    }

    get source(): TimeSource {
        return this.sources[this.#sourceIndex];
    }

    /**
     * Shared reference time in ms since the epoch. Based on the monotonic
     * performance clock, so it doesn't jump if the user changes the device clock.
     */
    now(): number {
        return performance.timeOrigin + performance.now() + this.offset;
    }

    fromPerf(perfMs: number): number {
        return performance.timeOrigin + perfMs + this.offset;
    }

    toPerf(globalMs: number): number {
        return globalMs - this.offset - performance.timeOrigin;
    }

    // For React's useSyncExternalStore.
    subscribe = (listener: () => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    getSnapshot = () => this.#snapshot;

    /** Starts syncing in the background. Returns a function that stops it. */
    start(): () => void {
        void this.burst(10);
        const timer = setInterval(() => void this.burst(3), 15_000);
        const onVisible = () => {
            // The monotonic clock can stand still while a device sleeps, which
            // invalidates older samples, so measure from scratch.
            if (document.visibilityState !== 'visible') return;
            this.#samples = [];
            void this.burst(8);
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }

    async burst(count: number): Promise<void> {
        if (this.#busy) return;
        this.#busy = true;
        if (this.#state !== 'synced') this.#setState('syncing');
        let failures = 0;
        for (let i = 0; i < count; i++) {
            try {
                this.#samples.push(await this.measure());
                failures = 0;
                this.#recompute();
                if (this.#state !== 'synced' && this.#samples.length >= 3) this.#setState('synced');
            } catch (e) {
                console.warn(`Time sample from ${this.source.name} failed:`, e);
                if (++failures >= 3) {
                    if (this.#sourceIndex === this.sources.length - 1) break;
                    this.#sourceIndex++;
                    this.#samples = [];
                    failures = 0;
                }
            }
            await sleep(50);
        }
        this.#busy = false;
        if (this.#samples.length) this.#setState('synced');
        else if (this.#state !== 'synced') this.#setState('failed');
    }

    async measure(): Promise<Sample> {
        const source = this.source;
        const url = source.url();
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 4000);
        let t1 = performance.now();
        let t2: number;
        let body: string;
        try {
            const res = await fetch(url, { cache: 'no-store', credentials: 'omit', signal: abort.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            body = await res.text();
            t2 = performance.now();
        } finally {
            clearTimeout(timeout);
        }

        // Resource Timing gives the moment the request was actually sent and the
        // first response byte arrived, excluding connection setup, queueing and
        // body download. Needs Timing-Allow-Origin for cross-origin requests.
        const entry = performance.getEntriesByName(new URL(url).href).at(-1) as PerformanceResourceTiming | undefined;
        if (entry && entry.requestStart > 0 && entry.responseStart >= entry.requestStart) {
            t1 = entry.requestStart;
            t2 = entry.responseStart;
        }
        performance.clearResourceTimings();

        const server = source.parse(body);
        if (!Number.isFinite(server)) throw new Error(`Unexpected answer: ${body.slice(0, 80)}`);
        return { offset: server - (performance.timeOrigin + (t1 + t2) / 2), rtt: t2 - t1, at: t2 };
    }

    #recompute() {
        const cutoff = performance.now() - this.windowMs;
        this.#samples = this.#samples.filter((s) => s.at >= cutoff);
        const est = estimate(this.#samples);
        if (est) this.offset = est.offset;
        this.#publish(est);
    }

    #setState(state: ClockState) {
        this.#state = state;
        this.#publish(estimate(this.#samples));
    }

    #makeSnapshot(est: ReturnType<typeof estimate>): ClockSnapshot {
        return {
            state: this.#state,
            offset: this.offset,
            rtt: est?.rtt ?? null,
            spread: est?.spread ?? null,
            samples: this.#samples.length,
            source: this.source.name,
        };
    }

    #publish(est: ReturnType<typeof estimate>) {
        this.#snapshot = this.#makeSnapshot(est);
        for (const l of this.#listeners) l();
    }
}
