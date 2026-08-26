/* Window geometry for the mock, and the rail placement computed the way the
 * plugin computes it — gutter between the sidebar's right edge and the
 * composer's left edge, bottom flush with the composer box.
 */
export const W = 1440;
export const H = 900;

export const TITLEBAR = 36;
export const SIDEBAR = 240;

export const COL_W = 700;                       // the composer / transcript column
export const COL_X = SIDEBAR + Math.round((W - SIDEBAR - COL_W) / 2);

export const COMPOSER_H = 124;
export const COMPOSER_BOTTOM = H - 28;          // y of the composer box's bottom edge
export const COMPOSER_TOP = COMPOSER_BOTTOM - COMPOSER_H;
export const FOOTER_H = 30;                     // the model/effort row inside the box

// task-rail: GAP 12, WIDTH 264, MIN_WIDTH 190, max height 460.
const GAP = 12;
const RAIL_MAX_W = 264;
const gutterLeft = SIDEBAR + GAP;
const gutterRight = COL_X - GAP;
export const RAIL_W = Math.min(RAIL_MAX_W, gutterRight - gutterLeft);
export const RAIL_X = Math.round(gutterLeft + (gutterRight - gutterLeft - RAIL_W) / 2);
export const RAIL_BOTTOM = H - COMPOSER_BOTTOM;
export const RAIL_MAX_H = Math.min(460, H - RAIL_BOTTOM - 24);

// usage-bar: floats over the free middle of the footer row, between the left
// cluster and the ml-auto model/effort group.
export const FOOTER_Y = COMPOSER_BOTTOM - FOOTER_H;
export const USAGE_LEFT = COL_X + 56;
export const USAGE_RIGHT = COL_X + COL_W - 128;
