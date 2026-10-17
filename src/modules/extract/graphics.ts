/** Graphic placements and ruled tables protected from translation and whiteout. */
import type { PageGeometry } from './geometry';
import type { Box, ShadedRegion, TextRun } from './types';
type Matrix = [
    number,
    number,
    number,
    number,
    number,
    number
];
export interface Operators {
    fnArray: number[];
    argsArray: unknown[][];
}
/** Read painted bounds, including nested Form XObjects and their transforms. */
export function graphicRegions(list: Operators, ops: Record<string, number>, geometry: PageGeometry, runs: TextRun[] = []): Box[] {
    let matrix: Matrix = [1, 0, 0, 1, 0, 0];
    const stack: Matrix[] = [];
    const forms: Array<{
        box?: Box;
        painted: boolean;
    }> = [];
    const regions: Box[] = [];
    const paths: Box[] = [];
    let pending: Box | undefined;
    const transformBox = (bounds: number[]): Box => {
        const points = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[0], bounds[3]], [bounds[2], bounds[3]]].map(([x, y]) => geometry.toNormalized(matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]));
        const box = { left: Math.max(0, Math.min(...points.map(p => p.x))), right: Math.min(geometry.width, Math.max(...points.map(p => p.x))), top: Math.max(0, Math.min(...points.map(p => p.y))), bottom: Math.min(geometry.height, Math.max(...points.map(p => p.y))) };
        for (const form of forms)
            if (form.box) {
                box.left = Math.max(box.left, form.box.left);
                box.right = Math.min(box.right, form.box.right);
                box.top = Math.max(box.top, form.box.top);
                box.bottom = Math.min(box.bottom, form.box.bottom);
            }
        return box;
    };
    const painted = () => { for (const form of forms)
        form.painted = true; };
    for (let i = 0; i < list.fnArray.length; i++) {
        const fn = list.fnArray[i], args = list.argsArray[i];
        if (fn === ops.save)
            stack.push([...matrix]);
        else if (fn === ops.restore)
            matrix = stack.pop() ?? matrix;
        else if (fn === ops.transform)
            matrix = multiply(matrix, args as Matrix);
        else if (fn === ops.paintFormXObjectBegin) {
            stack.push([...matrix]);
            if (args[0])
                matrix = multiply(matrix, args[0] as Matrix);
            forms.push({ box: args[1] ? transformBox(args[1] as number[]) : undefined, painted: false });
        }
        else if (fn === ops.paintFormXObjectEnd) {
            const form = forms.pop();
            if (form?.painted && form.box && usable(form.box, geometry))
                regions.push(form.box);
            matrix = stack.pop() ?? matrix;
        }
        else if (['paintImageXObject', 'paintInlineImageXObject', 'paintImageMaskXObject', 'paintJpegXObject'].some(name => ops[name] === fn)) {
            const box = transformBox([0, 0, 1, 1]);
            if (usable(box, geometry))
                regions.push(box);
            painted();
        }
        else if (fn === ops.constructPath) {
            const bounds = args[2] as number[] | undefined;
            if (bounds?.length === 4 && bounds.every(Number.isFinite))
                pending = transformBox(bounds);
        }
        else if (['stroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke', 'closeStroke', 'closeFillStroke', 'closeEOFillStroke'].some(name => ops[name] === fn)) {
            if (pending) {
                paths.push(pending);
                painted();
            }
            pending = undefined;
        }
        else if (fn === ops.endPath)
            pending = undefined;
    }
    // Connected vector marks enclose chart labels. Thin horizontal rules also
    // enclose table rows, even when the PDF has no vertical cell borders.
    const rules = paths.filter(b => b.right - b.left > 40 && b.bottom - b.top < 2);
    for (const caption of runs.filter(run => /^Algorithm(?:\s+\d+\b|\s*$)/i.test(run.text))) {
        const top = rules.filter(rule => Math.abs(rule.top - caption.y) < caption.fontSize * 1.5 && rule.left <= caption.x + 3 && rule.right >= caption.x + caption.width - 3)
            .sort((a, b) => Math.abs(a.top - caption.y) - Math.abs(b.top - caption.y))[0];
        if (!top) continue;
        const aligned = rules.filter(rule => Math.abs(rule.left - top.left) < 3 && Math.abs(rule.right - top.right) < 3 && rule.top >= top.top && rule.top - top.top < geometry.height * 0.45);
        if (aligned.length >= 3) regions.push(union(aligned));
    }
    for (const rule of rules) {
        const aligned = rules.filter(b => Math.abs(b.left - rule.left) < 8 && Math.abs(b.right - rule.right) < 8 && Math.abs(b.top - rule.top) < 100);
        if (aligned.length >= 3)
            regions.push(union(aligned));
    }
    const clusters = paths.filter(b => usable(b, geometry));
    for (let i = 0; i < clusters.length; i++) {
        for (let j = i + 1; j < clusters.length; j++) {
            if (touches(clusters[i], clusters[j], 6)) {
                clusters[i] = union([clusters[i], clusters[j]]);
                clusters.splice(j, 1);
                i = -1;
                break;
            }
        }
    }
    regions.push(...clusters.filter(b => b.right - b.left > 20 && b.bottom - b.top > 20));
    return regions.filter(b => usable(b, geometry)).map(b => ({ left: b.left - 1, top: b.top - 1, right: b.right + 1, bottom: b.bottom + 1 }));
}
/** True when a text run intersects a protected graphic placement. */
export function insideGraphic(run: TextRun, regions: Box[]): boolean {
    return regions.some(b => run.x < b.right && run.x + run.width > b.left && run.y + run.height > b.top && run.y < b.bottom);
}

