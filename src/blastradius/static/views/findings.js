/**
 * Findings — full, filterable diagnostic list plus the tree-impact detail panel.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * Selection is keyed by the stable id `file:line:type:target`, never by object
 * identity. The router owns `#findings/<id>`; this view only calls
 * ctx.view('findings', id) so Back/Forward and deep links stay consistent.
 */

import { el, emptyState, emptyBlock } from '../lib/dom.js';
import { findIssue, issueId, number, percent, severityRank } from '../lib/format.js';

export const PAGE_SIZE = 30;

const DEFAULT_SORT = 'severity';
const SORTS = Object.freeze([
  ['severity', 'Severity'],
  ['file', 'File path'],
  ['impact', 'Impact'],
]);

// Caret position survives the re-render caused by typing in the search field.
let caret = null;

function hasTreeImpact(issue) {
  return Boolean(issue?.impact?.has_tree_impact);
}

function compareIds(left, right) {
  return issueId(left).localeCompare(issueId(right));
}

function pad2(value) {
  return String(value ?? 0).padStart(2, '0');
}

/** Deep-link id: the contract prefers ctx.format, falling back to lib/format. */
function issueLinkId(ctx, issue) {
  return typeof ctx.format?.issueId === 'function' ? ctx.format.issueId(issue) : issueId(issue);
}

export function filterIssues(issues, filters = {}) {
  const query = String(filters.query ?? '').trim().toLowerCase();
  const severity = filters.severity ?? 'all';
  const impactOnly = Boolean(filters.impactOnly);
  return (issues ?? []).filter(issue => {
    if (severity !== 'all' && issue.severity !== severity) return false;
    if (impactOnly && !hasTreeImpact(issue)) return false;
    if (!query) return true;
    return `${issue.file} ${issue.type} ${issue.target} ${issue.message}`.toLowerCase().includes(query);
  });
}

/**
 * Ordered stable ids of the findings on the current page. The shell's keyboard
 * shortcuts use this to move the selection without duplicating the view's
 * filter/sort/pagination pipeline.
 */
export function visibleIssueIds(report, filters = {}) {
  const filtered = sortIssues(filterIssues(report?.issues, filters), filters.sort ?? DEFAULT_SORT);
  const page = Math.max(0, filters.page ?? 0);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  return filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE).map(issueId);
}

/** Stable ordering for the visible list. Default is severity, worst first. */
function sortIssues(issues, sort) {
  const list = [...(issues ?? [])];
  const key = sort ?? DEFAULT_SORT;
  if (key === 'file') {
    list.sort((left, right) =>
      String(left.file).localeCompare(String(right.file)) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      severityRank(left.severity) - severityRank(right.severity) ||
      compareIds(left, right));
  } else if (key === 'impact') {
    list.sort((left, right) => {
      const leftCount = hasTreeImpact(left) ? Number(left.impact.affected_count) : -1;
      const rightCount = hasTreeImpact(right) ? Number(right.impact.affected_count) : -1;
      return (rightCount - leftCount) ||
        severityRank(left.severity) - severityRank(right.severity) ||
        String(left.file).localeCompare(String(right.file)) ||
        compareIds(left, right);
    });
  } else {
    list.sort((left, right) =>
      severityRank(left.severity) - severityRank(right.severity) ||
      String(left.file).localeCompare(String(right.file)) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      compareIds(left, right));
  }
  return list;
}

/**
 * Wrap every case-insensitive occurrence of `query` in a <mark> built from DOM
 * nodes. Report content is never parsed as markup, so this is text-node only.
 */
function highlight(text, query) {
  const value = String(text ?? '');
  const needle = String(query ?? '').trim().toLowerCase();
  if (!needle) return [document.createTextNode(value)];
  const haystack = value.toLowerCase();
  const nodes = [];
  let cursor = 0;
  for (;;) {
    const at = haystack.indexOf(needle, cursor);
    if (at === -1) {
      if (cursor < value.length) nodes.push(document.createTextNode(value.slice(cursor)));
      break;
    }
    if (at > cursor) nodes.push(document.createTextNode(value.slice(cursor, at)));
    nodes.push(el('mark', { text: value.slice(at, at + needle.length) }));
    cursor = at + needle.length;
  }
  if (!nodes.length) nodes.push(document.createTextNode(value));
  return nodes;
}

