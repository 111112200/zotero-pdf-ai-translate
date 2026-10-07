/** Layout model shared by the extraction, translation and rendering stages. */

/**
 * One pdf.js text item after normalization.
 *
 * Coordinates are in PDF points measured from the top-left of the page as the
 * reader sees it, with `/Rotate` already applied. See `geometry.ts`.
 */
export interface TextRun {
  text: string;
  /** Distance from the left page edge. */
  x: number;
  /** Distance from the top page edge. */
  y: number;
  width: number;
  height: number;
  /** Real embedded font name, e.g. `ABCDEF+CMMI9`. */
  fontName: string;
  /** pdf.js resolved font identifier for extracting original math outlines. */
  fontId?: string;
  /** Original math glyph paths in PDF points, relative to their baseline. */
  outlines?: MathGlyph[];
  /** Effective font size derived from the text matrix. */
  fontSize: number;
  /** Original baseline measured downwards in display coordinates. */
  baseline?: number;
  /** Set once formula detection has classified this run. */
  isMath?: boolean;
}

/** A horizontal sequence of runs that shares a baseline. */
export interface TextLine {
  runs: TextRun[];
  /** Left edge of the line's ink. */
  x: number;
  /** Top edge of the line's ink. */
  y: number;
  width: number;
  height: number;
  /** Baseline distance from the top of the page. */
  baseline: number;
  /**
   * Column the line belongs to: `0` for the left one, `1` for the right one,
   * `-1` when the line spans the whole text block.
   */
  column: number;
  /** Line text with runs joined; formulas still in place. */
  text: string;
}

/** A vector math glyph measured in original PDF points. */
export interface MathGlyph {
  /** SVG path with downward-positive y coordinates. */
  path: string;
  /** Advance from the start of the math run. */
  x: number;
  /** Vertical offset for an attached subscript or superscript. */
  y?: number;
}

/** A formula occurrence that must survive translation verbatim. */
export interface MathSpan {
  /** Placeholder token handed to the model, e.g. `⟦M3⟧`. */
  token: string;
  /** Original glyph rectangle, retained for vector reproduction. */
  box?: Box;
  fontSize?: number;
  /** Original baseline shared by this formula's principal glyphs. */
  baseline?: number;
  /** Original glyph contours; no complete-page drawing is needed. */
  outlines?: MathGlyph[];
  /** Original text, re-inserted into the translation. */
  text: string;
}

/**
 * Axis-aligned rectangle in normalized page coordinates.
 *
 * `top`/`bottom` are measured downwards from the top of the page.
 */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * A paragraph in reading order together with the geometry needed to draw its
 * translation back into the same place on the page.
 *
 * The renderer relies on this to keep the original column structure: a
 * paragraph already lives inside one column, so re-flowing its translation
 * inside `box` cannot change the page's column layout.
 */
export interface Paragraph {
  /** Text with formulas replaced by placeholder tokens. */
  source: string;
  /** Formulae removed from `source`, in placeholder order. */
  math: MathSpan[];
  /** Column the paragraph came from; 0-based. */
  column: number;
  /** True when the whole paragraph is a display formula and must not be touched. */
  isFormulaBlock: boolean;
  /** Union of the paragraph's line boxes. */
  box: Box;
  /** Per-line boxes, used for tight whiteout rectangles. */
  lineBoxes: Box[];
  /** Baseline positions of the original lines, top-down. */
  baselines: number[];
  /** Nominal font size of the original text. */
  fontSize: number;
  /** Original baseline-to-baseline distance. */
  leading: number;
  /** True when most source text uses a bold font. */
  bold?: boolean;
  /** Alignment inherited from centered source headings. */
  alignment?: "left" | "center";
}

/** Everything the renderer needs from one source page. */
export interface PageContent {
  index: number;
  /** Page size as displayed, after `/Rotate`. */
  width: number;
  height: number;
  rotate: number;
  paragraphs: Paragraph[];
  /** Graphic and table placements excluded from translation. */
  protectedRegions?: Box[];
  /** Raster image placements found on the page, for diagnostics. */
  imageCount: number;
}
