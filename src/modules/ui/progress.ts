/** Status panel owned by the Zotero main window, without a native popup frame. */
export interface TaskProgress {
    changeHeadline(text: string): void;
    addDescription(text: string): void;
    show(): void;
    close(): void;
}
/** Create a borderless panel; close removes all of its DOM and listeners. */
export function createTaskProgress(win: Window): TaskProgress {
    const doc = win.document;
    const panel = doc.createElementNS('http://www.w3.org/1999/xhtml', 'section') as HTMLElement;
    panel.id = 'pdfaitranslate-task-progress';
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;width:340px;max-width:calc(100vw - 40px);box-sizing:border-box;padding:16px 18px;border:0;border-radius:12px;background:var(--material-background,#fff);color:var(--fill-primary,#222);box-shadow:0 3px 16px rgba(80,90,110,.12);font:menu;';
    const title = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div') as HTMLElement;
    title.style.cssText = 'font-weight:600;line-height:1.5;overflow-wrap:anywhere;';
    const detail = doc.createElementNS('http://www.w3.org/1999/xhtml', 'div') as HTMLElement;
    detail.style.cssText = 'margin-top:8px;line-height:1.5;opacity:.8;overflow-wrap:anywhere;';
    panel.append(title, detail);
    const close = () => { panel.remove(); win.removeEventListener('unload', close); };
    win.addEventListener('unload', close, { once: true });
    return {
        changeHeadline: text => { title.textContent = text; },
        addDescription: text => { detail.textContent = text; },
        show: () => {
            if (!doc.documentElement)
                throw new Error("The Zotero main window is unavailable.");
            doc.documentElement.appendChild(panel);
        },
        close,
    };
}
