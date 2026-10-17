/** Inline text and original formula glyphs measured together for wrapping. */
import type { PDFFont } from 'pdf-lib';
import type { MathSpan, Paragraph } from '../extract/types';
import { isCJK } from './typeset';

export interface InlinePiece {
    text?: string;
    math?: MathSpan;
    width: number;
}

/** A formula placeholder exactly as the extractor wrote it. */
const PLACEHOLDER = /^⟦M(\d+)⟧$/;
/** Anything bracket-shaped, used to spot a placeholder the model mangled. */
const BRACKETED = /⟦[^⟧]*⟧/g;

/**
 * Resolve a placeholder to the formula it stands for.
 *
 * The exact string is tried first. A reply that merely pads the number
 * (`⟦M01⟧` for `⟦M1⟧`) still refers to the same formula, so the number is
 * matched as a fallback rather than dropping the equation.
 *
 * @param paragraph - paragraph the placeholder came from.
 * @param part - the placeholder text.
 * @returns the matching span, or `undefined` when the token refers to nothing.
 */
export function spanForPlaceholder(paragraph: Paragraph, part: string): MathSpan | undefined {
    const exact = paragraph.math.find(m => m.token === part);
    if (exact) {
        return exact;
    }
    const match = PLACEHOLDER.exec(part);
    if (!match) {
        return undefined;
    }
    const wanted = Number(match[1]);
    return paragraph.math.find(m => {
        const other = PLACEHOLDER.exec(m.token);
        return other !== null && Number(other[1]) === wanted;
    });
}

/**
 * True when a reply's placeholders cannot be rendered faithfully.
 *
 * Compared by the formula numbers they reference, as a multiset:
 *
 *  - a dropped token would silently lose the equation (its cover is already
 *    painted by the time the translation is drawn),
 *  - a duplicated or invented one would draw the same equation twice, or draw
 *    an equation that does not exist,
 *  - a leftover bracketed run that resolves to nothing would be typeset as
 *    literal characters, because the bundled font has no `⟦`/`⟧`.
 *
 * A reply that merely pads the number (`⟦M01⟧` for `⟦M1⟧`) refers to the same
 * formula and is still rendered.
 *
 * @param source - the paragraph text with its original placeholders.
 * @param translated - the model's translation.
 * @param paragraph - paragraph the text belongs to.
 * @returns true when the paragraph must keep its original text.
 */
export function placeholdersBreak(source: string, translated: string, paragraph: Paragraph): boolean {
    const expected = placeholderNumbersIn(source).sort((a, b) => a - b);
    const actual = placeholderNumbersIn(translated).sort((a, b) => a - b);
    if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
        return true;
    }
    return Boolean(translated.match(BRACKETED)?.some(part => !spanForPlaceholder(paragraph, part)));
}

/** The formula numbers referenced by placeholders in a string, in order. */
function placeholderNumbersIn(text: string): number[] {
    const found: number[] = [];
    const pattern = /⟦M(\d+)⟧/g;
    let match = pattern.exec(text);
    while (match) {
        found.push(Number(match[1]));
        match = pattern.exec(text);
    }
    return found;
}

/** Wrap opaque formula tokens without exposing or re-typesetting their contents. */
export function wrapInline(text: string, paragraph: Paragraph, font: PDFFont, size: number, width: number): InlinePiece[][] {
    const parts = text.split(/(⟦M\d+⟧)/g);
    const pieces: InlinePiece[] = [];
    for (const part of parts) {
        const math = spanForPlaceholder(paragraph, part);
        if (math?.box) {
            pieces.push({ math, width: (math.box.right - math.box.left) * size / paragraph.fontSize });
            continue;
        }
        if (PLACEHOLDER.test(part)) {
            // Unresolvable: drop it rather than typeset placeholder characters.
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
            // Keep the source paragraph's own leading. Stretching the lines to
            // fill the original box is what made translated paragraphs 25-45%
            // looser than the page around them, and unevenly so: a paragraph
            // needing one line fewer immediately hit the 1.6x ceiling while its
            // neighbour stayed at the source leading.
            const leading = size * ratio;
            return { size, lines, leading, baselineOffset, fits: true };
        }
    }
    return { size: lower, lines: [], leading: lower * ratio, baselineOffset: lower * 0.9, fits: false };
}