/* ------------------------------------------------------------ tree impact */

function basename(file) {
  const value = String(file ?? '');
  const slash = value.lastIndexOf('/');
  return slash === -1 ? value : value.slice(slash + 1);
}

/** The longest reverse-dependency path is the representative impact chain. */
function primaryPath(impact) {
  const paths = (impact?.paths ?? []).filter(path => Array.isArray(path) && path.length >= 2);
  if (!paths.length) return [];
  return paths.reduce((best, path) => (path.length > best.length ? path : best), paths[0]);
}

function hopLabel(index) {
  return index === 1 ? 'direct' : 'transitive';
}

/**
 * Terminal-like monospace diagram of the impact chain, e.g.
 *   Chart.tsx ──direct──▶ Dashboard.tsx ──transitive──▶ App.tsx
 */
function impactDiagram(impact) {
  const wrap = el('div', { className: 'impact-diagram mono' });
  const path = primaryPath(impact);
  if (!path.length) {
    wrap.append(el('span', { className: 'impact-diagram-line', text: '— no dependency paths' }));
    return wrap;
  }
  wrap.setAttribute('role', 'img');
  wrap.setAttribute('aria-label', `Tree impact path: ${path.join(' to ')}.`);
  wrap.append(el('span', { className: 'impact-node', text: basename(path[0]) }));
  for (let index = 1; index < path.length; index += 1) {
    wrap.append(
      el('span', { className: 'impact-hop', text: ` ──${hopLabel(index)}──▶ ` }),
      el('span', { className: 'impact-node', text: basename(path[index]) }),
    );
  }
  return wrap;
}

/** The chain plus any affected files that the diagram does not already show. */
function impactNote(impact, path) {
  const chain = path.join(' → ');
  const shown = new Set(path);
  const extras = [
    ...(impact?.direct_dependents ?? []),
    ...(impact?.transitive_dependents ?? []),
  ].filter(file => !shown.has(file));
  const unique = [...new Set(extras)];
  return unique.length ? `${chain}, plus ${unique.join(', ')}.` : `${chain}.`;
}

function impactBox(impact) {
  const box = el('div', { className: 'impact-box' });
  box.append(el('div', { className: 'impact-label', text: 'Blast radius / affected files' }));
  const affected = Number(impact?.affected_count ?? 0);
  const eligible = Number(impact?.eligible_count ?? 0);
  const value = el('div', { className: 'impact-value' });
  value.append(
    document.createTextNode(pad2(affected)),
    el('span', {
      className: 'small',
      text: `/ ${pad2(eligible)} ELIGIBLE · ${percent(impact?.impact_percentage, 0)}`,
    }),
  );
  box.append(value);

  const cells = Math.min(12, Math.max(1, eligible));
  const on = eligible > 0 ? Math.round((affected / eligible) * cells) : 0;
  const scale = el('div', { className: 'blast-scale impact-scale', attrs: { 'aria-hidden': 'true' } });
  for (let index = 0; index < cells; index += 1) {
    scale.append(el('span', { className: index < on ? 'on' : '' }));
  }
  box.append(scale);
  return box;
}

function impactCounts(impact) {
  const list = el('dl', { className: 'impact-counts' });
  for (const [label, value] of [
    ['Direct dependents', impact?.direct_dependents?.length ?? 0],
    ['Transitive dependents', impact?.transitive_dependents?.length ?? 0],
  ]) {
    const item = el('div');
    item.append(el('dt', { text: label }), el('dd', { text: number(value) }));
    list.append(item);
  }
  return list;
}

