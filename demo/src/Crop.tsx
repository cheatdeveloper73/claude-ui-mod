import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { Scene } from './Scene';
import { W, H } from './layout';

/* A crop is the same scene, shown through a smaller window.
 *
 * The inner wrapper always carries a transform, even at scale 1: a transformed
 * ancestor is the containing block for `position: fixed`, which is how the
 * plugins place themselves. Without it they would anchor to the viewport and
 * ignore the crop entirely.
 *
 * A crop may also move: `camera` is a list of keyframes, in seconds from the
 * start of the crop, that the frame is eased between. The scene underneath
 * never changes; only the rectangle looked through does.
 */
export type Camera = { at: number; x: number; y: number; scale: number };

const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export const Crop: React.FC<{
    x: number;
    y: number;
    scale?: number;
    offset: number;
    camera?: Camera[];
    windows?: [number, number][];
}> = ({ x, y, scale = 1, offset, camera, windows }) => {
    const frame = useCurrentFrame();
    const { fps } = useVideoConfig();
    let cx = x;
    let cy = y;
    let cs = scale;
    if (camera && camera.length) {
        const sec = frame / fps;
        let i = 0;
        while (i < camera.length - 1 && sec >= camera[i + 1].at) i++;
        const a = camera[i];
        const b = camera[Math.min(i + 1, camera.length - 1)];
        const k = a === b ? 0 : ease(interpolate(sec, [a.at, b.at], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
        cx = a.x + (b.x - a.x) * k;
        cy = a.y + (b.y - a.y) * k;
        cs = a.scale + (b.scale - a.scale) * k;
    }
    return (
        <AbsoluteFill style={{ background: '#000', overflow: 'hidden' }}>
            <div
                style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    width: W,
                    height: H,
                    transformOrigin: '0 0',
                    transform: `scale(${cs}) translate(${-cx}px, ${-cy}px)`,
                }}
            >
                <Scene offset={offset} windows={windows} />
            </div>
        </AbsoluteFill>
    );
};
