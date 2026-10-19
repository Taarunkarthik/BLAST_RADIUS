/**
 * Map — filesystem / component tree for the scanned repository.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * The SVG dependency graph lives in the Dependencies view; this view answers
 * "where do the findings live on disk?". It builds a directory→file tree from
 * the scan coverage lists (`checked_files`, `not_checked_files`,
 * `excluded_files`, `skipped_files`) plus every `report.issues[]`, gives each
 * leaf a severity badge (or a muted coverage status), and shows a context panel
 * with issues, imports, dependents and the reverse blast radius.
 *
 * Selection is the namespaced file node id (`file:<path>`) stored in
 * `state.graphFocus`, so deep links and re-renders agree. Children are rendered
 * lazily: a directory builds its rows only when opened, and oversized
 * directories stop at a batch with a "show N more" control, so a large repo
 * never paints thousands of nodes at once.
 */

import { el, emptyState } from '../lib/dom.js';
import { issueId, number, plural } from '../lib/format.js';

// Rows rendered per directory before a "show N more" control appears.
const CHILD_BATCH = 100;
// Imports / dependents listed before truncating with a count.
const EDGE_LIMIT = 100;
// Blast-radius nodes listed before truncating with a count.
const AFFECTED_LIMIT = 20;

// Which directories are open survives the re-render that follows selecting a
// file. This mirrors the transient caret state in the other views: it holds
// only path strings (never DOM references) and is reset for a new report.
let expanded = new Set();
let expandedFor = null;

function syncExpansion(report) {
  const id = report?.scan?.id ?? null;
  if (id !== expandedFor) {
    expandedFor = id;
    expanded = new Set();
  }
}

/** Open every directory on the path to a file so a deep link is visible. */
function revealAncestors(path) {
  const segments = String(path ?? '').replaceAll('\\', '/').split('/').filter(Boolean);
  for (let index = 1; index < segments.length; index += 1) {
    expanded.add(segments.slice(0, index).join('/'));
  }
}

function isInactiveFile(node) {
  return node.status === 'unchecked' || node.status === 'excluded' || node.status === 'skipped';
}

/* -------------------------------------------------------------------- tree */

function buildFile(node, ctx, selectedId) {
  const id = ctx.graph.nodeId(node.path);
  const selected = id === selectedId;
  const inactive = isInactiveFile(node);
  const button = el('button', {
    className: `map-file${selected ? ' selected' : ''}${inactive ? ' inactive' : ''}`,
    type: 'button',
    attrs: { 'aria-pressed': selected ? 'true' : 'false' },
  });
  button.append(
    el('span', { className: 'map-glyph', text: inactive ? '○' : '·', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'map-label mono', text: node.name }),
  );
  if (node.maxSeverity) {
    button.append(
      el('span', { className: `badge ${node.maxSeverity}`, text: node.maxSeverity }),
      el('span', { className: 'map-meta', text: `${number(node.counts.issues)} ${plural(node.counts.issues, 'issue')}` }),
    );
  } else if (inactive) {
    button.append(el('span', { className: 'map-status', text: node.status }));
  }
  button.title = inactive && node.reason ? `${node.path} — ${node.reason}` : node.path;
  button.addEventListener('click', () => ctx.setState({ graphFocus: selected ? null : id }));
  return button;
}

function fillChildren(directory, container, ctx, root, selectedId, start) {
  const children = directory.children ?? [];
  const end = Math.min(children.length, start + CHILD_BATCH);
  for (let index = start; index < end; index += 1) {
    const child = children[index];
    container.append(child.kind === 'directory'
      ? buildDirectory(child, ctx, root, selectedId)
      : buildFile(child, ctx, selectedId));
  }
  if (end < children.length) {
    const remaining = children.length - end;
    const more = el('button', {
      className: 'map-more',
      type: 'button',
      text: `Show ${number(Math.min(CHILD_BATCH, remaining))} more (${number(remaining)} hidden)`,
    });
    more.addEventListener('click', () => {
      more.remove();
      fillChildren(directory, container, ctx, root, selectedId, end);
    });
    container.append(more);
  }
}

