import type { Framing, VectorStatus } from '../classify.js';
import type { CompatSummary, CompatResult } from '../result-schema.js';
import type { AggregateTool } from '../aggregate.js';
import type { ConstructionPath } from '../types.js';
import { escapeAttr, escapeHtml } from '../html.js';
import {
  CHANNEL_LABEL,
  formatCount,
  formatDate,
  framingClass,
  framingLabel,
  OUTCOME_LABEL,
  plural,
} from './vocabulary.js';
import { resultPagePath, toolPagePath, type PathState } from './summaries.js';

/** Small pieces of markup several pages share, so a chip or a count reads the same everywhere. */

export function framingChip(framing: Framing, path: ConstructionPath): string {
  return `<span class="chip chip-${framingClass(framing)}">${escapeHtml(framingLabel(framing, path))}</span>`;
}

const OUTCOME_CHIP: Record<VectorStatus, string> = {
  agreed: 'chip-ok',
  diverged: 'chip-bad',
  refused: 'chip-refused',
  unsupported: 'chip-unsup',
};

export function outcomeChip(status: VectorStatus, count?: number): string {
  const label =
    count === undefined ? OUTCOME_LABEL[status] : `${formatCount(count)} ${OUTCOME_LABEL[status]}`;
  return `<span class="chip ${OUTCOME_CHIP[status]}">${escapeHtml(label)}</span>`;
}

export const OUTCOME_EDGE: Record<VectorStatus, string> = {
  agreed: 'edge-ok',
  diverged: 'edge-bad',
  refused: 'edge-refused',
  unsupported: 'edge-unsup',
};

/**
 * A run's outcome in one line: every non-zero problem count as a chip, then
 * how many were correct. A zero is not printed, so a row with nothing wrong
 * reads as a single quiet phrase and a row with something wrong shows it in
 * colour.
 */
export function outcomeCounts(summary: CompatSummary): string {
  const chips: string[] = [];
  if (summary.diverged > 0) chips.push(outcomeChip('diverged', summary.diverged));
  if (summary.refused > 0) chips.push(outcomeChip('refused', summary.refused));
  if (summary.unsupported > 0) chips.push(outcomeChip('unsupported', summary.unsupported));
  const correct = `${formatCount(summary.agreed)} of ${formatCount(summary.total)} correct`;
  if (chips.length === 0) return `<span class="chip chip-ok">${escapeHtml(correct)}</span>`;
  return `<span class="counts">${chips.join(' ')}</span> <span class="sub">${escapeHtml(correct)}</span>`;
}

/** "16 scripts a node has carried" or "142 corpus scripts", for the set a run was measured against. */
export function setPhrase(path: ConstructionPath, total: number): string {
  if (path === 'decode-onchain') {
    return `${formatCount(total)} ${plural(total, 'script')} a node has carried`;
  }
  if (path === 'decode') {
    // Two answers per vector, one per framing of its bytes.
    const vectors = total / 2;
    return `${formatCount(vectors)} corpus ${plural(vectors, 'script')}, each in both framings`;
  }
  return `${formatCount(total)} corpus ${plural(total, 'script')}`;
}

export function releasePhrase(result: Pick<CompatResult, 'version' | 'channel'>): string {
  return `<span class="mono">${escapeHtml(result.version)}</span>, ${escapeHtml(CHANNEL_LABEL[result.channel])}`;
}

export function timestamp(iso: string): string {
  return `<time datetime="${escapeAttr(iso)}" title="${escapeAttr(iso)}">${escapeHtml(formatDate(iso))}</time>`;
}

export function toolLink(tool: Pick<AggregateTool, 'id' | 'displayName'>, root: string): string {
  return `<a href="${escapeAttr(root + toolPagePath(tool.id))}">${escapeHtml(tool.displayName)}</a>`;
}

export function resultLink(
  result: Pick<CompatResult, 'tool' | 'version' | 'path'>,
  root: string,
  label: string,
): string {
  return `<a href="${escapeAttr(root + resultPagePath(result))}">${escapeHtml(label)}</a>`;
}

/**
 * One table cell answering one question for one library, for the matrix on
 * the home page. Linked as a whole to the result page, because the cell is a
 * summary and the page is the evidence.
 */
export function resultCell(state: PathState, path: ConstructionPath, root: string): string {
  switch (state.kind) {
    case 'unmeasured':
      return '<span class="chip chip-none">Not asked</span>';
    case 'pending':
      return '<span class="chip chip-none">Not run yet</span>';
    case 'result': {
      const { result } = state;
      const href = escapeAttr(root + resultPagePath(result));
      if (result.status === 'untested') {
        return `<a class="cell-link" href="${href}"><span class="cell-line"><span class="chip chip-none">Could not be installed</span></span><span class="cell-line sub">${escapeHtml(result.version)}</span></a>`;
      }
      const framing =
        result.framing === null
          ? ''
          : `<span class="cell-line">${framingChip(result.framing, path)}</span>`;
      return `<a class="cell-link" href="${href}">${framing}<span class="cell-line">${outcomeCounts(result.summary)}</span><span class="cell-line sub">${escapeHtml(result.version)}</span></a>`;
    }
  }
}
