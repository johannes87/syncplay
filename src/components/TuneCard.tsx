import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useEngine } from '../hooks/stores.ts';
import { engine } from '../lib/instances.ts';

/** Lets each device shift itself earlier/later, e.g. to make up for Bluetooth delay. */
export function TuneCard() {
    const { latencyMs } = useEngine();
    const [pending, setPending] = useState(latencyMs);
    const pendingRef = useRef(latencyMs);
    const applyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

    // Apply once the user stops tapping: each change makes the audio jump.
    const onStep = useCallback((step: number) => {
        pendingRef.current += step;
        setPending(pendingRef.current);
        clearTimeout(applyTimer.current);
        applyTimer.current = setTimeout(() => {
            applyTimer.current = undefined;
            engine.setLatency(pendingRef.current);
        }, 300);
    }, []);

    useEffect(
        () => () => {
            if (applyTimer.current === undefined) return;
            clearTimeout(applyTimer.current);
            engine.setLatency(pendingRef.current);
        },
        [],
    );

    return (
        <section className="card tune">
            <div className="tune-head">
                <b>Out of step with the others?</b>
                <span>Bluetooth speakers add delay. Nudge this device until the beats line up.</span>
            </div>
            <div className="stepper">
                <StepButton step={10} label="Play earlier" onStep={onStep}>
                    ‹ Earlier
                </StepButton>
                <output>
                    {pending === 0 ? 'In sync' : `${Math.abs(pending)} ms ${pending > 0 ? 'earlier' : 'later'}`}
                </output>
                <StepButton step={-10} label="Play later" onStep={onStep}>
                    Later ›
                </StepButton>
            </div>
        </section>
    );
}

interface StepButtonProps {
    step: number;
    label: string;
    onStep: (step: number) => void;
    children: ReactNode;
}

/** Tap to step once, hold to keep stepping. */
function StepButton({ step, label, onStep, children }: StepButtonProps) {
    const hold = useRef<ReturnType<typeof setInterval>>(undefined);
    const stop = () => clearInterval(hold.current);
    useEffect(() => () => clearInterval(hold.current), []);

    return (
        <button
            type="button"
            className="btn small"
            aria-label={label}
            onPointerDown={(e) => {
                e.preventDefault();
                onStep(step);
                let n = 0;
                stop();
                hold.current = setInterval(() => ++n > 4 && onStep(step), 90);
            }}
            onPointerUp={stop}
            onPointerLeave={stop}
            onPointerCancel={stop}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onStep(step);
                }
            }}
        >
            {children}
        </button>
    );
}
