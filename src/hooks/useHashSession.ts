import { useMemo, useSyncExternalStore } from 'react';
import { type Session, parseSession, sessionLink } from '../lib/session.ts';

// The session lives in the URL hash, so invite links, reloads and the back
// button all just work without a router.

const NAVIGATE = 'syncplay:navigate';

function subscribe(onChange: () => void) {
    for (const type of ['popstate', 'hashchange', NAVIGATE]) window.addEventListener(type, onChange);
    return () => {
        for (const type of ['popstate', 'hashchange', NAVIGATE]) window.removeEventListener(type, onChange);
    };
}

export function useHashSession(): Session | null {
    const hash = useSyncExternalStore(subscribe, () => location.hash);
    return useMemo(() => parseSession(hash), [hash]);
}

export function navigate(session: Session | null) {
    history.pushState(null, '', session ? sessionLink(session) : location.pathname);
    window.dispatchEvent(new Event(NAVIGATE));
}
