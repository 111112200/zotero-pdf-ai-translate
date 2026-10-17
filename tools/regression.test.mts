import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
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
const { wrapInline } = await import('../src/modules/render/inline.ts');
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

test('rotated margin text stays outside horizontal prose and centered bold titles form one paragraph', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
    const page = doc.addPage([400, 600]);
    page.drawText('arXiv: rotated margin', { x: 20, y: 210, size: 20, font, rotate: degrees(90) });
    page.drawText('Centered title first line', { x: 90, y: 540, size: 16, font: bold });
    page.drawText('Second title line', { x: 112, y: 522, size: 16, font: bold });
    page.drawText('Ordinary body text under the heading.', { x: 50, y: 460, size: 11, font });
    const [extracted] = await extractPages(new Uint8Array(await doc.save()));
    assert.doesNotMatch(extracted.paragraphs.map(p => p.source).join(' '), /arXiv|rotated margin/);
    assert.ok(extracted.paragraphs.every(p => p.box.bottom - p.box.top < 60));
    const title = extracted.paragraphs.find(p => p.source.includes('Centered title'))!;
    assert.match(title.source, /Second title line/);
    assert.equal(title.bold, true);
    assert.equal(title.alignment, 'center');
});

test('sparse columns keep separate reading order and repeated page headers retain their source drawing', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const pages = [doc.addPage([420, 600]), doc.addPage([420, 600])];
    for (const page of pages) page.drawText('Recurring journal header', { x: 140, y: 568, size: 9, font });
    for (let row = 0; row < 8; row++) {
        pages[0].drawText('Left column follows a consistent order.', { x: 40, y: 530 - row * 13, size: 10, font });
        pages[0].drawText('Right column follows a consistent order.', { x: 230, y: 530 - row * 13, size: 10, font });
    }
    for (let row = 0; row < 4; row++) {
        pages[1].drawText('Sparse left prose remains in this column.', { x: 40, y: 520 - row * 13, size: 10, font });
        pages[1].drawText('Sparse right prose remains in this column.', { x: 230, y: 290 - row * 13, size: 10, font });
    }
    const bytes = new Uint8Array(await doc.save());
    for (const extracted of [await extractPages(bytes), await extractPages(bytes, { firstPage: 2, lastPage: 2 })]) {
        const sparse = extracted.find(page => page.index === 1)!;
        const body = sparse.paragraphs.filter(p => /Sparse/.test(p.source));
        assert.equal(body.length, 2);
        assert.match(body[0].source, /Sparse left/);
        assert.doesNotMatch(body[0].source, /right/);
        assert.match(body[1].source, /Sparse right/);
        assert.ok(body.every(p => p.box.right - p.box.left < 185));
        if (extracted.length > 1) assert.doesNotMatch(sparse.paragraphs.map(p => p.source).join(' '), /Recurring journal/);
    }
});

test('numbered equations with roman labels and tall algorithm tables remain untranslated', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    doc.registerFontkit(pdfLibFontkit as never);
    const math = await doc.embedFont(fs.readFileSync(path.join(root, 'addon/content/fonts/NotoSansSC-Regular.subset.ttf')), { subset: true });
    const page = doc.addPage([400, 600]);
    page.drawText('Prose before the numbered equation.', { x: 40, y: 545, size: 10, font });
    page.drawText('α', { x: 100, y: 515, size: 10, font: math });
    page.drawText('Kalman = log E (1)', { x: 110, y: 515, size: 10, font });
    page.drawText('Prose after the numbered equation.', { x: 40, y: 480, size: 10, font });
    for (const y of [440, 419, 215]) page.drawLine({ start: { x: 40, y }, end: { x: 330, y }, thickness: .5 });
    page.drawText('Algorithm 1 Policy update', { x: 40, y: 427, size: 10, font });
    page.drawText('1: Initialize policy parameters', { x: 45, y: 399, size: 10, font });
    page.drawText('2: Compute gradient estimate', { x: 45, y: 310, size: 10, font });
    page.drawText('3: Update policy and return', { x: 45, y: 230, size: 10, font });
    page.drawText('Prose below the algorithm table.', { x: 40, y: 185, size: 10, font });
    const [extracted] = await extractPages(new Uint8Array(await doc.save()));
    const translatable = extracted.paragraphs.filter(p => !p.isFormulaBlock).map(p => p.source).join(' ');
    assert.match(translatable, /before the numbered|after the numbered|below the algorithm/);
    assert.doesNotMatch(translatable, /Kalman|Algorithm|Initialize|Compute gradient|Update policy/);
    assert.ok(extracted.paragraphs.some(p => p.isFormulaBlock && p.math[0].text.includes('(1)')));
});

