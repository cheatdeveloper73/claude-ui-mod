import React from 'react';
import { interpolate } from 'remotion';

/* One scripted pointer for the whole scene. A stroke is a run of waypoints; the
 * pointer exists only between a stroke's first and last time, and eases from one
 * waypoint to the next. Presses are listed separately so a click can be seen
 * without the pointer having to stop. */
export type Waypoint = [number, number, number];   // [t, x, y]

const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

export function pointerAt(strokes: Waypoint[][], t: number): { x: number; y: number; a: number } | null {
    for (const pts of strokes) {
        const first = pts[0][0];
        const last = pts[pts.length - 1][0];
        if (t < first - 0.15 || t > last + 0.15) continue;
        const a = Math.min(
            interpolate(t, [first - 0.15, first], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
            interpolate(t, [last, last + 0.15], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        );
        if (t <= first) return { x: pts[0][1], y: pts[0][2], a };
        if (t >= last) return { x: pts[pts.length - 1][1], y: pts[pts.length - 1][2], a };
        for (let i = 0; i < pts.length - 1; i++) {
            const [t0, x0, y0] = pts[i];
            const [t1, x1, y1] = pts[i + 1];
            if (t >= t0 && t <= t1) {
                const k = t1 === t0 ? 1 : ease((t - t0) / (t1 - t0));
                return { x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, a };
            }
        }
    }
    return null;
}

export const pressedAt = (presses: [number, number][], t: number) => presses.some(([a, b]) => t >= a && t <= b);

export const Pointer: React.FC<{ x: number; y: number; a: number; pressed: boolean }> = ({ x, y, a, pressed }) => (
    <div
        style={{
            position: 'absolute',
            left: x,
            top: y,
            width: 18,
            height: 18,
            zIndex: 2147483647,
            pointerEvents: 'none',
            opacity: a,
            transform: pressed ? 'scale(.88)' : 'none',
        }}
    >
        <svg viewBox="0 0 12 18" width="18" height="26">
            <path
                d="M1 1 L1 15 L4.5 11.6 L7 17 L9.4 16 L6.9 10.8 L11 10.7 Z"
                fill="#fff"
                stroke="rgba(0,0,0,.65)"
                strokeWidth="1"
            />
        </svg>
    </div>
);
