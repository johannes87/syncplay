import { useRef, useState } from 'react';
import { navigate } from '../hooks/useHashSession.ts';
import { useUrlCheck } from '../hooks/useUrlCheck.ts';
import { isHttpUrl, parsePosition } from '../lib/format.ts';
import { clock, engine } from '../lib/instances.ts';
import { makeSession } from '../lib/session.ts';
import { LAST_URL_KEY, load, save } from '../lib/storage.ts';

const DELAYS = [
    { seconds: 3, label: 'Right away' },
    { seconds: 30, label: 'In 30 s' },
    { seconds: 60, label: 'In 1 min' },
    { seconds: 300, label: 'In 5 min' },
];

export function SetupView() {
    const [url, setUrl] = useState(() => load(LAST_URL_KEY) ?? '');
    const [delay, setDelay] = useState(30);
    const [position, setPosition] = useState('');
    const [loop, setLoop] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const check = useUrlCheck(url);
    const status = submitError ? { state: 'bad', text: submitError } : check;

    const start = (e: { preventDefault(): void }) => {
        e.preventDefault();
        const trimmed = url.trim();
        if (!isHttpUrl(trimmed)) {
            setSubmitError(trimmed ? 'Paste a full link, starting with https://' : 'Paste a link to a song first.');
            inputRef.current?.focus();
            return;
        }
        save(LAST_URL_KEY, trimmed);
        const session = makeSession({
            url: trimmed,
            // Round to a full second so the start time reads nicely.
            start: Math.ceil((clock.now() + delay * 1000) / 1000) * 1000,
            pos: parsePosition(position),
            loop,
        });
        engine.unlock(); // we're inside the tap, so audio is allowed now
        void engine.join(session);
        navigate(session);
    };

    return (
        <main className="view">
            <h1>
                Every phone.
                <br />
                <span className="accent">Same beat.</span>
            </h1>
            <p className="lede">
                Paste a link to a song and share the invite. Every device that joins plays it at exactly the same
                moment, even if their clocks are off.
            </p>

            <form onSubmit={start} noValidate>
                <label className="field">
                    <span className="label">Song link</span>
                    <input
                        ref={inputRef}
                        type="url"
                        inputMode="url"
                        placeholder="https://example.com/track.mp3"
                        autoComplete="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        value={url}
                        onChange={(e) => {
                            setUrl(e.target.value);
                            setSubmitError(null);
                        }}
                    />
                </label>
                <p className="url-status" data-state={status.state} aria-live="polite">
                    {status.text}
                </p>

                <div className="field">
                    <span className="label">Start</span>
                    <div className="chips" role="radiogroup" aria-label="Start">
                        {DELAYS.map((d) => (
                            <button
                                key={d.seconds}
                                type="button"
                                className="chip"
                                role="radio"
                                aria-checked={delay === d.seconds}
                                onClick={() => setDelay(d.seconds)}
                            >
                                {d.label}
                            </button>
                        ))}
                    </div>
                </div>

                <details className="more">
                    <summary>More options</summary>
                    <div className="more-body">
                        <label className="field inline">
                            <span className="label">Start from</span>
                            <input
                                type="text"
                                inputMode="numeric"
                                placeholder="0:00"
                                value={position}
                                onChange={(e) => setPosition(e.target.value)}
                            />
                        </label>
                        <label className="toggle">
                            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
                            <span className="track">
                                <span className="knob" />
                            </span>
                            Loop the song
                        </label>
                    </div>
                </details>

                <button className="btn primary big" type="submit">
                    Start &amp; get invite link
                </button>
            </form>

            <ol className="steps">
                <li>
                    <b>1</b>Paste a link
                </li>
                <li>
                    <b>2</b>Share the invite
                </li>
                <li>
                    <b>3</b>Everyone taps join
                </li>
            </ol>
        </main>
    );
}