test('inline subscripts share one formula token and retain their vertical offset', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    doc.registerFontkit(pdfLibFontkit as never);
    const math = await doc.embedFont(fs.readFileSync(path.join(root, 'addon/content/fonts/NotoSansSC-Regular.subset.ttf')), { subset: true });
    const page = doc.addPage([400, 600]);
    page.drawText('The return ', { x: 40, y: 530, size: 11, font });
    page.drawText('α', { x: 86, y: 530, size: 11, font: math });
    page.drawText('1', { x: 93, y: 527, size: 7, font: math });
    page.drawText('2', { x: 96.5, y: 525, size: 5, font: math });
    page.drawText(' is estimated.', { x: 100, y: 530, size: 11, font });
    const [extracted] = await extractPages(new Uint8Array(await doc.save()));
    const paragraph = extracted.paragraphs.find(p => p.source.includes('The return'))!;
    assert.equal(paragraph.math.length, 1);
    assert.equal(paragraph.math[0].text, 'α12');
    assert.match(paragraph.source, /The return ⟦M1⟧ is estimated/);
    assert.ok(paragraph.math[0].outlines!.some(glyph => (glyph.y ?? 0) >= 3));
    assert.equal(paragraph.math[0].outlines!.length, 3);
    assert.ok(paragraph.math[0].outlines!.some(glyph => (glyph.y ?? 0) >= 5));
    const check = await PDFDocument.create();
    check.registerFontkit(pdfLibFontkit as never);
    const translationFont = await check.embedFont(fs.readFileSync(path.join(root, 'addon/content/fonts/NotoSansSC-Regular.subset.ttf')));
    const fit = fitParagraph('回报⟦M1⟧被估计。', paragraph, translationFont);
    assert.ok(fit.fits);
    assert.ok(fit.size <= paragraph.fontSize);
    const punctuation = wrapInline('测试。中文', paragraph, translationFont, 10, 20).map(line => line.map(piece => piece.text ?? '').join(''));
    assert.equal(punctuation.join(''), '测试。中文');
    assert.ok(punctuation.every(line => !/^[。！？；：）]/u.test(line)));
});

