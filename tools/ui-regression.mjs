import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PDF_TRANSLATE_PLAYWRIGHT_MODULE || 'playwright');
const output = await build({ entryPoints: ['src/modules/ui/progress.ts'], bundle: true, write: false, format: 'iife', globalName: 'PDFAIProgress' });
const browser = await chromium.launch({ headless: true, ...(process.env.PDF_TRANSLATE_CHROMIUM_PATH ? { executablePath: process.env.PDF_TRANSLATE_CHROMIUM_PATH } : {}) });
try {
    const page = await browser.newPage({ viewport: { width: 900, height: 650 } });
    await page.setContent('<html><body style="background:#f5f6f8;font:14px sans-serif;padding:24px;">PDF AI Translate</body></html>');
    await page.addScriptTag({ content: output.outputFiles[0].text });
    await page.evaluate(() => { window.taskProgress = PDFAIProgress.createTaskProgress(window); window.taskProgress.changeHeadline('正在翻译 12/20'); window.taskProgress.addDescription('实时任务状态：正在处理正文段落'); window.taskProgress.show(); });
    assert.equal(await page.locator('#pdfaitranslate-task-progress').count(), 1);
    const styles = await page.locator('#pdfaitranslate-task-progress').evaluate(el => { const s = getComputedStyle(el); return [s.borderLeftWidth, s.borderRightWidth, s.borderBottomWidth]; });
    assert.deepEqual(styles, ['0px', '0px', '0px']);
    fs.mkdirSync('tools/_out', { recursive: true });
    await page.screenshot({ path: 'tools/_out/progress-preview.png' });
    await page.evaluate(() => window.taskProgress.close());
    assert.equal(await page.locator('#pdfaitranslate-task-progress').count(), 0);
    console.log('PASS: status text updates, all three borders are zero, close removes panel.');
}
finally {
    await browser.close();
}
// The output menu uses XUL labels. Verify both resources declare .label,
// rather than text content that a collapsed native menulist cannot display.
for (const language of ['en-US', 'zh-CN']) {
    const ftl = fs.readFileSync(path.join('addon/locale', language, 'preferences.ftl'), 'utf8');
    for (const mode of ['samedir', 'custom', 'storage'])
        assert.match(ftl, new RegExp(`pdfaitranslate-pref-outputmode-${mode} =\\r?\\n    \\.label = \\S+`));
}
console.log('PASS: all export choices have XUL .label values in both locales.');
