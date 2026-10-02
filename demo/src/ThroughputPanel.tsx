import React from 'react';
import { LANES, MODELS, RECENT, LiveRow, PanelRow, liveRowsAt } from './story';

/* The throughput plugin's readout, in its own markup (build()/patch() in
 * src/plugins/throughput/renderer.js) and its own stylesheet. Hop, ttft and gen
 * are the three clocks the router keeps for a response: dispatch to response
 * headers (the upstream hop), dispatch to first content delta (the prefill),
 * and first delta to the terminal event (the generation window).
 */
const fmtTps = (v: number) => (v >= 1000 ? Math.round(v).toLocaleString() : v >= 100 ? v.toFixed(0) : v.toFixed(1));
const fmtMs = (v: number) => (v >= 10000 ? (v / 1000).toFixed(0) + 's' : v >= 1000 ? (v / 1000).toFixed(1) + 's' : Math.round(v) + 'ms');
const fmtTok = (v: number) => (v >= 1e4 ? Math.round(v / 1000) + 'k' : v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v));

const Row: React.FC<{ r: PanelRow; t: number }> = ({ r, t }) => (
    <div className={'r' + (r.flow ? ' flow' : '')} style={{ ['--h' as any]: r.hue }}>
        <div
            className="dot"
            // .flow's own pulse (tpPulse, 1.1s) is frozen with the rest of the sheet.
            style={r.flow ? { opacity: 0.64 + 0.36 * Math.cos((t / 1.1) * Math.PI * 2) } : undefined}
        />
        <div className="nm">
            <b>{r.title}</b>
            <span>{r.sub}</span>
        </div>
        {r.tag && <div className={'tag' + (r.main ? ' main' : '')}>{r.tag}</div>}
        <div className={'val' + (r.est ? ' est' : '')}>
            <b>{r.value}</b>
            <span>{r.unit}</span>
        </div>
    </div>
);

const Section: React.FC<{ title: string; note: string; children: React.ReactNode }> = ({ title, note, children }) => (
    <div className="sec">
        <div className="hd">
            <b>{title}</b>
            <span>{note}</span>
        </div>
        <div className="list">{children}</div>
    </div>
);

const fromLive = (l: LiveRow): PanelRow => ({
    key: 'live:' + l.key,
    title: l.title,
    sub:
        fmtMs(l.elapsedMs) + ' elapsed · ttft ' + fmtMs(l.ttftMs) + (l.tokens !== null ? ' · ' + fmtTok(l.tokens) + ' tok' : ''),
    tag: l.tag,
    main: l.main,
    value: fmtTps(l.tps),
    unit: 'tok/s',
    hue: l.hue,
    flow: true,
    est: l.est,
});

export const ThroughputPanel: React.FC<{ t: number }> = ({ t }) => {
    const live = liveRowsAt(t);
    const sum = live.reduce((s, r) => s + r.tps, 0);
    return (
        <div className="cui-tp">
            <div className="tp">
                <div className="now">
                    <div className="big">{live.length ? fmtTps(sum) : '—'}</div>
                    <div className="unit">tok/s</div>
                    <div className="sd">
                        <div>{live.length ? live.length + ' streaming' : 'last response'}</div>
                        <div>last ttft 640ms · hop 120ms</div>
                    </div>
                </div>

                <Section title="In flight" note={live.length ? '' : 'idle'}>
                    {live.length ? (
                        live.map((l) => <Row key={l.key} r={fromLive(l)} t={t} />)
                    ) : (
                        <div className="empty">nothing yet</div>
                    )}
                </Section>

                <Section title="Lanes, this session" note={LANES.length + ' lanes'}>
                    {LANES.map((r) => (
                        <Row key={r.key} r={r} t={t} />
                    ))}
                </Section>

                <Section title="Models" note="this session · 21 responses">
                    {MODELS.map((r) => (
                        <Row key={r.key} r={r} t={t} />
                    ))}
                </Section>

                <Section title="Recent responses" note="">
                    {RECENT.map((r) => (
                        <Row key={r.key} r={r} t={t} />
                    ))}
                </Section>

                <div className="foot">
                    <span>21 responses recorded · exact provider tokens over router clocks</span>
                    <div className="btn">Show ledger</div>
                </div>
            </div>
        </div>
    );
};