function detailPanel(issue, ctx, seq, total) {
  const panel = el('article', { className: 'panel detail-panel' });
  if (!issue) {
    emptyState(panel, 'Every dependency tells a story', 'Select a finding to see its direct and transitive dependents.', '⌁');
    return panel;
  }

  const impact = issue.impact ?? { has_tree_impact: false, note: 'No impact data for this finding.' };
  const severity = issue.severity ?? 'clean';

  const top = el('div', { className: 'detail-top' });
  top.append(
    el('span', { className: 'detail-seq', text: `FINDING ${pad2(seq)} / ${pad2(total)}` }),
    el('span', { className: `badge badge--${severity}`, text: String(severity).toUpperCase() }),
  );
  panel.append(top);

  panel.append(el('h3', { className: 'detail-title', text: issue.type }));
  const path = el('div', { className: 'detail-path mono' });
  path.append(
    document.createTextNode(String(issue.file ?? '')),
    el('span', { className: 'loc', text: `:${issue.line ?? 0}` }),
  );
  if (ctx.project?.label) path.append(document.createTextNode(` · ${ctx.project.label}`));
  panel.append(path);

  if (issue.message) panel.append(el('p', { className: 'detail-message', text: issue.message }));

  const meta = el('dl', { className: 'meta-grid' });
  const eligibleText = hasTreeImpact(issue)
    ? `${number(impact.eligible_count)} JS/TS files`
    : 'Not in module graph';
  const impactText = hasTreeImpact(issue)
    ? `${number(impact.affected_count)} affected / ${percent(impact.impact_percentage, 0)}`
    : 'No tree impact';
  for (const [key, value] of [
    ['Rule', issue.type],
    ['Symbol', issue.target ?? '—'],
    ['File', issue.file],
    ['Line', String(issue.line ?? 0)],
    ['Eligible', eligibleText],
    ['Impact', impactText],
  ]) {
    const item = el('div', { className: 'meta-item' });
    item.append(el('dt', { text: key }), el('dd', { text: value }));
    meta.append(item);
  }
  panel.append(meta);

  if (!hasTreeImpact(issue)) {
    const noImpact = el('div', { className: 'no-impact' });
    noImpact.append(
      el('h4', { text: 'No tree impact' }),
      el('p', { text: 'This finding is outside the module graph. Blast radius is not computed for static references such as assets, JSON, CSS or documentation.' }),
    );
    panel.append(noImpact);
    panel.append(el('div', { className: 'impact-label', text: 'Tree impact path' }));
    panel.append(el('div', { className: 'impact-note', text: '— not reachable from the JS/TS import graph' }));
    return panel;
  }

  panel.append(impactBox(impact), impactCounts(impact));
  panel.append(el('div', { className: 'impact-label', text: 'Tree impact path' }));
  panel.append(impactDiagram(impact));
  panel.append(el('div', { className: 'impact-note', text: impactNote(impact, primaryPath(impact)) }));
  if (impact.partial) {
    panel.append(el('p', { className: 'note', text: 'This impact calculation covers a partial graph.' }));
  }
  if (impact.note) panel.append(el('p', { className: 'note', text: impact.note }));
  if ((impact.paths?.length ?? 0) > 200) {
    panel.append(el('p', { className: 'note', text: 'Showing the first 200 dependency paths. Export JSON for every path.' }));
  }
  return panel;
}

/* -------------------------------------------------------------------- copy */

function quotePath(value) {
  const path = String(value ?? '');
  return /\s/.test(path) ? `"${path}"` : path;
}

/** execCommand fallback for contexts without the async Clipboard API. */
function fallbackCopy(value) {
  const area = el('textarea', {
    className: 'clipboard-helper',
    value,
    attrs: { readonly: '', 'aria-hidden': 'true' },
  });
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function copyToClipboard(value) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard.writeText(value).catch(() => fallbackCopy(value));
  }
  return Promise.resolve(fallbackCopy(value));
}

