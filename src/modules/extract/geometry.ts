/**
 * Page coordinate normalization.
 *
 * pdf.js reports text positions in PDF user space, which has three properties
 * that make it unusable directly for layout work:
 *
 *  - the origin is the MediaBox corner, not necessarily `(0, 0)`;
 *  - the y axis points up, while text layout is naturally expressed top-down;
 *  - `/Rotate` is a display attribute and is *not* applied to text transforms.
 *
 * Everything downstream therefore works in "normalized" coordinates: origin at
 * the top-left of the page as the reader sees it, y increasing downwards, and
 * the page already rotated upright. {@link PageGeometry.toNormalized} converts,
 * and {@link PageGeometry.rotationAround} gives the matching transform for
 * drawing the source page into an upright output page.
 */

/** The `/Rotate` values PDF allows, normalized away from negatives. */
export type QuarterTurn = 0 | 90 | 180 | 270;

export interface PageGeometry {
  /** MediaBox width in user space. */
  userWidth: number;
  userHeight: number;
  rotate: QuarterTurn;
  /** Width of the page as displayed, after `/Rotate`. */
  width: number;
  height: number;
  /**
   * Convert a user-space point to normalized top-left coordinates.
   *
   * @param ux - x in PDF user space.
   * @param uy - y in PDF user space (origin bottom-left).
   * @returns the point as the reader sees it, measured from the top-left.
   */
  toNormalized(ux: number, uy: number): { x: number; y: number };
}

/**
 * Build the geometry for one page.
 *
 * @param view - `page.view`, i.e. the MediaBox `[x0, y0, x1, y1]`.
 * @param rotate - `page.rotate` in degrees; values outside the four quarter
 *   turns are reduced modulo 360 and snapped to the nearest quarter.
 * @returns the geometry helper for that page.
 */
export function pageGeometry(view: number[], rotate: number): PageGeometry {
  const [x0, y0, x1, y1] = view;
  const userWidth = x1 - x0;
  const userHeight = y1 - y0;
  const normalized = (((rotate % 360) + 360) % 360) as QuarterTurn;
  const quarter: QuarterTurn =
    normalized === 90 || normalized === 180 || normalized === 270
      ? normalized
      : 0;
  const swapped = quarter === 90 || quarter === 270;
  const width = swapped ? userHeight : userWidth;
  const height = swapped ? userWidth : userHeight;

  return {
    userWidth,
    userHeight,
    rotate: quarter,
    width,
    height,
    toNormalized(ux: number, uy: number) {
      // Move the origin to the MediaBox corner first.
      const px = ux - x0;
      const py = uy - y0;
      // Then apply the display rotation. Each case is a 90 degree clockwise
      // turn of the paper, so the original left edge becomes the top edge.
      let nx: number;
      let ny: number;
      switch (quarter) {
        case 90:
          nx = py;
          ny = userWidth - px;
          break;
        case 180:
          nx = userWidth - px;
          ny = userHeight - py;
          break;
        case 270:
          nx = userHeight - py;
          ny = px;
          break;
        default:
          nx = px;
          ny = py;
          break;
      }
      // Flip the y axis so larger values mean "further down the page".
      return { x: nx, y: height - ny };
    },
  };
}

/**
 * Parameters for drawing the source page so that it appears upright.
 *
 * pdf-lib applies `translate(x, y)` before `rotate(angle)`, so a point `p` of
 * the source page lands at `(x, y) + R(angle) * p`. The values below place the
 * rotated content exactly inside `[0, width] x [0, height]`.
 *
 * @param geometry - geometry of the page being drawn.
 * @returns the placement to hand to `PDFPage.drawPage`.
 */
export function uprightPlacement(geometry: PageGeometry): {
  x: number;
  y: number;
  width: number;
  height: number;
  rotationDegrees: number;
} {
  const { userWidth, userHeight, rotate } = geometry;
  switch (rotate) {
    case 90:
      // R(-90) maps (x, y) to (y, -x); translating by (0, userWidth) lands the
      // content in [0, userHeight] x [0, userWidth].
      return {
        x: 0,
        y: userWidth,
        width: userWidth,
        height: userHeight,
        rotationDegrees: -90,
      };
    case 180:
      return {
        x: userWidth,
        y: userHeight,
        width: userWidth,
        height: userHeight,
        rotationDegrees: 180,
      };
    case 270:
      // R(90) maps (x, y) to (-y, x); translating by (userHeight, 0) lands the
      // content in [0, userHeight] x [0, userWidth].
      return {
        x: userHeight,
        y: 0,
        width: userWidth,
        height: userHeight,
        rotationDegrees: 90,
      };
    default:
      return {
        x: 0,
        y: 0,
        width: userWidth,
        height: userHeight,
        rotationDegrees: 0,
      };
  }
}
