/** 83 -> "1:23", 3723 -> "1:02:03" */
export function fmtTime(sec: number): string {
    const total = Math.max(0, Math.floor(sec));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 2.345 -> "2.3 ms", 1234 -> "1.23 s" (sign is dropped) */
export function fmtMs(ms: number): string {
    const abs = Math.abs(ms);
    return abs >= 1000 ? `${(abs / 1000).toFixed(2)} s` : `${abs.toFixed(abs < 10 ? 1 : 0)} ms`;
}

/** "1:30" -> 90, "45" -> 45, anything invalid -> 0 */
export function parsePosition(text: string): number {
    if (!text.trim()) return 0;
    const parts = text.trim().split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n) || n < 0)) return 0;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function isHttpUrl(text: string): boolean {
    return /^https?:\/\/\S+$/i.test(text);
}

/** "https://x.org/music/My_Track.mp3" -> "My Track" */
export function titleFromUrl(url: string): string {
    try {
        const u = new URL(url);
        const file = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() ?? '');
        return (
            file
                .replace(/\.[a-z0-9]{2,4}$/i, '')
                .replace(/[_+]+/g, ' ')
                .trim() || u.hostname
        );
    } catch {
        return url;
    }
}

export function hostFromUrl(url: string): string {
    try {
        return new URL(url).hostname;
    } catch {
        return '';
    }
}
