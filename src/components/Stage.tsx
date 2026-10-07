import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '../lib/format.ts';
import { clock, engine } from '../lib/instances.ts';
import { type Session, isOver } from '../lib/session.ts';

interface Props {
    session: Session;
    duration: number | null;
    state: string;
}

/**
 * The big countdown / position display with a progress ring and a glow that
 * pulses with the bass. Updated every frame straight in the DOM (not through
 * React state) so it stays smooth.
 */
export function Stage({ session, duration, state }: Props) {
    const stageRef = useRef<HTMLDivElement>(null);
    const bigRef = useRef<HTMLDivElement>(null);
    const labelRef = useRef<HTMLDivElement>(null);
    const ringRef = useRef<SVGCircleElement>(null);
    const [countdownFrom] = useState(() => Math.max(0, session.start - clock.now()));

    useEffect(() => {
        const freq = new Uint8Array(512);
        let pulse = 0;
        let raf = 0;
        const frame = () => {
            raf = requestAnimationFrame(frame);
            const now = clock.now();
            const snap = engine.getSnapshot();
            let big: string;
            let label: string;
            let progress: number;
            if (now < session.start) {
                const remaining = session.start - now;
                big = fmtTime(Math.ceil(remaining / 1000));
                label = 'until start';
                progress = countdownFrom ? 1 - remaining / countdownFrom : 0;
            } else if (snap.state === 'ended' || isOver(session, now, duration)) {
                big = duration ? fmtTime(duration) : '–';
                label = 'finished';
                progress = 1;
            } else {
                let pos = (now - session.start) / 1000 + session.pos;
                if (session.loop && duration) pos %= duration;
                big = fmtTime(pos);
                label = duration ? `of ${fmtTime(duration)}` : 'playing now';
                progress = duration ? pos / duration : 0;
            }
            if (bigRef.current!.textContent !== big) bigRef.current!.textContent = big;
            if (labelRef.current!.textContent !== label) labelRef.current!.textContent = label;
            ringRef.current!.style.strokeDashoffset = String(1 - Math.min(1, Math.max(0, progress)));

            // Beat glow from the low end of the spectrum (precise mode only).
            let target = 0;
            if (snap.state === 'playing' && snap.mode === 'precise' && engine.analyser) {
                engine.analyser.getByteFrequencyData(freq);
                target = Math.max(0, ((freq[1] + freq[2] + freq[3] + freq[4]) / 4 / 255 - 0.45) / 0.55);
            }
            pulse += (target - pulse) * (target > pulse ? 0.6 : 0.15);
            stageRef.current!.style.setProperty('--pulse', pulse.toFixed(3));
        };
        raf = requestAnimationFrame(frame);
        return () => cancelAnimationFrame(raf);
    }, [session, duration, countdownFrom]);

    return (
        <div className="stage" ref={stageRef} data-state={state}>
            <svg className="ring" viewBox="0 0 100 100" aria-hidden="true">
                <circle className="ring-bg" cx="50" cy="50" r="46" />
                <circle className="ring-fg" ref={ringRef} cx="50" cy="50" r="46" pathLength="1" />
            </svg>
            <div className="glow" aria-hidden="true" />
            <div className="stage-center">
                <div className="big" ref={bigRef} />
                <div className="big-label" ref={labelRef} />
            </div>
        </div>
    );
}
