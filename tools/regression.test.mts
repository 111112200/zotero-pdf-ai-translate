import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist';
const root = path.resolve(import.meta.dirname, '..');
Object.assign(globalThis, {
    addonRef: 'pdfaitranslate', prefsPrefix: 'extensions.zotero.pdfaitranslate', buildVersion: 'test', rootURI: pathToFileURL(path.join(root, 'addon')).href + '/',
    ztoolkit: { log: () => { } }, IOUtils: { read: async (p: string) => new Uint8Array(fs.readFileSync(p)), exists: async (p: string) => fs.existsSync(p) },
    Zotero: { Prefs: { get: () => undefined }, File: { getBinaryContentsAsync: async (uri: string) => fs.readFileSync(new URL(uri), 'latin1') } },
});
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.mjs')).href;
const { extractPages } = await import('../src/modules/extract/index.ts');
const { renderBilingual } = await import('../src/modules/render/bilingual.ts');
const { fitParagraph } = await import('../src/modules/render/inline.ts');
const { pdfLibFontkit } = await import('../src/modules/render/fontkit.ts');
async function fixture() {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const figureDoc = await PDFDocument.create();
    const ff = await figureDoc.embedFont(StandardFonts.Helvetica);
    const figure = figureDoc.addPage([160, 70]);
    figure.drawRectangle({ x: 0, y: 0, width: 160, height: 70, color: rgb(.9, .9, 1) });
    figure.drawText('GRAPH LABEL', { x: 20, y: 30, size: 10, font: ff });
    const [embedded] = await doc.embedPdf(await figureDoc.save());
    const p = doc.addPage([400, 600]);
    p.drawText('A heading', { x: 40, y: 550, size: 18, font });
    p.drawText('This paragraph explains the method.', { x: 40, y: 520, size: 11, font });
    p.drawText('A second line continues this paragraph.', { x: 40, y: 506, size: 11, font });
    p.drawPage(embedded, { x: 40, y: 370, width: 160, height: 70 });
    p.drawText('Figure caption outside the graphic.', { x: 40, y: 345, size: 10, font });
    for (const y of [310, 288, 266, 244])
        p.drawLine({ start: { x: 40, y }, end: { x: 300, y }, thickness: .6 });
    for (const [row, y] of [296, 274, 252].entries())
        for (const [col, x] of [50, 145, 240].entries())
            p.drawText(`CELL${row}${col}`, { x, y, size: 10, font });
    p.drawText('Body below table remains translatable.', { x: 40, y: 220, size: 11, font });
    doc.registerFontkit(pdfLibFontkit as never);
    const math = await doc.embedFont(fs.readFileSync(path.join(root, 'addon/content/fonts/NotoSansSC-Regular.subset.ttf')), { subset: true });
    p.drawText('α+β=γ', { x: 120, y: 190, size: 12, font: math });
    p.drawText('Inline value ', { x: 40, y: 160, size: 11, font });
    p.drawText('α', { x: 96, y: 160, size: 11, font: math });
    p.drawText(' is estimated.', { x: 105, y: 160, size: 11, font });
    return new Uint8Array(await doc.save());
}
test('extraction excludes figure labels, ruled cells and display math while retaining captions and body', async () => {
    const bytes = await fixture();
    const [page] = await extractPages(bytes);
    const source = page.paragraphs.map(p => p.source).join('\n');
    assert.match(source, /A heading/);
    assert.match(source, /Figure caption/);
    assert.match(source, /Body below table/);
    assert.doesNotMatch(source, /GRAPH LABEL|CELL/);
    assert.ok(page.paragraphs.some(p => p.isFormulaBlock));
    assert.ok(page.paragraphs.some(p => p.math.some(m => m.box && m.token)));
    const translations = new Map<string, string>();
    // Keep opaque tokens intact, as the real translation pipeline requires.
    for (const [i, p] of page.paragraphs.entries())
        if (!p.isFormulaBlock)
            translations.set(`0:${i}`, '段落译文。' + p.math.filter(m => m.token).map(m => m.token).join(''));
    const result = await renderBilingual({ sourceBytes: bytes, pages: [page], translations, debug: true });
    fs.mkdirSync(path.join(root, "tools/_out"), { recursive: true });
    fs.writeFileSync(path.join(root, "tools/_out/regression.pdf"), result.bytes);
    assert.equal(result.overflowBoxes, 0);
    assert.equal(result.missingGlyphs.length, 0);
    assert.equal(result.preservedMathParagraphs, 0);
    assert.ok(result.debug.every(d => d.truncated === 0));
    const parsed = await pdfjs.getDocument({ data: result.bytes.slice() }).promise;
    const text = (await (await parsed.getPage(1)).getTextContent()).items.filter((i): i is pdfjs.TextItem => 'str' in i).map(i => i.str).join(' ');
    assert.equal(text.match(/GRAPH LABEL/g)?.length, 2);
    assert.equal(text.match(/CELL00/g)?.length, 2);
    assert.match(text, /译文/);
    const operators = await (await parsed.getPage(1)).getOperatorList();
    assert.equal(operators.fnArray.filter(fn => fn === pdfjs.OPS.paintFormXObjectBegin).length, 4, "only two source-page draws and their figure forms; inline math must not replay the page");
    await parsed.destroy();
});
test('fitting uses original heading size and never truncates an oversized translation', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(pdfLibFontkit as never);
    const font = await doc.embedFont(fs.readFileSync(path.join(root, 'addon/content/fonts/NotoSansSC-Regular.subset.ttf')));
    const base = { source: 'Heading', math: [], column: 0, isFormulaBlock: false, box: { left: 0, top: 0, right: 240, bottom: 23.6 }, lineBoxes: [], baselines: [18], fontSize: 20, leading: 24 };
    const title = fitParagraph('标题', base, font);
    assert.ok(title.fits);
    assert.ok(title.size > 15);
    const small = fitParagraph('正文', { ...base, box: { left: 0, top: 0, right: 240, bottom: 11.8 }, fontSize: 10, leading: 12 }, font);
    assert.ok(small.fits);
    assert.ok(title.size > small.size);
    assert.equal(fitParagraph('长段落'.repeat(2000), base, font).fits, false);
});
test('rendering leaves original paragraph intact when full translation cannot fit', async () => {
    const bytes = await fixture();
    const [page] = await extractPages(bytes);
    const index = page.paragraphs.findIndex(p => p.source === 'A heading');
    const result = await renderBilingual({ sourceBytes: bytes, pages: [page], translations: new Map([[`0:${index}`, '过长译文'.repeat(2000)]]), debug: true });
    assert.equal(result.overflowBoxes, 1);
    assert.equal(result.debug[index].translated, false);
    assert.equal(result.debug[index].truncated, 0);
});
test('borderless table cells are excluded without discarding surrounding prose', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 600]);
    page.drawText('A regular paragraph above the table', { x: 40, y: 550, size: 11, font });
    for (const [row, y] of [480, 460, 440].entries())
        for (const [col, x] of [40, 145, 260].entries())
            page.drawText(`GRID${row}${col}`, { x, y, size: 10, font });
    page.drawText('A regular paragraph below the table', { x: 40, y: 390, size: 11, font });
    const [extracted] = await extractPages(new Uint8Array(await doc.save()));
    const text = extracted.paragraphs.map(p => p.source).join(' ');
    assert.doesNotMatch(text, /GRID/);
    assert.match(text, /above the table/);
    assert.match(text, /below the table/);
});


test('bundled font embeds caron and author-name accents without missing glyphs', async () => {
    const { findMissingGlyphs } = await import('../src/modules/render/fonts.ts');
    const accents = 'ˇ˙̌';
    const bytes = new Uint8Array(fs.readFileSync(path.join(root, 'addon/content/fonts/NotoSansSC-Regular.subset.ttf')));
    assert.deepEqual(findMissingGlyphs(bytes, accents), []);
    const source = await fixture();
    const [page] = await extractPages(source);
    const index = page.paragraphs.findIndex(p => p.source === 'A heading');
    const result = await renderBilingual({ sourceBytes: source, pages: [page], translations: new Map([[`0:${index}`, '姓名 ˇ']]), debug: true });
    assert.deepEqual(result.missingGlyphs, []);
    assert.equal(result.debug[index].translated, true);
    assert.equal(result.overflowBoxes, 0);
    const doc = await pdfjs.getDocument({data: result.bytes.slice()}).promise;
    try {
        const text = (await (await doc.getPage(1)).getTextContent()).items.filter((item): item is pdfjs.TextItem => 'str' in item).map(item => item.str).join('');
        assert.match(text, /ˇ/);
    } finally { await doc.destroy(); }
});