function buildDirectory(node, ctx, root, selectedId) {
  const wrapper = el('div', { className: 'map-node' });
  const open = expanded.has(node.path);
  const toggle = el('button', {
    className: 'map-dir',
    type: 'button',
    attrs: { 'aria-expanded': open ? 'true' : 'false' },
  });
  toggle.append(
    el('span', { className: 'map-caret', text: open ? '▾' : '▸', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'map-label', text: node.name || '.' }),
  );
  if (node.maxSeverity) toggle.append(el('span', { className: `badge ${node.maxSeverity}`, text: node.maxSeverity }));
  const counts = node.counts;
  toggle.append(el('span', {
    className: 'map-meta',
    text: `${number(counts.files)} ${plural(counts.files, 'file')}${counts.issues ? ` · ${number(counts.issues)} issues` : ''}`,
  }));
  if (node.path) toggle.title = node.path;

  const children = el('div', { className: 'map-children' });
  children.hidden = !open;
  wrapper.append(toggle, children);

  let filled = false;
  const fill = () => {
    if (filled) return;
    filled = true;
    fillChildren(node, children, ctx, root, selectedId, 0);
  };
  if (open) fill();

  toggle.addEventListener('click', () => {
    const next = !expanded.has(node.path);
    if (next) expanded.add(node.path); else expanded.delete(node.path);
    if (next) fill();
    children.hidden = !next;
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    const caret = toggle.querySelector('.map-caret');
    if (caret) caret.textContent = next ? '▾' : '▸';
  });

  return wrapper;
}

/* --------------------------------------------------------- context panel */

function edgeList(title, subtitle, ids, ctx, root) {
  const block = el('div', { className: 'map-block' });
  block.append(el('h3', { text: title }), el('p', { className: 'note', text: subtitle }));
  if (!ids.length) {
    block.append(el('p', { className: 'note', text: 'None' }));
    return block;
  }
  const list = el('ul', { className: 'map-list' });
  for (const id of ids.slice(0, EDGE_LIMIT)) {
    const label = ctx.graph.nodeLabel(id);
    const kind = ctx.graph.nodeKind(id);
    const row = el('div', { className: 'map-edge-row' });
    const inTree = ctx.graph.isFileNode(id) && Boolean(ctx.tree.findNode(root, label));
    if (inTree) {
      const link = el('button', {
        className: 'map-link',
        type: 'button',
        on: { click: () => ctx.setState({ graphFocus: id }) },
      });
      link.append(el('span', { className: 'mono', text: label }), el('span', { className: 'muted', text: kind }));
      row.append(link);
    } else {
      row.append(el('span', { className: 'mono', text: label }), el('span', { className: 'muted', text: kind }));
    }
    const item = el('li');
    item.append(row);
    list.append(item);
  }
  block.append(list);
  if (ids.length > EDGE_LIMIT) {
    block.append(el('p', { className: 'note', text: `Showing ${number(EDGE_LIMIT)} of ${number(ids.length)}.` }));
  }
  return block;
}

function contextPanel(selectedId, root, graph, ctx) {
  const panel = el('section', { className: 'panel map-context' });
  const heading = el('div', { className: 'panel-heading' });
  const copy = el('div');
  copy.append(el('h2', { text: 'Selection' }), el('p', { text: 'Findings, imports and blast radius for one file' }));
  heading.append(copy);
  panel.append(heading);

  const body = el('div', { className: 'section-content' });
  panel.append(body);

  if (!selectedId) {
    emptyState(body, 'Select a file', 'Expand the tree and click a file to see its issues, imports and blast radius.', '⌗');
    return panel;
  }

  const path = ctx.graph.nodeLabel(selectedId);
  const node = ctx.tree.findNode(root, path);
  const issues = node?.issues ?? [];

  const focus = el('div', { className: 'map-focus' });
  focus.append(el('span', { className: 'pill', text: 'file' }), el('strong', { className: 'mono', text: path }));
  body.append(focus);

  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const issue of issues) {
    if (Object.hasOwn(bySeverity, issue.severity)) bySeverity[issue.severity] += 1;
  }
  const facts = el('div', { className: 'map-facts' });
  for (const severity of ['high', 'medium', 'low']) {
    const fact = el('div', { className: `map-fact ${severity}` });
    fact.append(el('strong', { text: number(bySeverity[severity]) }), el('span', { text: severity }));
    facts.append(fact);
  }
  const total = el('div', { className: 'map-fact' });
  total.append(el('strong', { text: number(issues.length) }), el('span', { text: 'total issues' }));
  facts.append(total);
  body.append(facts);

  if (!issues.length) {
    body.append(el('p', { className: 'note', text: node ? 'No findings for this file.' : 'This file appears in the graph but not in the coverage lists.' }));
  }

  const firstIssue = issues[0] ?? null;
  const actions = el('div', { className: 'map-actions' });
  actions.append(
    el('button', {
      className: 'secondary',
      type: 'button',
      text: 'Open in Findings',
      on: {
        click: () => {
          if (firstIssue) ctx.setState({ selectedId: issueId(firstIssue) });
          ctx.view('findings');
        },
      },
    }),
    el('button', {
      className: 'secondary',
      type: 'button',
      text: 'Show in Dependencies',
      on: {
        click: () => {
          ctx.setState({ dependencyFocus: selectedId });
          ctx.view('dependencies');
        },
      },
    }),
  );
  body.append(actions);

  if (!graph) {
    body.append(el('p', {
      className: 'note',
      text: 'This scan has no dependency graph (health mode or no JS/TS sources), so imports and blast radius are unavailable.',
    }));
    return panel;
  }

  body.append(
    edgeList('Imports', 'Nodes this file points at', graph.dependencies(selectedId), ctx, root),
    edgeList('Imported by', 'Files that depend on this one', graph.dependents(selectedId), ctx, root),
  );

  const radius = ctx.graph.blastRadius(graph, selectedId);
  const block = el('div', { className: 'map-block' });
  block.append(el('h3', { text: 'Blast radius' }), el('p', { className: 'note', text: 'Files that would be affected by a change here' }));
  const radiusFacts = el('div', { className: 'map-facts' });
  for (const [label, value] of [
    ['Direct', radius.direct.length],
    ['Transitive', radius.transitive.length],
    ['Affected', radius.affected.length],
  ]) {
    const fact = el('div', { className: 'map-fact' });
    fact.append(el('strong', { text: number(value) }), el('span', { text: label }));
    radiusFacts.append(fact);
  }
  block.append(radiusFacts);

  if (radius.isRoot) {
    block.append(el('p', { className: 'note', text: 'No dependents in the scanned graph; this does not establish a runtime entry point.' }));
  } else {
    const list = el('ol', { className: 'map-affected' });
    for (const id of radius.affected.slice(0, AFFECTED_LIMIT)) {
      list.append(el('li', { text: `${ctx.graph.nodeLabel(id)} · distance ${radius.distances.get(id)}` }));
    }
    block.append(list);
    if (radius.affected.length > AFFECTED_LIMIT) {
      block.append(el('p', { className: 'note', text: `Showing ${number(AFFECTED_LIMIT)} of ${number(radius.affected.length)} affected nodes.` }));
    }
  }
  body.append(block);

  return panel;
}

