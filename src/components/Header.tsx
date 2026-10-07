import { useClock } from '../hooks/stores.ts';
import { navigate } from '../hooks/useHashSession.ts';

export function Header({ onClockClick }: { onClockClick: () => void }) {
    return (
        <header className="top">
            <a
                className="brand"
                href="./"
                onClick={(e) => {
                    e.preventDefault();
                    navigate(null);
                }}
            >
                <span className="bars" aria-hidden="true">
                    <i />
                    <i />
                    <i />
                    <i />
                </span>
                SyncPlay
            </a>
            <ClockPill onClick={onClockClick} />
        </header>
    );
}

function ClockPill({ onClick }: { onClick: () => void }) {
    const clock = useClock();
    const precision = Math.max(1, Math.round((clock.spread ?? 0) / 2));
    const text =
        clock.state === 'synced'
            ? `Clock synced ±${precision} ms`
            : clock.state === 'failed'
              ? 'Time server unreachable'
              : 'Syncing clock…';
    return (
        <button
            type="button"
            className="pill clock-pill"
            data-state={clock.state}
            onClick={onClick}
            title={
                clock.state === 'failed'
                    ? 'Could not reach a time server, so this device’s own clock is used.'
                    : 'This device’s clock is measured against a shared internet time server.'
            }
        >
            <span className="dot" />
            <span>{text}</span>
        </button>
    );
}
