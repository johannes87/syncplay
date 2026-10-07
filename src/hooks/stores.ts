import { useEffect, useState, useSyncExternalStore } from 'react';
import { clock, engine } from '@/lib/instances.ts';

export const useClock = () => useSyncExternalStore(clock.subscribe, clock.getSnapshot);

export const useEngine = () => useSyncExternalStore(engine.subscribe, engine.getSnapshot);

/** Reference time, refreshed every `intervalMs`. */
export function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => clock.now());
    useEffect(() => {
        const id = setInterval(() => setNow(clock.now()), intervalMs);
        return () => clearInterval(id);
    }, [intervalMs]);
    return now;
}
