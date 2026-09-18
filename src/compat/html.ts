/**
 * Rendering primitives shared by every self-contained HTML page this
 * project publishes to GitHub Pages (the compat matrix in `site.ts`, the
 * chain evidence record in `chain-evidence-site.ts`), so the two read as one
 * site rather than two pages that happen to share a directory.
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
 * Two rules of equal weight, one unbroken and one segmented: the compat
 * matrix's own thesis, an encoder that frames every array the same way
 * against one that changes at 24. Shared as the tab icon for every page on
 * this site, including the chain evidence page, which corroborates that same
 * divergence on chain rather than drawing a different motif. Inlined as a
 * data URI, so the icon costs no request and the "fetches nothing
 * off-origin" rule holds for it too. `currentColor` is not available to a
 * favicon, so both rules are drawn in a mid grey that holds up against a
 * light and a dark tab strip.
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
 * The color tokens and typefaces every page on this site is built from.
 * Inline and same-origin only, per the deploy contract: no external
 * stylesheet or font is fetched, so both families below are system stacks.
 * `color-scheme` plus the `prefers-color-scheme` override are what keep this
 * correct in both light and dark without any script deciding at runtime.
 *
 * Kept in one place so a page added later inherits the same palette rather
 * than a copy that can drift from it; each page still owns its own layout
 * and component rules.
 */
export const THEME_TOKENS = `
:root {
  color-scheme: light dark;
  --serif: ui-serif, "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, Cambria, "Times New Roman", serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --ground: #e9ebf0;
  --card: #ffffff;
  --ink: #191d26;
  --ink-2: #5c6472;
  --rule: #d3d8e1;
  --rule-soft: #e6e9ef;
  --section-rule: #3b4354;
  --link: #1f4fb0;
  --node: #2a56b8;
  --node-ink: #1b3c85;
  --node-tint: #e8edfb;
  --node-line: #bacbf0;
  --node-wash: #f3f6fd;
  --eco: #9a6a00;
  --eco-ink: #7a5300;
  --eco-tint: #fbf1da;
  --eco-line: #e7d19b;
  --eco-wash: #fdf8ed;
  --alarm: #a3201f;
  --caution: #fdf3e3;
  --caution-line: #e6cfa4;
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
    --node: #6f9cf5;
    --node-ink: #bacefb;
    --node-tint: #182742;
    --node-line: #2f4a7d;
    --node-wash: #151e33;
    --eco: #d9a94a;
    --eco-ink: #f0cd87;
    --eco-tint: #332811;
    --eco-line: #5e4a1c;
    --eco-wash: #251e11;
    --alarm: #ff938c;
    --caution: #2d2413;
    --caution-line: #574728;
  }
}`;
