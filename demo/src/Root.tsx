import React from 'react';
import { Composition } from 'remotion';
import { Scene, CAPTION_H, TOUR_SECONDS } from './Scene';
import { SCENE_END } from './story';
import { Crop } from './Crop';
import { PluginWall, WALL_W, WALL_H, WALL_SECONDS } from './PluginWall';
import { W, H, COL_X, COL_W, TITLEBAR, REGION_TOP, FOOTER_Y } from './layout';

const FPS = 30;
const secs = (n: number) => Math.round(n * FPS);

/* One tour of the whole window, plus crops of the same timeline — each is the
 * same scene seen through a smaller rectangle, starting at the moment that
 * plugin does something.
 */
export const RemotionRoot: React.FC = () => (
    <>
        {/* the whole window, through the tour's windows (see TOUR_WINDOWS) */}
        <Composition
            id="tour"
            component={Scene as any}
            durationInFrames={secs(TOUR_SECONDS)}
            fps={FPS}
            width={W}
            height={H + CAPTION_H}
            defaultProps={{ offset: 0, captions: true, tour: true }}
        />

        {/* a title card, not a plugin render: the plugin list as a wall that counts up to its total */}
        <Composition
            id="plugin-wall"
            component={PluginWall}
            durationInFrames={secs(WALL_SECONDS)}
            fps={FPS}
            width={WALL_W}
            height={WALL_H}
        />

        {/* the whole window at scene time, uncut: for scrubbing and for stills */}
        <Composition
            id="scene"
            component={Scene as any}
            durationInFrames={secs(SCENE_END)}
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

        {/* the context meter in the composer footer */}
        <Composition
            id="crop-usage-bar"
            component={Crop as any}
            durationInFrames={secs(7)}
            fps={FPS}
            width={1200}
            height={140}
            defaultProps={{ x: COL_X + 40, y: FOOTER_Y - 32, scale: 2, offset: 2.6 }}
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
            defaultProps={{ x: COL_X - 12, y: REGION_TOP + 2, scale: 1.35, offset: 14.6 }}
        />

        {/* provider tabs inside the native model picker: Claude to OpenAI and a GPT
            model with its effort, then (a second window, once the scene has settled)
            the Command Code tab, its eight models, and one of them picked. The
            camera starts close on the small menu and pulls back when the list grows. */}
        <Composition
            id="crop-provider-picker"
            component={Crop as any}
            durationInFrames={secs(14.2)}
            fps={FPS}
            width={880}
            height={590}
            defaultProps={{
                x: 603,
                y: 480,
                scale: 1.5,
                offset: 0,
                windows: [[24.7, 31.65], [71.9, 79.15]],
                camera: [
                    { at: 0, x: 603, y: 480, scale: 1.5 },
                    { at: 9.0, x: 603, y: 480, scale: 1.5 },
                    { at: 9.9, x: 486, y: 401, scale: 1.25 },
                    { at: 12.6, x: 486, y: 401, scale: 1.25 },
                    { at: 13.5, x: 603, y: 480, scale: 1.5 },
                ],
            }}
        />

        {/* the subagent rail under the chat title, and the transcript an agent opens to */}
        <Composition
            id="crop-subagents"
            component={Crop as any}
            durationInFrames={secs(9.4)}
            fps={FPS}
            width={980}
            height={700}
            defaultProps={{ x: 240, y: TITLEBAR, scale: 1, offset: 37.2 }}
        />

        {/* the rate chip in the streaming strip, then the readout that splits it */}
        <Composition
            id="crop-throughput"
            component={Crop as any}
            durationInFrames={secs(11)}
            fps={FPS}
            width={1000}
            height={660}
            defaultProps={{
                x: 480,
                y: 280,
                scale: 1.7,
                offset: 0,
                windows: [[34.0, 38.0], [47.8, 54.8]],
                camera: [
                    { at: 0, x: 478, y: 92, scale: 1.35 },
                    { at: 3.2, x: 478, y: 92, scale: 1.35 },
                    { at: 4.2, x: 194, y: 92, scale: 0.95 },
                ],
            }}
        />

        {/* the send queue: enter, edit, steer, delete, and the auto-send as the turn ends */}
        <Composition
            id="crop-queue"
            component={Crop as any}
            durationInFrames={secs(15.2)}
            fps={FPS}
            width={820}
            height={620}
            defaultProps={{ x: COL_X - 30, y: 330, scale: 1.1, offset: 54.9 }}
        />
    </>
);

void COL_W;
