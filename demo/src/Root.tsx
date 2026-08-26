import React from 'react';
import { Composition } from 'remotion';
import { Scene, DURATION, CAPTION_H } from './Scene';
import { Crop } from './Crop';
import { W, H, COL_X, FOOTER_Y, TITLEBAR } from './layout';

const FPS = 30;
const secs = (n: number) => Math.round(n * FPS);

/* One tour of the whole window, plus four crops of the same timeline — each is
 * the same scene seen through a smaller rectangle, starting at the moment that
 * plugin does something.
 */
export const RemotionRoot: React.FC = () => (
    <>
        <Composition
            id="tour"
            component={Scene as any}
            durationInFrames={secs(DURATION)}
            fps={FPS}
            width={W}
            height={H + CAPTION_H}
            defaultProps={{ offset: 0, captions: true }}
        />

        {/* the rail, from its first tasks through two status flips */}
        <Composition
            id="crop-task-rail"
            component={Crop as any}
            durationInFrames={secs(8)}
            fps={FPS}
            width={420}
            height={768}
            defaultProps={{ x: 236, y: 384, scale: 1.5, offset: 2.0 }}
        />

        {/* the meters in the composer footer */}
        <Composition
            id="crop-usage-bar"
            component={Crop as any}
            durationInFrames={secs(7)}
            fps={FPS}
            width={1420}
            height={180}
            defaultProps={{ x: COL_X - 20, y: FOOTER_Y - 32, scale: 2, offset: 2.6 }}
        />

        {/* the dashboard, with the composer footer still in shot so the setting
            can be seen landing in the running app */}
        <Composition
            id="crop-dashboard"
            component={Crop as any}
            durationInFrames={secs(6.2)}
            fps={FPS}
            width={1220}
            height={790}
            defaultProps={{ x: 110, y: 80, scale: 1, offset: 9.3 }}
        />

        {/* transcript typography and thinking blocks */}
        <Composition
            id="crop-transcript"
            component={Crop as any}
            durationInFrames={secs(6)}
            fps={FPS}
            width={1000}
            height={790}
            defaultProps={{ x: COL_X - 12, y: TITLEBAR + 4, scale: 1.35, offset: 14.6 }}
        />
    </>
);
