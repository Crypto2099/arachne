/**
 * Rendering primitives shared by every self-contained HTML page this
 * project publishes to GitHub Pages (everything under `src/compat/site/`),
 * so the pages read as one site rather than files that happen to share a
 * directory.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;');
}

/**
 * Two rules of equal weight, one unbroken and one segmented: the site's own
 * thesis, an encoder that frames every list the same way against one that
 * changes at 24 items. Shared as the tab icon for every page. Inlined as a
 * data URI, so the icon costs no request and the "fetches nothing
 * off-origin" rule holds for it too. `currentColor` is not available to a
 * favicon, so both rules are drawn in colours that hold up against a light
 * and a dark tab strip.
 */
export const FAVICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
      '<rect width="16" height="16" rx="3" fill="#222733"/>' +
      '<rect x="4" y="2" width="2.4" height="12" rx="1.2" fill="#d9a94a"/>' +
      '<rect x="9.6" y="2" width="2.4" height="3.2" rx="1.2" fill="#6f9cf5"/>' +
      '<rect x="9.6" y="6.4" width="2.4" height="3.2" rx="1.2" fill="#6f9cf5"/>' +
      '<rect x="9.6" y="10.8" width="2.4" height="3.2" rx="1.2" fill="#6f9cf5"/>' +
      '</svg>',
  );

/**
 * The colour tokens and typefaces every page on this site is built from.
 * Inline and same-origin only, per the deploy contract: no external
 * stylesheet or font is fetched, so both families below are system stacks.
 * `color-scheme` plus the `prefers-color-scheme` override are what keep this
 * correct in both light and dark without any script deciding at runtime.
 *
 * Two hues carry the two framings, gold for definite-length everywhere and
 * blue for the Haskell rule that switches at 24, because those two already
 * carry that meaning in the favicon and the masthead. Three more carry
 * outcomes: green for a correct hash, red for a wrong one, plum for a
 * refusal. None of the five is reused for anything else, so a colour on
 * this site always means one thing.
 */
export const THEME_TOKENS = `
:root {
  color-scheme: light dark;
  --serif: ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, Cambria, "Times New Roman", serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --ground: #eceef3;
  --card: #ffffff;
  --ink: #171b24;
  --ink-2: #5a6170;
  --rule: #d3d8e1;
  --rule-soft: #e6e9ef;
  --section-rule: #3b4354;
  --link: #1f4fb0;
  --blue: #2a56b8;
  --blue-ink: #1b3c85;
  --blue-tint: #e8edfb;
  --blue-line: #bacbf0;
  --gold: #9a6a00;
  --gold-ink: #6f4c00;
  --gold-tint: #fbf1da;
  --gold-line: #e7d19b;
  --ok: #1d7a4a;
  --ok-ink: #145c37;
  --ok-tint: #e2f3e9;
  --ok-line: #a9dbbf;
  --bad: #b3261e;
  --bad-ink: #8f1d17;
  --bad-tint: #fbe7e5;
  --bad-line: #f0b3ad;
  --plum: #6f3f9c;
  --plum-ink: #55307a;
  --plum-tint: #efe7f8;
  --plum-line: #cdb6e6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: #101319;
    --card: #181c24;
    --ink: #e4e8f0;
    --ink-2: #99a1b2;
    --rule: #2c3240;
    --rule-soft: #232833;
    --section-rule: #4b5466;
    --link: #8ab0ff;
    --blue: #6f9cf5;
    --blue-ink: #bacefb;
    --blue-tint: #182742;
    --blue-line: #2f4a7d;
    --gold: #d9a94a;
    --gold-ink: #f0cd87;
    --gold-tint: #332811;
    --gold-line: #5e4a1c;
    --ok: #5fc48f;
    --ok-ink: #a8e6c4;
    --ok-tint: #12301f;
    --ok-line: #24583a;
    --bad: #ff8a80;
    --bad-ink: #ffb4ad;
    --bad-tint: #3a1614;
    --bad-line: #6b2a26;
    --plum: #c19bea;
    --plum-ink: #dcc4f5;
    --plum-tint: #261a35;
    --plum-line: #4a3566;
  }
}`;
