import type { SiteData } from './data.js';
import { renderChainEvidencePage } from './chain-evidence.js';
import { renderHomePage } from './home.js';
import { renderMethodsPage } from './methods.js';
import { renderResultPage } from './result.js';
import { renderToolPage } from './tool.js';
import { resultPagePath, toolPagePath } from './summaries.js';

export type { SiteData, VectorSummary } from './data.js';
export { loadSiteData, type SiteDataPaths } from './load.js';
export { renderPage, REPO_URL, REPO_BLOB, type PageOptions, type NavKey } from './shell.js';
export { renderHomePage } from './home.js';
export { renderToolPage } from './tool.js';
export { renderResultPage } from './result.js';
export { renderMethodsPage } from './methods.js';
export { renderChainEvidencePage } from './chain-evidence.js';
export * from './summaries.js';
export * from './vocabulary.js';

/**
 * Every page of the site, keyed by the path it is served at relative to the
 * site root. The deploy script writes each entry to that path and copies the
 * data files beside them; nothing else decides what the site contains.
 */
export function renderSitePages(data: SiteData): Map<string, string> {
  const pages = new Map<string, string>();
  pages.set('index.html', renderHomePage(data));
  pages.set('methods.html', renderMethodsPage(data));
  pages.set('chain-evidence.html', renderChainEvidencePage(data));
  for (const tool of data.aggregate.tools) {
    pages.set(toolPagePath(tool.id), renderToolPage(data, tool));
    for (const result of data.results.get(tool.id) ?? []) {
      pages.set(resultPagePath(result), renderResultPage(data, tool, result));
    }
  }
  return pages;
}
