/*
 * Before-paint theme bootstrap (issue 188).
 *
 * Runs as a plain blocking external script from <head> — before the application entry, so the
 * resolved palette is on <html> before the first paint and React never flips it. CSP is
 * `script-src 'self'`, which is exactly what this file rides: no inline code, no remote
 * dependency, no fetch, no logging, no throwing — every lookup that can fail is wrapped, and
 * whatever happens the document ends with a resolved `data-theme` of light or dark.
 */
(() => {
    var stored = null;
    try {
        stored = localStorage.getItem('factory.theme');
    } catch (error) {
        stored = null;
    }
    if (stored !== 'light' && stored !== 'dark') {
        stored = null;
    }
    if (stored === null) {
        try {
            stored = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
        } catch (error) {
            stored = 'dark';
        }
    }
    try {
        document.documentElement.dataset.theme = stored;
    } catch (error) {
        // Nowhere to write; there is nothing left to do.
    }
})();
