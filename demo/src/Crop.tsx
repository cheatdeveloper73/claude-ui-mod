import React from 'react';
import { AbsoluteFill } from 'remotion';
import { Scene } from './Scene';
import { W, H } from './layout';

/* A crop is the same scene, shown through a smaller window.
 *
 * The inner wrapper always carries a transform, even at scale 1: a transformed
 * ancestor is the containing block for `position: fixed`, which is how the
 * plugins place themselves. Without it they would anchor to the viewport and
 * ignore the crop entirely.
 */
export const Crop: React.FC<{
    x: number;
    y: number;
    scale?: number;
    offset: number;
}> = ({ x, y, scale = 1, offset }) => (
    <AbsoluteFill style={{ background: '#000', overflow: 'hidden' }}>
        <div
            style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: W,
                height: H,
                transformOrigin: '0 0',
                transform: `scale(${scale}) translate(${-x}px, ${-y}px)`,
            }}
        >
            <Scene offset={offset} />
        </div>
    </AbsoluteFill>
);