test('normalized micro and ohm signs retain original math glyphs and translated prose', async () => {
    const doc = await PDFDocument.create();
    const prose = await doc.embedFont(StandardFonts.TimesRoman);
    doc.registerFontkit(pdfLibFontkit as never);
    const math = await doc.embedFont(fs.readFileSync(path.join(root, 'addon/content/fonts/NotoSansSC-Regular.subset.ttf')), { subset: true });
    const page = doc.addPage([400, 600]);
    for (const [i, symbol] of ['µ', 'Ω'].entries()) {
        const y = 530 - i * 50;
        page.drawText('Parameter ', { x: 40, y, size: 11, font: prose });
        page.drawText(symbol, { x: 90, y, size: 11, font: math });
        page.drawText(' is estimated.', { x: 104, y, size: 11, font: prose });
    }
    const bytes = new Uint8Array(await doc.save());
    const [extracted] = await extractPages(bytes);
    assert.equal(extracted.paragraphs.length, 2);
    const translations = new Map<string, string>();
    for (const [index, paragraph] of extracted.paragraphs.entries()) {
        assert.equal(paragraph.isFormulaBlock, false);
        assert.equal(paragraph.math.length, 1);
        assert.equal(paragraph.math[0].text, ['μ', 'Ω'][index]);
        assert.ok(paragraph.math[0].outlines?.some(glyph => glyph.path.length > 0));
        translations.set(`0:${index}`, '参数⟦M1⟧被估计。');
    }
    const rendered = await renderBilingual({ sourceBytes: bytes, pages: [extracted], translations, debug: true });
    assert.equal(rendered.preservedMathParagraphs, 0);
    assert.equal(rendered.overflowBoxes, 0);
    assert.ok(rendered.debug.every(decision => decision.translated));
    const parsed = await pdfjs.getDocument({ data: rendered.bytes.slice() }).promise;
    try {
        const text = (await (await parsed.getPage(1)).getTextContent()).items.filter((item): item is pdfjs.TextItem => 'str' in item).map(item => item.str).join('');
        assert.equal(text.match(/参数/g)?.length, 2);
    } finally { await parsed.destroy(); }
});

test('a mangled formula placeholder never reaches the page as literal text', async () => {
    const { placeholdersIntact, placeholderTokens } = await import('../src/modules/translate/prompts.ts');
    const source = 'The method uses ⟦M1⟧ as input.';
    assert.equal(placeholdersIntact(source, '该方法使用⟦M1⟧作为输入。'), true);
    assert.equal(placeholdersIntact(source, '该方法使用⟦M01⟧作为输入。'), false, 'a renumbered token must be rejected');
    assert.equal(placeholdersIntact(source, '该方法使用⟦M1⟧和⟦M1⟧。'), false, 'a duplicated token must be rejected');
    assert.equal(placeholdersIntact(source, '该方法不使用公式。'), false);
    assert.equal(placeholdersIntact('没有公式的句子。', '一句话⟦M1⟧。'), false, 'a token invented in formula-free prose must be rejected');
    assert.deepEqual(placeholderTokens('a ⟦M2⟧ b ⟦M2⟧'), ['⟦M2⟧', '⟦M2⟧']);

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    doc.registerFontkit(pdfLibFontkit as never);
    const mathFont = await doc.embedFont(fs.readFileSync(path.join(root, 'addon/content/fonts/NotoSansSC-Regular.subset.ttf')), { subset: true });
    const page = doc.addPage([400, 600]);
    page.drawText('The value ', { x: 40, y: 530, size: 11, font });
    page.drawText('α', { x: 96, y: 530, size: 11, font: mathFont });
    page.drawText(' is used.', { x: 106, y: 530, size: 11, font });
    page.drawText('A plain sentence with no formula at all.', { x: 40, y: 500, size: 11, font });
    const bytes = new Uint8Array(await doc.save());
    const [extracted] = await extractPages(bytes);
    const withMath = extracted.paragraphs.findIndex(p => p.source.includes('The value'));
    const plain = extracted.paragraphs.findIndex(p => p.source.includes('plain sentence'));
    assert.match(extracted.paragraphs[withMath].source, /⟦M1⟧/);
    assert.equal(extracted.paragraphs[plain].math.length, 0);

    // Dropped, duplicated and hallucinated tokens must leave the paragraph in
    // its original language; a merely renumbered token still renders.
    const mustKeep: Array<[number, string]> = [
        [withMath, '数值⟦M1⟧和⟦M1⟧被使用。'],
        [withMath, '数值。'],
        [plain, '一句没有任何公式的话⟦M1⟧。'],
    ];
    for (const [index, text] of mustKeep) {
        const result = await renderBilingual({ sourceBytes: bytes, pages: [extracted], translations: new Map([[`0:${index}`, text]]), debug: true });
        const decision = result.debug[index];
        assert.equal(decision.translated, false, `${text} must not be drawn`);
        assert.equal(decision.reason, 'placeholder', `${text} must be attributed to the placeholder guard`);
        assert.equal(result.placeholderMismatches, 1, `${text} must be reported`);
        const parsed = await pdfjs.getDocument({ data: result.bytes.slice() }).promise;
        try {
            const layer = (await (await parsed.getPage(1)).getTextContent()).items
                .filter((i): i is pdfjs.TextItem => 'str' in i).map(i => i.str).join('');
            assert.doesNotMatch(layer, /M0?1/, `${text} leaked the placeholder into the page`);
        } finally { await parsed.destroy(); }
    }

    // A correctly copied token still renders the original formula glyphs, and a
    // merely renumbered one is resolved to the same formula instead of being
    // typeset as ⟦M01⟧.
    for (const text of ['数值⟦M1⟧被使用。', '数值⟦M01⟧被使用。']) {
        const ok = await renderBilingual({ sourceBytes: bytes, pages: [extracted], translations: new Map([[`0:${withMath}`, text]]), debug: true });
        assert.equal(ok.placeholderMismatches, 0, `${text} should be renderable`);
        assert.equal(ok.debug[withMath].translated, true, `${text} should be drawn`);
        const parsed = await pdfjs.getDocument({ data: ok.bytes.slice() }).promise;
        try {
            const layer = (await (await parsed.getPage(1)).getTextContent()).items
                .filter((i): i is pdfjs.TextItem => 'str' in i).map(i => i.str).join('');
            assert.doesNotMatch(layer, /M0?1/, `${text} was typeset instead of resolved`);
        } finally { await parsed.destroy(); }
    }
});

