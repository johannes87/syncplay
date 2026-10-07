import { useEffect, useState } from 'react';
import { probeDuration } from '@/lib/probe.ts';

/** The song's length, known before joining (for "finished" and the progress ring). */
export function useProbedDuration(url: string): number | null {
    const [result, setResult] = useState<{ url: string; duration: number } | null>(null);
    useEffect(() => {
        let cancelled = false;
        probeDuration(url).then(
            (duration) => !cancelled && Number.isFinite(duration) && setResult({ url, duration }),
            () => {},
        );
        return () => {
            cancelled = true;
        };
    }, [url]);
    return result?.url === url ? result.duration : null;
}