/**
 * Read a pdf.js colour operand as 0..1 RGB.
 *
 * pdf.js hands these back as a typed array of 0..255 components (the `args` entry
 * *is* the array), while older builds and some operators use a plain float list,
 * so both shapes and both ranges are accepted.
 *
 * @param args - the operator's arguments.
 * @param channels - number of components the operator takes.
 * @returns components in 0..1, or `undefined` when the shape is unexpected.
 */
function readColor(args: unknown, channels: number): number[] | undefined {
    if (!Array.isArray(args) && !ArrayBuffer.isView(args)) {
        return undefined;
    }
    const outer = args as ArrayLike<unknown>;
    const first = outer[0];
    const raw = (Array.isArray(first) || ArrayBuffer.isView(first) ? first : args) as ArrayLike<number>;
    if (raw.length < channels) {
        return undefined;
    }
    const values = Array.from({ length: channels }, (_, index) => Number(raw[index]));
    if (!values.every(Number.isFinite)) {
        return undefined;
    }
    const scale = values.some(value => value > 1) ? 255 : 1;
    return values.map(value => Math.min(1, Math.max(0, value / scale)));
}

/**
 * Non-white filled areas of a page, with their fill colour.
 *
 * The renderer covers original text with a filled rectangle. Painting it white
 * is only correct on a white page: over a tinted background, a shaded table row
 * or a coloured band, a white cover shows up as a patch. Recording the fills
 * lets each cover take the colour of whatever it is covering.
 *
 * @param list - the page's operator list.
 * @param ops - pdf.js `OPS`.
 * @param geometry - page geometry, for coordinate normalization.
 * @returns filled regions whose colour is not white, largest first.
 */