test('inline math keeps the words beside it, and short prose lines stay translatable', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(pdfLibFontkit as never);
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const math = await doc.embedFont(fs.readFileSync(path.join(root, 'addon/content/fonts/NotoSansSC-Regular.subset.ttf')), { subset: true });
    const page = doc.addPage([400, 600]);
    // An inline operator set far larger than the body text, followed by a short
    // prose run: the run must not be absorbed into the formula token, and the
    // paragraph must keep the body size rather than the operator's.
    page.drawText('The total value is ', { x: 40, y: 530, size: 10, font });
    page.drawText('α', { x: 130, y: 530, size: 14, font: math });
    page.drawText(' large.', { x: 139, y: 530, size: 10, font });
    // Short wordless lines that are prose, not equations.
    page.drawText('Smith, J.', { x: 40, y: 480, size: 10, font });
    page.drawText('et al.', { x: 40, y: 466, size: 10, font });
    page.drawText('pp. 12-15 for the details.', { x: 40, y: 452, size: 10, font });
    page.drawText('摘要', { x: 40, y: 420, size: 12, font: math });

    const [extracted] = await extractPages(new Uint8Array(await doc.save()));
    const source = extracted.paragraphs.map(p => p.source).join('\n');
    assert.match(source, /large/, 'text beside an oversized inline formula was swallowed');
    assert.match(source, /et al\./, 'a wordless prose line was treated as a display formula');
    assert.match(source, /pp\. 12-15/, 'a citation fragment was treated as a display formula');
    assert.match(source, /摘要/, 'a two-character CJK heading was treated as a display formula');
    const inline = extracted.paragraphs.find(p => p.source.includes('total value'))!;
    assert.equal(inline.isFormulaBlock, false);
    assert.equal(inline.fontSize, 10, 'the inline operator inflated the paragraph size');
    assert.deepEqual(inline.math.map(m => m.text), ['α']);
    assert.equal(extracted.paragraphs.filter(p => p.isFormulaBlock).length, 0);
});