function copyActions(ctx) {
  const report = ctx.state.report;
  const root = ctx.state.session?.root ?? '.';
  const command = `blastradius scan --path ${quotePath(root)} --deterministic-id`;
  const actions = el('div', { className: 'copy-actions' });
  actions.append(
    el('button', {
      className: 'secondary copy-button',
      type: 'button',
      text: 'Copy report ID',
      disabled: !report,
      on: {
        click: () => copyToClipboard(String(report.scan?.id ?? '')).then(ok => {
          ctx.notify(ok ? `Copied report ID ${report.scan.id}` : 'Copy failed — select the ID and press Ctrl+C.');
        }),
      },
    }),
    el('button', {
      className: 'secondary copy-button',
      type: 'button',
      text: 'Copy CLI command',
      on: {
        click: () => copyToClipboard(command).then(ok => {
          ctx.notify(ok ? 'Copied CLI command' : 'Copy failed — select the command and press Ctrl+C.');
        }),
      },
    }),
  );
  return actions;
}

/* ------------------------------------------------------------------- view */

export function render(container, ctx) {
  const { state, view } = ctx;
  const report = state.report;
  const filters = state.filters ?? { query: '', severity: 'all', page: 0 };
  const page = Math.max(0, filters.page ?? 0);
  const query = String(filters.query ?? '').trim();
  const sort = filters.sort ?? DEFAULT_SORT;
  const update = patch => ctx.setState({ filters: { ...filters, ...patch } });
  // Remember which finding row had focus so arrow-key navigation can restore
  // it after the re-render replaces every node.
  const activeIssueId = document.activeElement?.dataset?.issueId ?? null;
  container.replaceChildren();

  const filtered = sortIssues(filterIssues(report?.issues, filters), sort);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE);
  const requested = findIssue(report, state.selectedId);
  const selected = requested && filtered.includes(requested) ? requested : (visible[0] ?? null);
  // The selected row's aria-current: only when it is on this page.
  const activeId = state.selectedId && visible.some(issue => issueId(issue) === state.selectedId)
    ? state.selectedId
    : null;
  const selectedIndex = selected ? filtered.indexOf(selected) : -1;

  const grid = el('div', { className: 'grid12 findings-grid' });
  const listPanel = el('section', { className: 'panel findings-panel col-7' });

  const heading = el('div', { className: 'panel-head' });
  const headingCopy = el('div');
  headingCopy.append(
    el('h2', { text: 'Issue register' }),
    el('p', { className: 'panel-sub', text: 'Select a finding to inspect its tree impact.' }),
  );
  const headMeta = el('div', { className: 'findings-head-meta' });
  const countBadge = el('span', { className: 'micro', text: '00 ITEMS', attrs: { id: 'findings-count' } });
  headMeta.append(countBadge, copyActions(ctx));
  heading.append(headingCopy, headMeta);

  const toolbar = el('div', { className: 'findings-toolbar' });
  const search = el('input', {
    value: filters.query ?? '',
    attrs: { 'aria-label': 'Search findings', placeholder: 'Search files or issue types…', autocomplete: 'off', spellcheck: 'false' },
  });
  const severity = el('select', { className: 'findings-select', attrs: { 'aria-label': 'Filter severity' } });
  for (const [value, label] of [['all', 'All severities'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]) {
    severity.append(el('option', { value, text: label, selected: (filters.severity ?? 'all') === value }));
  }
  const sortSelect = el('select', { className: 'findings-select sort-select', attrs: { 'aria-label': 'Sort findings' } });
  for (const [value, label] of SORTS) {
    sortSelect.append(el('option', { value, text: label, selected: sort === value }));
  }
  const impactChip = el('button', {
    className: `chip${filters.impactOnly ? ' active' : ''}`,
    type: 'button',
    text: 'Tree impact only',
    attrs: { 'aria-pressed': filters.impactOnly ? 'true' : 'false' },
  });
  toolbar.append(search, severity, sortSelect, impactChip);

  const list = el('div', { className: 'finding-list' });
  const pagination = el('div', { className: 'pagination', hidden: true });
  const previous = el('button', { className: 'secondary', type: 'button', text: '← Previous' });
  const next = el('button', { className: 'secondary', type: 'button', text: 'Next →' });
  const pageLabel = el('span');
  pagination.append(previous, pageLabel, next);

  listPanel.append(heading, toolbar, list, pagination);

  const detail = el('aside', { className: 'col-5' });
  detail.append(detailPanel(selected, ctx, selectedIndex + 1, filtered.length));

  grid.append(listPanel, detail);
  container.append(grid);

  if (!report) {
    emptyState(list, 'Start with a scan', 'Choose a directory and run a scan to see its health and dependency impact.');
    search.disabled = true;
    severity.disabled = true;
    sortSelect.disabled = true;
    impactChip.disabled = true;
    return;
  }

  countBadge.textContent = `${pad2(filtered.length)} ITEMS`;

  if (!filtered.length) {
    list.append(report.issues.length
      ? emptyBlock('No matching findings', 'Try a different search or severity.')
      : emptyBlock('No issues detected', 'The configured checks found no issues. Review Coverage to see their limits.'));
  }

  for (const [position, issue] of visible.entries()) {
    const id = issueId(issue);
    const isSelected = id === activeId;
    const button = el('button', {
      className: `finding-row${isSelected ? ' is-selected' : ''}`,
      type: 'button',
      id: `finding-${id}`,
      attrs: {
        'aria-pressed': isSelected ? 'true' : 'false',
        'aria-label': `${issue.severity} severity. ${issue.file} line ${issue.line}. ${issue.type}.`,
        'data-issue-id': id,
      },
      on: { click: () => view('findings', issueLinkId(ctx, issue)) },
    });

    const index = el('span', { className: 'finding-index', text: pad2(current * PAGE_SIZE + position + 1) });
    const main = el('span', { className: 'finding-main' });
    const path = el('span', { className: 'finding-path' });
    path.append(...highlight(String(issue.file ?? ''), query));
    path.append(el('span', { className: 'loc', text: `:${issue.line ?? 0}` }));
    const sub = el('span', { className: 'finding-sub' });
    sub.append(...highlight(String(issue.type ?? ''), query));
    if (issue.target) sub.append(document.createTextNode(` · ${issue.target}`));
    main.append(path, sub);

    const side = el('span', { className: 'finding-side' });
    side.append(el('span', { className: `badge badge--${issue.severity ?? 'clean'}`, text: String(issue.severity ?? '—').toUpperCase() }));
    side.append(el('span', {
      className: 'finding-impact',
      text: hasTreeImpact(issue)
        ? `${number(issue.impact.affected_count)} / ${number(issue.impact.eligible_count)} AFFECTED`
        : 'NO TREE IMPACT',
    }));

    button.append(index, main, side);
    list.append(button);
  }

  pagination.hidden = pages <= 1;
  previous.disabled = current === 0;
  next.disabled = current === pages - 1;
  pageLabel.textContent = `${current + 1} / ${pages}`;

  search.addEventListener('input', () => {
    caret = search.selectionStart;
    update({ query: search.value, page: 0 });
  });
  severity.addEventListener('change', () => update({ severity: severity.value, page: 0 }));
  sortSelect.addEventListener('change', () => update({ sort: sortSelect.value, page: 0 }));
  impactChip.addEventListener('click', () => update({ impactOnly: !filters.impactOnly, page: 0 }));
  previous.addEventListener('click', () => update({ page: Math.max(0, current - 1) }));
  next.addEventListener('click', () => update({ page: Math.min(pages - 1, current + 1) }));

  if (caret !== null) {
    search.focus();
    const position = Math.min(caret, search.value.length);
    search.setSelectionRange(position, position);
    caret = null;
  }

  // Arrow-key navigation re-renders the list; put focus back on the row that
  // had it so the keyboard cursor does not jump to <body>.
  if (activeIssueId) {
    const row = document.getElementById(`finding-${activeIssueId}`);
    if (row) row.focus();
  }
}
