import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useRef, useState } from 'react';
import { sessionLink, type Session } from '../lib/session.ts';

const COPY_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘C' : 'Ctrl+C';

export function ShareCard({ session }: { session: Session }) {
    const link = sessionLink(session);
    const inputRef = useRef<HTMLInputElement>(null);
    const [copyLabel, setCopyLabel] = useState('Copy');
    const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
    useEffect(() => () => clearTimeout(resetTimer.current), []);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(link);
            setCopyLabel('Copied!');
        } catch {
            inputRef.current?.select();
            setCopyLabel(`Press ${COPY_SHORTCUT}`);
        }
        clearTimeout(resetTimer.current);
        resetTimer.current = setTimeout(() => setCopyLabel('Copy'), 1800);
    };

    const share = () => {
        navigator
            .share({ title: `SyncPlay: ${session.title}`, text: 'Join and play this in sync with us', url: link })
            .catch(() => {});
    };

    return (
        <section className="card share">
            <div className="share-head">
                <b>Invite others</b>
                <span>They open the link and tap join, even after it has started.</span>
            </div>
            <div className="qr-wrap">
                <div className="qr">
                    <QRCodeSVG
                        value={link}
                        size={180}
                        level="L"
                        bgColor="#ffffff"
                        fgColor="#0b0b0f"
                        title="Invite link"
                    />
                </div>
            </div>
            <div className="share-row">
                <input
                    ref={inputRef}
                    readOnly
                    value={link}
                    aria-label="Invite link"
                    onFocus={(e) => e.target.select()}
                />
                <button type="button" className="btn small" onClick={copy}>
                    {copyLabel}
                </button>
            </div>
            {typeof navigator.share === 'function' && (
                <button type="button" className="btn secondary" onClick={share}>
                    Share invite…
                </button>
            )}
        </section>
    );
}