test('a short translation keeps the source leading instead of stretching to fill its box', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(pdfLibFontkit as never);
    const font = await doc.embedFont(fs.readFileSync(path.join(root, 'addon/content/fonts/NotoSansSC-Regular.subset.ttf')));
    const base = {
        source: 'x', math: [], column: 0, isFormulaBlock: false, lineBoxes: [], baselines: [18],
        bold: false, alignment: 'left' as const,
    };
    // Box far taller than the translation needs: filling it would mean spreading
    // lines up to 1.6x the font size, which is what made every paragraph whose
    // translation needed one line fewer than the source read 25-45% looser.
    const tall = { ...base, box: { left: 0, top: 0, right: 240, bottom: 120 }, fontSize: 10, leading: 12 };
    const fit = fitParagraph('这是一个用于检查行距的较长译文段落，需要折成若干行。'.repeat(2), tall, font);
    assert.ok(fit.fits);
    assert.ok(fit.lines.length > 1, 'the fixture must wrap to more than one line');
    assert.ok(Math.abs(fit.leading - fit.size * 1.2) < 1e-6,
        `leading ${fit.leading} should follow the source's 1.2x, not fill the box`);
    assert.ok(fit.leading < 20, 'leading must not be stretched towards the 1.6x ceiling');
    // The drawn block is exactly what the fit check validated, so it stays put.
    const drawnHeight = fit.baselineOffset + (fit.lines.length - 1) * fit.leading;
    assert.ok(drawnHeight <= 120, `drawn block ${drawnHeight} escaped its box`);
});

test('covers take the colour of the background they hide, not white', async () => {
    const tint: [number, number, number] = [0.8, 0.9, 0.7];
    // Extraction side: a tinted band behind the text is recorded with its colour.
    const shaded = await PDFDocument.create();
    const shadedFont = await shaded.embedFont(StandardFonts.TimesRoman);
    const shadedPage = shaded.addPage([400, 600]);
    shadedPage.drawRectangle({ x: 20, y: 480, width: 360, height: 40, color: rgb(...tint) });
    shadedPage.drawText('Text sitting on a tinted band.', { x: 40, y: 500, size: 11, font: shadedFont });
    const [tinted] = await extractPages(new Uint8Array(await shaded.save()));
    const region = tinted.shadedRegions?.find(r => r.color.every((c, i) => Math.abs(c - tint[i]) < 0.02));
    assert.ok(region, 'the tinted band was not recorded');
    assert.ok(region.box.left <= 40 && region.box.right >= 340, 'the recorded band does not span the text');

    // Rendering side: the colour comes from the recorded background. The source
    // page here is plain, so the tint can only have come from a cover.
    const plain = await PDFDocument.create();
    const plainFont = await plain.embedFont(StandardFonts.TimesRoman);
    const plainPage = plain.addPage([400, 600]);
    plainPage.drawText('Text that needs covering.', { x: 40, y: 500, size: 11, font: plainFont });
    const plainBytes = new Uint8Array(await plain.save());
    const [page] = await extractPages(plainBytes);
    const fillsOf = async (bytes: Uint8Array) => {
        const parsed = await pdfjs.getDocument({ data: bytes.slice() }).promise;
        try {
            const operators = await (await parsed.getPage(1)).getOperatorList();
            const seen: number[][] = [];
            operators.fnArray.forEach((fn, index) => {
                if (fn !== pdfjs.OPS.setFillRGBColor) return;
                const raw = operators.argsArray[index] as unknown as ArrayLike<number>;
                const values = Array.from({ length: 3 }, (_, i) => Number(raw[i]));
                // pdf.js reports colour operands as 0..255 components.
                seen.push(values.map(value => (value > 1 ? value / 255 : value)));
            });
            return seen;
        } finally { await parsed.destroy(); }
    };

    page.shadedRegions = [{ box: { left: 0, top: 0, right: 400, bottom: 600 }, color: tint }];
    const tintedResult = await renderBilingual({ sourceBytes: plainBytes, pages: [page], translations: new Map([['0:0', '需要遮盖的正文。']]), debug: true });
    assert.equal(tintedResult.debug[0].translated, true);
    const tintedFills = await fillsOf(tintedResult.bytes);
    assert.ok(
        tintedFills.some(c => c.every((value, i) => Math.abs(value - tint[i]) < 0.02)),
        `no cover used the recorded background colour; fills seen: ${JSON.stringify(tintedFills)}`,
    );

    delete page.shadedRegions;
    const plainResult = await renderBilingual({ sourceBytes: plainBytes, pages: [page], translations: new Map([['0:0', '需要遮盖的正文。']]), debug: true });
    const plainFills = await fillsOf(plainResult.bytes);
    assert.ok(
        plainFills.some(c => c.every(value => value >= 0.99)),
        `a page without a recorded background must still be covered in white; fills seen: ${JSON.stringify(plainFills)}`,
    );
});

