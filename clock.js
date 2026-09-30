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

const rand = () => Math.random().toString(36).slice(2);

export const TIME_SOURCES = [
    {
        // Answers "1790806668.777" (seconds, ms precision), sends CORS and
        // Timing-Allow-Origin, and is served from NTP-disciplined edge servers.
        name: 'time.akamai.com',
        url: () => `https://time.akamai.com/?ms&r=${rand()}`,
        parse: (text) => parseFloat(text) * 1000,
    },
    {
        name: 'timeapi.io',
        url: () => `https://timeapi.io/api/Time/current/zone?timeZone=UTC&r=${rand()}`,
        parse: (text) => Date.parse(JSON.parse(text).dateTime.slice(0, 23) + 'Z'),
    },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ClockSync extends EventTarget {
    constructor({ sources = TIME_SOURCES, windowMs = 180_000 } = {}) {
        super();
        this.sources = sources;
        this.sourceIndex = 0;
        this.windowMs = windowMs;
        this.samples = [];
        this.offset = 0; // reference time minus local time, in ms
        this.rtt = null; // best round trip time, in ms
        this.spread = null; // how far the best samples disagree, in ms
        this.state = 'idle'; // idle | syncing | synced | failed
    }

    get source() {
        return this.sources[this.sourceIndex];
    }

    // Shared reference time in ms since the epoch. Based on the monotonic
    // performance clock, so it doesn't jump if the user changes the device clock.
    now() {
        return performance.timeOrigin + performance.now() + this.offset;
    }

    fromPerf(perfMs) {
        return performance.timeOrigin + perfMs + this.offset;
    }

    toPerf(globalMs) {
        return globalMs - this.offset - performance.timeOrigin;
    }

    start() {
        this.burst(10);
        setInterval(() => this.burst(3), 15_000);
        document.addEventListener('visibilitychange', () => {
            // The monotonic clock can stand still while a device sleeps, which
            // invalidates older samples, so measure from scratch.
            if (document.visibilityState === 'visible') {
                this.samples = [];
                this.burst(8);
            }
        });
    }

    async burst(count) {
        if (this.busy) return;
        this.busy = true;
        if (this.state !== 'synced') this.#setState('syncing');
        let failures = 0;
        for (let i = 0; i < count; i++) {
            try {
                this.samples.push(await this.measure());
                failures = 0;
                this.#recompute();
                if (this.state !== 'synced' && this.samples.length >= 3) this.#setState('synced');
            } catch (e) {
                console.warn(`Time sample from ${this.source.name} failed:`, e);
                if (++failures >= 3) {
                    if (this.sourceIndex === this.sources.length - 1) break;
                    this.sourceIndex++;
                    this.samples = [];
                    failures = 0;
                }
            }
            await sleep(50);
        }
        this.busy = false;
        if (this.samples.length) this.#setState('synced');
        else if (this.state !== 'synced') this.#setState('failed');
    }

    async measure() {
        const source = this.source;
        const url = source.url();
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 4000);
        let t1 = performance.now();
        let t2, text;
        try {
            const res = await fetch(url, {
                cache: 'no-store',
                credentials: 'omit',
                signal: abort.signal,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            text = await res.text();
            t2 = performance.now();
        } finally {
            clearTimeout(timeout);
        }

        // Resource Timing gives the moment the request was actually sent and
        // the first response byte arrived, excluding connection setup, queueing
        // and body download. Needs Timing-Allow-Origin for cross-origin requests.
        const entry = performance.getEntriesByName(new URL(url).href).at(-1);
        if (entry && entry.requestStart > 0 && entry.responseStart >= entry.requestStart) {
            t1 = entry.requestStart;
            t2 = entry.responseStart;
        }
        performance.clearResourceTimings();

        const server = source.parse(text);
        if (!Number.isFinite(server)) throw new Error(`Unexpected answer: ${text.slice(0, 80)}`);
        return {
            offset: server - (performance.timeOrigin + (t1 + t2) / 2),
            rtt: t2 - t1,
            at: t2,
        };
    }

    #recompute() {
        const cutoff = performance.now() - this.windowMs;
        this.samples = this.samples.filter((s) => s.at >= cutoff);
        const best = [...this.samples]
            .sort((a, b) => a.rtt - b.rtt)
            .slice(0, Math.max(3, Math.ceil(this.samples.length / 3)));
        const offsets = best.map((s) => s.offset).sort((a, b) => a - b);
        const mid = offsets.length >> 1;
        this.offset = offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
        this.rtt = best[0].rtt;
        this.spread = offsets.at(-1) - offsets[0];
        this.dispatchEvent(new Event('change'));
    }

    #setState(state) {
        this.state = state;
        this.dispatchEvent(new Event('change'));
    }
}
