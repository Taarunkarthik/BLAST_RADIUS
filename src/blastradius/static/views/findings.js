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
import { findIssue, issueId, number, severityRank } from '../lib/format.js';

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

function impactBanner(issue) {
  const impact = issue.impact;
  if (!impact?.has_tree_impact) {
    return el('div', { text: 'No Tree Impact', className: 'impact-banner local' });
  }
  if (impact.is_root) {
    const root = el('div', { className: 'impact-banner root' });
    root.append(
      el('strong', { text: '0%' }),
      el('span', { text: ' root node — no dependents in the scanned graph' }),
    );
    return root;
  }
  const banner = el('div', { className: 'impact-banner' });
  const percentage = el('div', { className: 'impact-percentage' });
  percentage.append(
    el('strong', { text: `${impact.impact_percentage}%` }),
    el('span', { text: 'of eligible files affected' }),
  );
  const detail = el('div', { className: 'impact-banner-detail' });
  detail.append(el('span', { text: `${number(impact.affected_count)} affected / ${number(impact.eligible_count)} eligible files` }));
  banner.append(percentage, detail);
  return banner;
}

function impactNumbers(impact) {
  const wrapper = el('div', { className: 'impact-numbers' });
  for (const [label, value] of [
    ['Direct dependents', impact.direct_dependents?.length ?? 0],
    ['Transitive dependents', impact.transitive_dependents?.length ?? 0],
  ]) {
    const item = el('div');
    item.append(el('strong', { text: String(value) }), el('span', { text: label }));
    wrapper.append(item);
  }
  return wrapper;
}

function firstIssueByFile(report) {
  const map = new Map();
  for (const item of report?.issues ?? []) {
    if (!map.has(item.file)) map.set(item.file, item);
  }
  return map;
}

/**
 * A dependent file name. Files with findings deep-link into Findings; the rest
 * open the dependency inspector focused on that file's node.
 */
function fileLink(file, ctx, fileIssues) {
  const first = fileIssues.get(file);
  const button = el('button', {
    className: `tree-link${first ? ' has-finding' : ''}`,
    type: 'button',
    attrs: { 'aria-label': first ? `Open findings for ${file}` : `Open ${file} in the dependency inspector` },
  });
  button.append(el('span', { text: file, className: 'mono' }));
  if (first) button.append(el('span', { text: 'finding', className: 'tree-flag' }));
  button.addEventListener('click', () => {
    if (first) {
      ctx.view('findings', issueId(first));
      return;
    }
    ctx.setState({ dependencyFocus: ctx.graph.nodeId(file) });
    ctx.view('dependencies');
  });
  return button;
}

/**
 * Port of the original tree renderer: one <ul> branch per dependency path.
 * Nodes are collapsible and direct/transitive dependents are colour-coded.
 */