test('a single-column page keeps its reading order instead of borrowing a gutter', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    // Two two-column pages supply the borrowed gutter (one alone is not enough
    // evidence for documentGutters to reuse it).
    const pages = [doc.addPage([420, 600]), doc.addPage([420, 600]), doc.addPage([420, 600])];
    for (const page of pages.slice(0, 2)) {
        for (let row = 0; row < 8; row++) {
            page.drawText('Left column line of prose here.', { x: 40, y: 530 - row * 13, size: 10, font });
            page.drawText('Right column line of prose here.', { x: 230, y: 530 - row * 13, size: 10, font });
        }
    }
    // Page 3 is single column: a heading at the top sitting to the right of the
    // borrowed gutter, above short body lines that stop short of it.
    pages[2].drawText('Results', { x: 215, y: 540, size: 11, font });
    for (let row = 0; row < 6; row++) pages[2].drawText('Short body line of prose.', { x: 40, y: 500 - row * 13, size: 10, font });

    const extracted = await extractPages(new Uint8Array(await doc.save()));
    const order = extracted[2].paragraphs.map(p => p.source);
    const heading = order.findIndex(source => source.includes('Results'));
    const body = order.findIndex(source => source.includes('Short body line'));
    assert.ok(heading >= 0 && body >= 0, `expected both a heading and body text, got ${JSON.stringify(order)}`);
    assert.ok(heading < body,
        `the heading was reordered below the body text (heading #${heading}, body #${body})`);
});

test('recurring margin text is dropped only when it recurs identically and often enough', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const pages = Array.from({ length: 6 }, () => doc.addPage([420, 600]));
    for (const page of pages) page.drawText('Journal of Recurring Headers', { x: 130, y: 572, size: 9, font });
    // Same wording in the same band on only two of six pages: a repeated
    // footnote or a sentence opening two pages, not a running head.
    for (const index of [0, 1]) pages[index].drawText('Wandering label text here', { x: 40, y: 560, size: 9, font });
    for (const index of [2, 3]) pages[index].drawText('Wandering label text here', { x: 240, y: 560, size: 9, font });
    for (const index of [4, 5]) pages[index].drawText('Rare sentence opener here', { x: 40, y: 560, size: 9, font });

    const extracted = await extractPages(new Uint8Array(await doc.save()));
    assert.equal(extracted.length, 6);
    for (const page of extracted) {
        const text = page.paragraphs.map(p => p.source).join(' ');
        assert.doesNotMatch(text, /Recurring Headers/, `page ${page.index + 1}: the running head should be dropped`);
    }
    assert.match(extracted[0].paragraphs.map(p => p.source).join(' '), /Wandering label/, 'a line recurring on two pages must survive');
    assert.match(extracted[2].paragraphs.map(p => p.source).join(' '), /Wandering label/, 'the same words at a different x must survive');
    assert.match(extracted[4].paragraphs.map(p => p.source).join(' '), /Rare sentence opener/, 'a line recurring on two pages must survive');
});

