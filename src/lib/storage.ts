// localStorage can throw (private mode, blocked site data): never let that break the app.

export function load(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

export function save(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // ignore
    }
}

export const LAST_URL_KEY = 'syncplay.lastUrl';
export const LATENCY_KEY = 'syncplay.latencyMs';
/** Seconds between tapping start and the start, as last chosen on the setup screen. */
export const START_DELAY_KEY = 'syncplay.startDelay';