function impactTree(issue, ctx) {
  const fileIssues = firstIssueByFile(ctx.state.report);
  const tree = el('div', { className: 'tree' });
  const root = el('div', { className: 'tree-node tree-root' });
  root.append(el('span', { text: issue.file, className: 'mono' }));
  tree.append(root);

  const branches = new Map([[JSON.stringify([issue.file]), tree]]);
  for (const path of (issue.impact.paths ?? []).slice(0, 200)) {
    for (let index = 1; index < path.length; index += 1) {
      const key = JSON.stringify(path.slice(0, index + 1));
      if (branches.has(key)) continue;
      const parent = branches.get(JSON.stringify(path.slice(0, index)));
      if (!parent) continue;
      let list = [...parent.children].find(child => child.tagName === 'UL');
      if (!list) {
        list = el('ul');
        parent.append(list);
      }
      const file = path[index];
      const item = el('li', { className: `tree-node ${index === 1 ? 'direct' : 'transitive'}` });
      const row = el('div', { className: 'tree-row' });
      const toggle = el('button', {
        className: 'tree-toggle',
        type: 'button',
        text: '▾',
        attrs: { 'aria-expanded': 'true', 'aria-label': `Collapse ${file}` },
      });
      toggle.addEventListener('click', () => {
        const collapsed = item.classList.toggle('collapsed');
        toggle.textContent = collapsed ? '▸' : '▾';
        toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${file}`);
      });
      row.append(toggle, fileLink(file, ctx, fileIssues));
      row.append(el('small', { text: index === 1 ? 'direct' : `distance ${index}`, className: 'tree-tag' }));
      item.append(row);
      list.append(item);
      branches.set(key, item);
    }
  }

  // Leaves have no child list; drop their collapse toggle and align the name.
  for (const node of branches.values()) {
    if (node.tagName !== 'LI') continue;
    const hasChildren = [...node.children].some(child => child.tagName === 'UL');
    if (hasChildren) continue;
    node.classList.add('leaf');
    node.querySelector('.tree-toggle')?.remove();
  }
  return tree;
}

function detailPanel(issue, ctx) {
  const panel = el('article', { className: 'panel detail-panel' });
  const heading = el('div', { className: 'panel-heading' });
  const copy = el('div');
  copy.append(el('h2', { text: 'Tree impact' }), el('p', { text: 'Follow a failure through your code' }));
  heading.append(copy, el('span', { text: 'JS / TS', className: 'pill' }));
  const body = el('div', { className: 'detail' });

  if (!issue) {
    emptyState(body, 'Every dependency tells a story', 'Select a finding to see its direct and transitive dependents.', '⌁');
    panel.append(heading, body);
    return panel;
  }

  const impact = issue.impact ?? { has_tree_impact: false, note: 'No impact data for this finding.' };
  const content = el('div', { className: 'detail-body' });
  content.append(
    el('span', { text: issue.severity, className: `badge ${issue.severity}` }),
    el('h3', { text: `${issue.file}:${issue.line}`, className: 'detail-file' }),
    el('div', { text: issue.type, className: 'finding-type' }),
    el('p', { text: issue.message || issue.target, className: 'detail-message' }),
  );
  if (issue.target) content.append(el('p', { text: `Target: ${issue.target}`, className: 'note mono' }));

  if (!impact.has_tree_impact) {
    content.append(el('div', { text: 'No Tree Impact', className: 'impact-banner local' }), el('p', { text: impact.note, className: 'note' }));
  } else {
    content.append(impactBanner(issue), impactNumbers(impact), impactTree(issue, ctx));
    if ((impact.paths?.length ?? 0) > 200) {
      content.append(el('p', { text: 'Showing the first 200 dependency paths. Export JSON for every path.', className: 'note' }));
    }
    if (impact.partial) content.append(el('p', { text: 'This impact calculation covers a partial graph.', className: 'note' }));
    content.append(el('p', { text: impact.note, className: 'note' }));
  }
  body.append(content);
  panel.append(heading, body);
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
  // The listbox' active descendant: the selected row when it is on this page.
  const activeId = state.selectedId && visible.some(issue => issueId(issue) === state.selectedId)
    ? state.selectedId
    : null;

  const grid = el('div', { className: 'report-grid findings-layout' });
  const listPanel = el('article', { className: 'panel findings-panel' });

  const heading = el('div', { className: 'panel-heading' });
  const headingCopy = el('div');
  const sortLabel = (SORTS.find(([value]) => value === sort) ?? SORTS[0])[1].toLowerCase();
  headingCopy.append(el('h2', { text: 'Findings' }), el('p', { text: `Diagnostics, ordered by ${sortLabel}` }));
  const countBadge = el('span', { className: 'count', text: '0' });
  heading.append(headingCopy, countBadge, copyActions(ctx));

  const controls = el('div', { className: 'filters' });
  const search = el('input', {
    value: filters.query ?? '',
    attrs: { 'aria-label': 'Search findings', placeholder: 'Search files or issue types…', autocomplete: 'off', spellcheck: 'false' },
  });
  const severity = el('select', { attrs: { 'aria-label': 'Filter severity' } });
  for (const [value, label] of [['all', 'All severities'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]) {
    severity.append(el('option', { value, text: label, selected: (filters.severity ?? 'all') === value }));
  }
  const sortSelect = el('select', { className: 'sort-select', attrs: { 'aria-label': 'Sort findings' } });
  for (const [value, label] of SORTS) {
    sortSelect.append(el('option', { value, text: label, selected: sort === value }));
  }
  const impactChip = el('button', {
    className: `chip${filters.impactOnly ? ' active' : ''}`,
    type: 'button',
    text: 'Tree impact only',
    attrs: { 'aria-pressed': filters.impactOnly ? 'true' : 'false' },
  });
  controls.append(search, severity, sortSelect, impactChip);

  const list = el('div', {
    className: 'finding-list',
    attrs: {
      role: 'listbox',
      'aria-label': 'Findings',
      'aria-activedescendant': activeId ? `finding-${activeId}` : null,
    },
  });
  const pagination = el('div', { className: 'pagination', hidden: true });
  const previous = el('button', { className: 'secondary', type: 'button', text: '← Previous' });
  const next = el('button', { className: 'secondary', type: 'button', text: 'Next →' });
  const pageLabel = el('span');
  pagination.append(previous, pageLabel, next);

  listPanel.append(heading, controls, list, pagination);
  container.append(grid);

  if (!report) {
    grid.append(listPanel, detailPanel(null, ctx));
    emptyState(list, 'Start with a scan', 'Choose a directory and run a scan to see its health and dependency impact.');
    search.disabled = true;
    severity.disabled = true;
    sortSelect.disabled = true;
    impactChip.disabled = true;
    return;
  }

  countBadge.textContent = number(filtered.length);

  // Deep-linked selection wins; otherwise the first visible finding is shown so
  // the detail panel is never empty when there is something to inspect. A
  // selection hidden by the current filter falls back to the visible page.
  grid.append(listPanel, detailPanel(selected, ctx));

  if (!filtered.length) {
    list.append(report.issues.length
      ? emptyBlock('No matching findings', 'Try a different search or severity.')
      : emptyBlock('No issues detected', 'The configured checks found no issues. Review Coverage to see their limits.'));
  }

  for (const issue of visible) {
    const id = issueId(issue);
    const isSelected = id === activeId;
    const button = el('button', {
      className: `finding${isSelected ? ' selected' : ''}`,
      type: 'button',
      id: `finding-${id}`,
      attrs: { role: 'option', 'aria-selected': isSelected ? 'true' : 'false', 'data-issue-id': id },
      on: { click: () => view('findings', id) },
    });
    const row = el('div', { className: 'finding-row' });
    const fileSpan = el('span', { className: 'finding-file' });
    fileSpan.append(...highlight(`${issue.file}:${issue.line}`, query));
    row.append(fileSpan, el('span', { text: issue.severity, className: `badge ${issue.severity}` }));
    const typeSpan = el('div', { className: 'finding-type' });
    typeSpan.append(...highlight(issue.type, query));
    button.append(row, typeSpan);
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