test('a retried batch is renumbered from zero so the reply still matches', async () => {
    const { translateUnits } = await import('../src/modules/translate/pipeline.ts');
    const zotero = (globalThis as unknown as { Zotero: Record<string, unknown> }).Zotero;
    const prefs = zotero.Prefs as { get: (name: string, scope?: boolean) => unknown };
    const previousGet = prefs.get;
    const previousHttp = zotero.HTTP;
    // Caching off keeps the test off the filesystem; the retry budget stays at
    // the shipped default of three attempts.
    prefs.get = (name: string) => (name.endsWith('cacheEnabled') ? false : undefined);

    const requests: number[][] = [];
    let call = 0;
    zotero.HTTP = {
        request: async (_method: string, _url: string, options: { body: string }) => {
            const payload = JSON.parse(options.body) as { messages: Array<{ content: string }> };
            const segments = (JSON.parse(payload.messages[1].content) as { segments: Array<{ i: number; t: string }> }).segments;
            requests.push(segments.map(segment => segment.i));
            call += 1;
            // The first reply silently drops the last segment, which is retried.
            const answered = call === 1 ? segments.slice(0, -1) : segments;
            const content = JSON.stringify({ segments: answered.map(segment => ({ i: segment.i, t: `译:${segment.t}` })) });
            return { status: 200, response: JSON.stringify({ choices: [{ message: { content } }] }) };
        },
    };

    try {
        const units = [0, 1, 2, 3].map(index => ({ pageIndex: 0, paragraphIndex: index, source: `Segment ${index}`, mathCount: 0 }));
        const results = await translateUnits(units, {
            profile: { id: 'test', preset: 'custom', label: 'test', baseURL: 'http://127.0.0.1:1/v1', apiKey: '', model: 'test' },
            targetLang: 'zh-CN',
            sourceLang: 'auto',
            systemPromptExtra: '',
        });
        assert.ok(requests.length >= 2, `the dropped segment was never re-requested (${JSON.stringify(requests)})`);
        for (const asked of requests) {
            assert.deepEqual(asked, asked.map((_, position) => position),
                `every request must number its segments from zero, saw ${JSON.stringify(asked)}`);
        }
        assert.equal(results.filter(result => result.failed).length, 0, 'no paragraph should be left untranslated');
        assert.ok(results.every(result => result.translated.startsWith('译:')), 'every paragraph should carry its translation');
    } finally {
        prefs.get = previousGet;
        zotero.HTTP = previousHttp;
    }
});

test('untranslated pages and echoed paragraphs are reported, and unsupported glyphs are never drawn', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const pages = [doc.addPage([400, 600]), doc.addPage([400, 600])];
    pages[0].drawText('Only page one is translated.', { x: 40, y: 500, size: 11, font });
    pages[1].drawText('This page is left alone.', { x: 40, y: 500, size: 11, font });
    const bytes = new Uint8Array(await doc.save());
    const extracted = await extractPages(bytes);

    const partial = await renderBilingual({ sourceBytes: bytes, pages: extracted, translations: new Map([['0:0', '只有第一页被翻译。']]), debug: true });
    assert.deepEqual(partial.skippedPages, [1], 'a page with nothing translated must be reported');
    assert.equal(partial.unchangedParagraphs, 0);

    const echoed = await renderBilingual({ sourceBytes: bytes, pages: extracted, translations: new Map([['0:0', 'Only page one is translated.']]), debug: true });
    assert.equal(echoed.unchangedParagraphs, 1, 'a paragraph returned unchanged must be counted');
    assert.equal(echoed.debug[0].reason, 'unchanged');

    // A character the bundled font has no outline for: reported, and drawn as a
    // blank rather than the hollow .notdef box pdf-lib would otherwise embed.
    const missing = await renderBilingual({ sourceBytes: bytes, pages: extracted, translations: new Map([['0:0', '译文🙂结束。']]), debug: true });
    assert.deepEqual(missing.missingGlyphs, ['🙂']);
    assert.equal(missing.debug[0].translated, true);
    const parsed = await pdfjs.getDocument({ data: missing.bytes.slice() }).promise;
    try {
        const layer = (await (await parsed.getPage(1)).getTextContent()).items
            .filter((i): i is pdfjs.TextItem => 'str' in i).map(i => i.str).join('');
        assert.doesNotMatch(layer, /🙂/, 'the unsupported character was typeset anyway');
        assert.match(layer, /译文/);
    } finally { await parsed.destroy(); }
});

