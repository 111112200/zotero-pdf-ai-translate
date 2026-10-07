/** Inline text and original formula glyphs measured together for wrapping. */
import type { PDFFont } from 'pdf-lib';
import type { MathSpan, Paragraph } from '../extract/types';
import { isCJK } from './typeset';
export interface InlinePiece {
    text?: string;
    math?: MathSpan;
    width: number;
}
/** Wrap opaque formula tokens without exposing or re-typesetting their contents. */
export function wrapInline(text: string, paragraph: Paragraph, font: PDFFont, size: number, width: number): InlinePiece[][] {
    const parts = text.split(/(⟦M\d+⟧)/g);
    const pieces: InlinePiece[] = [];
    for (const part of parts) {
        const math = paragraph.math.find(m => m.token === part);
        if (math?.box) {
            pieces.push({ math, width: (math.box.right - math.box.left) * size / paragraph.fontSize });
            continue;
        }
        let word = '';
        const flush = () => { if (word) {
            pieces.push({ text: word, width: font.widthOfTextAtSize(word, size) });
            word = '';
        } };
        for (const ch of part) {
            if (isCJK(ch) || /\s/.test(ch)) {
                flush();
                pieces.push({ text: ch, width: font.widthOfTextAtSize(ch, size) });
            }
            else
                word += ch;
        }
        flush();
    }
    const lines: InlinePiece[][] = [];
    let line: InlinePiece[] = [], used = 0;
    const append = (piece: InlinePiece) => {
        if (line.length && used + piece.width > width) {
            const previous = line[line.length - 1];
            const closing = piece.text !== undefined && /^[，。？！；：、）】》〕」』….,!?;:)\]}>]+$/u.test(piece.text);
            const opening = previous?.text !== undefined && /[（【《〔「『(\[{<]$/u.test(previous.text);
            const carry = closing || opening ? line.pop() : undefined;
            if (line.length) lines.push(line);
            line = carry ? [carry] : [];
            used = carry?.width ?? 0;
        }
        if (!line.length && piece.text?.trim() === '')
            return;
        line.push(piece);
        used += piece.width;
    };
    for (const piece of pieces) {
        if (piece.text && piece.width > width) {
            for (const ch of piece.text)
                append({ text: ch, width: font.widthOfTextAtSize(ch, size) });
        }
        else
            append(piece);
    }
    if (line.length)
        lines.push(line);
    return lines.map(line => {
        const merged: InlinePiece[] = [];
        for (const piece of line) {
            const previous = merged[merged.length - 1];
            if (previous?.text !== undefined && piece.text !== undefined) {
                previous.text += piece.text;
                previous.width += piece.width;
            }
            else
                merged.push({ ...piece });
        }
        return merged;
    });
}
/** Fit complete translated content to the original paragraph's width and height. */
export function fitParagraph(text: string, paragraph: Paragraph, font: PDFFont): {
    size: number;
    lines: InlinePiece[][];
    leading: number;
    baselineOffset: number;
    fits: boolean;
} {
    const width = paragraph.box.right - paragraph.box.left;
    const height = paragraph.box.bottom - paragraph.box.top;
    const ratio = Math.min(1.6, Math.max(1.05, paragraph.leading / paragraph.fontSize));
    const upper = paragraph.fontSize;
    const lower = paragraph.fontSize * 0.5;
    for (let size = upper; size >= lower - 0.01; size -= 0.1) {
        const lines = wrapInline(text, paragraph, font, size, width);
        const formulas = lines.flat().flatMap(piece => piece.math?.box ? [piece.math] : []);
        const baselineOffset = Math.max(size * 0.9, ...formulas.map(math => ((math.baseline ?? math.box!.top + paragraph.fontSize * 0.88) - math.box!.top) * size / paragraph.fontSize));
        const descent = Math.max(size * 0.28, ...formulas.map(math => (math.box!.bottom - (math.baseline ?? math.box!.top + paragraph.fontSize * 0.88)) * size / paragraph.fontSize));
        const ink = baselineOffset + descent;
        const needed = ink + Math.max(0, lines.length - 1) * size * ratio;
        if (needed <= height + 0.01 && lines.every(line => line.reduce((sum, p) => sum + p.width, 0) <= width + 0.01)) {
            const leading = lines.length > 1 ? Math.min((height - ink) / (lines.length - 1), size * 1.6) : size * ratio;
            return { size, lines, leading, baselineOffset, fits: true };
        }
    }
    return { size: lower, lines: [], leading: lower * ratio, baselineOffset: lower * 0.9, fits: false };
}