/* ---------------------------------------------------------------- render */

export function render(container, ctx) {
  const { state } = ctx;
  const report = state.report;
  container.replaceChildren();

  if (!report) {
    emptyState(
      container,
      'No files to map yet',
      'Run a scan to build the filesystem tree from checked, excluded and skipped files.',
      '⌗',
    );
    return;
  }

  syncExpansion(report);

  const scan = report.scan ?? {};
  const root = ctx.tree.buildTree(scan, report.issues ?? []);
  const rawGraph = report.graph;
  const graph = rawGraph?.nodes?.length ? ctx.graph.buildGraph(rawGraph) : null;

  const focus = state.graphFocus ? ctx.graph.nodeId(state.graphFocus) : null;
  const selectedId = focus && ctx.graph.isFileNode(focus) ? focus : null;
  if (selectedId) revealAncestors(ctx.graph.nodeLabel(selectedId));

  const grid = el('div', { className: 'map-grid' });
  const treePanel = el('section', { className: 'panel map-tree-panel' });

  const treeHeading = el('div', { className: 'panel-heading' });
  const treeCopy = el('div');
  treeCopy.append(el('h2', { text: 'Filesystem map' }), el('p', { text: 'Component tree with per-file severity and coverage' }));
  const counts = root.counts;
  treeHeading.append(treeCopy, el('span', {
    className: 'pill',
    text: `${number(counts.files)} ${plural(counts.files, 'file')} · ${number(counts.issues)} issues`,
  }));
  treePanel.append(treeHeading);

  if (scan.partial || scan.graph_partial) {
    const banner = el('div', { className: 'map-banner' });
    const bannerCopy = el('div');
    bannerCopy.append(
      el('strong', { text: 'Partial coverage' }),
      el('span', { text: 'Some files or imports were not checked, so this tree and the blast radius may be incomplete.' }),
    );
    banner.append(bannerCopy, el('button', {
      className: 'secondary',
      type: 'button',
      text: 'Open Coverage',
      on: { click: () => ctx.view('coverage') },
    }));
    treePanel.append(banner);
  }

  const treeBody = el('div', { className: 'map-tree-body' });
  if (!root.children.length) {
    treeBody.append(el('p', { className: 'note', text: 'No files were discovered in this scan.' }));
  } else {
    fillChildren(root, treeBody, ctx, root, selectedId, 0);
  }
  treePanel.append(treeBody);

  grid.append(treePanel, contextPanel(selectedId, root, graph, ctx));
  container.append(grid);
}