test('prose near display math is translated while covers exclude original equation regions', async () => {
    const bytes = await fixture();
    const [page] = await extractPages(bytes);
    const index = page.paragraphs.findIndex(p => p.source.includes('Body below table'));
    const body = page.paragraphs[index];
    const protectedRegion = { left: body.box.left + 90, right: body.box.left + 120, top: body.box.bottom - 2, bottom: body.box.bottom + 12 };
    page.protectedRegions!.push(protectedRegion);
    const result = await renderBilingual({ sourceBytes: bytes, pages: [page], translations: new Map([[`0:${index}`, '表格下方的正文。']]), debug: true });
    assert.equal(result.debug[index].translated, true);
    assert.equal(result.overflowBoxes, 0);
    const source = await PDFDocument.load(result.bytes);
    assert.equal(source.getPageCount(), 1);
});

test('a page box whose origin is not zero keeps the translation on the original', async () => {
    // Regression: the renderer used to embed through pdf-lib's MediaBox-based
    // box with an identity matrix, discarding the box origin, while the
    // extractor measured everything relative to that origin. On these pages the
    // translation and the covers landed (x0, y0) away from the source text.
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const plain = doc.addPage([400, 600]);
    plain.drawText('ANCHORWORD', { x: 60, y: 500, size: 11, font });
    const shifted = doc.addPage([400, 600]);
    // setMediaBox/setCropBox take (x, y, width, height).
    shifted.setMediaBox(-20, -30, 400, 600);
    shifted.drawText('ANCHORWORD', { x: 60, y: 500, size: 11, font });
    const cropped = doc.addPage([400, 600]);
    cropped.setCropBox(20, 30, 360, 540);
    cropped.drawText('ANCHORWORD', { x: 60, y: 500, size: 11, font });
    const bytes = new Uint8Array(await doc.save());

    const pages = await extractPages(bytes);
    assert.equal(pages.length, 3);
    assert.deepEqual(pages[0].view, [0, 0, 400, 600]);
    assert.deepEqual(pages[1].view, [-20, -30, 380, 570]);
    assert.deepEqual(pages[2].view, [20, 30, 380, 570]);

    const translations = new Map([['0:0', '译文甲'], ['1:0', '译文乙'], ['2:0', '译文丙']]);
    const result = await renderBilingual({ sourceBytes: bytes, pages, translations, debug: true });
    assert.equal(result.debug.filter(d => d.translated).length, 3);

    const parsed = await pdfjs.getDocument({ data: result.bytes.slice() }).promise;
    try {
        for (const [index, page] of pages.entries()) {
            const view = await parsed.getPage(index + 1);
            const items = (await view.getTextContent()).items.filter((i): i is pdfjs.TextItem => 'str' in i);
            const half = page.width + 12;
            const right = items.filter(i => i.transform[4] >= half - 1);
            const original = right.find(i => i.str.includes('ANCHORWORD'));
            const translated = right.find(i => i.str.includes('译文'));
            assert.ok(original, `page ${index + 1}: the drawn source page is missing from the translated half`);
            assert.ok(translated, `page ${index + 1}: the translation is missing from the translated half`);
            // Both must sit at the same place; before the fix they differed by
            // exactly the box origin (-20,-30) / (20,30).
            assert.ok(Math.abs(translated.transform[4] - original.transform[4]) < 1.5,
                `page ${index + 1}: translation x=${translated.transform[4]} vs original x=${original.transform[4]}`);
            assert.ok(Math.abs(translated.transform[5] - original.transform[5]) < 2.5,
                `page ${index + 1}: translation y=${translated.transform[5]} vs original y=${original.transform[5]}`);
        }
    } finally { await parsed.destroy(); }
});