export function filledBackgrounds(list: Operators, ops: Record<string, number>, geometry: PageGeometry): ShadedRegion[] {
    let matrix: Matrix = [1, 0, 0, 1, 0, 0];
    const matrixStack: Matrix[] = [];
    let fill: [number, number, number] = [1, 1, 1];
    const fillStack: Array<[number, number, number]> = [];
    let pending: Box | undefined;
    const regions: ShadedRegion[] = [];

    const clamp = (box: Box): Box => ({
        left: Math.max(0, box.left),
        right: Math.min(geometry.width, box.right),
        top: Math.max(0, box.top),
        bottom: Math.min(geometry.height, box.bottom),
    });

    const space = (bounds: number[]): Box => {
        const points = [[bounds[0], bounds[1]], [bounds[2], bounds[1]], [bounds[0], bounds[3]], [bounds[2], bounds[3]]]
            .map(([x, y]) => geometry.toNormalized(matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]));
        return clamp({
            left: Math.min(...points.map(p => p.x)),
            right: Math.max(...points.map(p => p.x)),
            top: Math.min(...points.map(p => p.y)),
            bottom: Math.max(...points.map(p => p.y)),
        });
    };

    const fillOps = new Set([ops.fill, ops.eoFill, ops.fillStroke, ops.eoFillStroke, ops.closeFillStroke, ops.closeEOFillStroke]
        .filter((value): value is number => typeof value === "number"));

    for (let i = 0; i < list.fnArray.length; i++) {
        const fn = list.fnArray[i], args = list.argsArray[i];
        if (fn === ops.save) {
            matrixStack.push([...matrix]);
            fillStack.push([...fill]);
        } else if (fn === ops.restore) {
            matrix = matrixStack.pop() ?? matrix;
            fill = fillStack.pop() ?? fill;
        } else if (fn === ops.transform) {
            matrix = multiply(matrix, args as Matrix);
        } else if (fn === ops.setFillRGBColor) {
            const color = readColor(args, 3);
            if (color) fill = [color[0], color[1], color[2]];
        } else if (fn === ops.setFillGray) {
            const color = readColor(args, 1);
            if (color) fill = [color[0], color[0], color[0]];
        } else if (fn === ops.setFillCMYKColor) {
            const color = readColor(args, 4);
            if (color) {
                const [c, m, y, k] = color;
                fill = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
            }
        } else if (fn === ops.constructPath) {
            const bounds = args[2] as number[] | undefined;
            pending = bounds?.length === 4 && bounds.every(Number.isFinite) ? space(bounds) : undefined;
        } else if (fillOps.has(fn)) {
            if (pending && pending.right > pending.left && pending.bottom > pending.top && !isWhiteFill(fill)) {
                regions.push({ box: pending, color: [...fill] as [number, number, number] });
            }
            pending = undefined;
        } else if (fn === ops.endPath) {
            pending = undefined;
        }
    }
    return regions.sort((a, b) => (b.box.right - b.box.left) * (b.box.bottom - b.box.top) - (a.box.right - a.box.left) * (a.box.bottom - a.box.top));
}

/** True when a fill colour is close enough to white to be the default page. */
function isWhiteFill(color: [number, number, number]): boolean {
    return color.every(value => value >= 0.99);
}
/** True when two boxes overlap or are separated by at most the given distance. */
export function touches(a: Box, b: Box, gap = 0): boolean {
    return a.left <= b.right + gap && a.right + gap >= b.left && a.top <= b.bottom + gap && a.bottom + gap >= b.top;
}
function usable(b: Box, g: PageGeometry): boolean {
    return b.right - b.left >= 0 && b.bottom - b.top >= 0 && (b.right - b.left) * (b.bottom - b.top) < g.width * g.height * 0.65;
}
function union(boxes: Box[]): Box {
    return { left: Math.min(...boxes.map(b => b.left)), top: Math.min(...boxes.map(b => b.top)), right: Math.max(...boxes.map(b => b.right)), bottom: Math.max(...boxes.map(b => b.bottom)) };
}
function multiply(a: Matrix, b: Matrix): Matrix {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
/** Recognize borderless text grids with at least three repeated cell columns. */
export function textTableRegions(runs: TextRun[]): Box[] {
    const rows: TextRun[][] = [];
    for (const run of [...runs].sort((a, b) => a.y - b.y || a.x - b.x)) {
        const row = rows[rows.length - 1];
        if (row && Math.abs(run.y - row[0].y) < Math.max(run.fontSize, row[0].fontSize) * 0.3)
            row.push(run);
        else
            rows.push([run]);
    }
    const cells = rows.map(row => {
        const merged: TextRun[] = [];
        for (const run of row.sort((a, b) => a.x - b.x)) {
            const previous = merged[merged.length - 1];
            if (previous && run.x - (previous.x + previous.width) < run.fontSize * 1.5) {
                previous.width = Math.max(previous.width, run.x + run.width - previous.x);
                previous.text += ' ' + run.text;
            }
            else
                merged.push({ ...run });
        }
        return merged;
    }).filter(row => row.length >= 3 && row.every(cell => cell.text.length < 40));
    const regions: Box[] = [];
    for (const row of cells) {
        const aligned = cells.filter(other => other.length === row.length && Math.abs(other[0].y - row[0].y) < 100 && other.every((cell, i) => Math.abs(cell.x - row[i].x) < 5));
        if (aligned.length >= 3)
            regions.push(union(aligned.flat().map(run => ({ left: run.x, top: run.y, right: run.x + run.width, bottom: run.y + run.height }))));
    }
    return regions;
}
