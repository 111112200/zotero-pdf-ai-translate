/** Graphic placements and ruled tables protected from translation and whiteout. */
import type { PageGeometry } from './geometry';
import type { Box, TextRun } from './types';
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
export function graphicRegions(list: Operators, ops: Record<string, number>, geometry: PageGeometry): Box[] {
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
