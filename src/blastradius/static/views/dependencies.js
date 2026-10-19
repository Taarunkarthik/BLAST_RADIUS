/**
 * Dependencies — inline SVG import graph + node inspector.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * Swiss port of preview.html's Dependencies view. The graph is plain SVG
 * positioned by `lib/graph.js` layeredLayout: without a focus, layers follow
 * longest-path depth; with one, layers are reverse-BFS distance ("blast
 * radius"). Node kinds get distinct shapes — files are squares, packages are
 * diamonds, unresolved specifiers are triangles — drawn with 1px rule-strong
 * strokes on a node-fill surface. Severity colour appears only on fills that
 * encode a finding's severity (`.sev-high` / `.sev-medium` / `.sev-low`).
 *
 * Edges are orthogonal (H / V / HVH) with arrowheads; edges incident to the
 * focus node or inside its blast radius render in --fg, everything else dims.
 * Clicking a node sets `graphFocus` (shared with Map) and toggles off when
 * clicked again. Cycles are safe: layout passes are capped in lib/graph.js,
 * blastRadius tracks visited nodes, and every render loop below is bounded.
 *
 * Zoom is applied through the SVG width/height attributes and survives
 * re-renders via the canvas' data attributes.
 */

import { el, svg, emptyState } from '../lib/dom.js';
import { SEVERITIES, issueId, number, plural, severityRank, truncate } from '../lib/format.js';

const MAX_RENDERED = 300;
const MAX_LABELS = 60;
const MAX_INDEX = 200;
const MAX_LIST = 100;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.25;
const CANVAS_WIDTH = 980;
const CANVAS_HEIGHT = 520;

// Edge start/end padding per node kind, so lines meet shape borders.
const KIND_PAD = { file: 14, package: 20, unresolved: 18 };

// Caret position survives the re-render caused by typing in the filter.
let caret = null;

function clampZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, numeric));
}

// Zoom lives on the SVG element so re-renders (node clicks, filtering)
// keep the scale without module-level mutable state.
function zoomOf(container) {
  const canvas = container.querySelector('svg.dep-svg');
  return canvas ? clampZoom(canvas.dataset.zoom) : 1;
}

function applyZoom(container, zoom) {
  const canvas = container.querySelector('svg.dep-svg');
  if (!canvas) return;
  const next = clampZoom(zoom);
  const width = Number(canvas.dataset.width) || CANVAS_WIDTH;
  const height = Number(canvas.dataset.height) || CANVAS_HEIGHT;
  canvas.setAttribute('width', String(Math.round(width * next)));
  canvas.setAttribute('height', String(Math.round(height * next)));
  canvas.dataset.zoom = String(next);
  const label = container.querySelector('.dep-zoom-value');
  if (label) label.textContent = `${Math.round(next * 100)}%`;
}

/**
 * The focused node. Clicks set `graphFocus` (shared with Map); `dependencyFocus`
 * is still honoured because Map deep-links into this view with it.
 */
function resolveFocus(state, graph, lib) {
  const fromGraph = state.graphFocus && graph.has(state.graphFocus) ? lib.nodeId(state.graphFocus) : null;
  if (fromGraph) return { key: 'graphFocus', id: fromGraph };
  const fromDeps = state.dependencyFocus && graph.has(state.dependencyFocus) ? lib.nodeId(state.dependencyFocus) : null;
  if (fromDeps) return { key: 'dependencyFocus', id: fromDeps };
  return null;
}

/**
 * Worst finding severity per node id. A finding contributes to its file node,
 * to `package:<target>` for package findings and to
 * `unresolved:<file>:<target>` for specifier findings. Nodes without a
 * matching finding get no severity and keep the neutral node fill.
 */
function severityByNode(graph, lib, report) {
  const ranks = new Map();
  for (const issue of report?.issues ?? []) {
    const severity = severityRank(issue?.severity);
    if (severity >= SEVERITIES.length) continue;
    for (const id of [
      lib.nodeId(issue?.file),
      `package:${issue?.target ?? ''}`,
      `unresolved:${issue?.file ?? ''}:${issue?.target ?? ''}`,
    ]) {
      if (!id || !graph.nodeSet.has(id)) continue;
      const current = ranks.get(id);
      if (current === undefined || severity < current) ranks.set(id, severity);
    }
  }
  return ranks;
}

/** Distinct shape per node kind: square (file), diamond (package), triangle (unresolved). */
function nodeShape(kind, x, y, severity) {
  const sevClass = severity === null || severity === undefined ? '' : ` sev-${SEVERITIES[severity]}`;
  if (kind === 'package') {
    return svg('path', {
      class: `dep-shape${sevClass}`,
      d: 'M 0 -18 L 18 0 L 0 18 L -18 0 Z',
      transform: `translate(${x} ${y})`,
    });
  }
  if (kind === 'unresolved') {
    return svg('path', {
      class: `dep-shape${sevClass}`,
      d: 'M 0 -17 L 17 14 L -17 14 Z',
      transform: `translate(${x} ${y})`,
    });
  }
  return svg('rect', { class: `dep-shape${sevClass}`, x: x - 13, y: y - 13, width: 26, height: 26 });
}

/** Orthogonal routing: straight H, straight V, or an HVH elbow. */
function edgePath(from, to) {
  const startPad = KIND_PAD[from.kind] ?? 14;
  const endPad = KIND_PAD[to.kind] ?? 14;
  if (Math.abs(from.y - to.y) < 3) {
    const direction = to.x >= from.x ? 1 : -1;
    return `M ${from.x + direction * startPad} ${from.y} H ${to.x - direction * endPad}`;
  }
  if (Math.abs(from.x - to.x) < 3) {
    const direction = to.y >= from.y ? 1 : -1;
    return `M ${from.x} ${from.y + direction * startPad} V ${to.y - direction * endPad}`;
  }
  const direction = to.x >= from.x ? 1 : -1;
  const midX = (from.x + to.x) / 2;
  return `M ${from.x + direction * startPad} ${from.y} H ${midX} V ${to.y} H ${to.x - direction * endPad}`;
}

function listBlock(title, subtitle, ids, ctx, onSelect) {
  const section = el('div', { className: 'dep-block' });
  section.append(el('h3', { text: title }), el('p', { text: subtitle, className: 'note' }));
  if (!ids.length) {
    section.append(el('p', { text: 'None', className: 'note' }));
    return section;
  }
  const list = el('ul', { className: 'dep-list' });
  for (const id of ids.slice(0, MAX_LIST)) {
    const item = el('li');
    const button = el('button', {
      className: 'dep-link',
      type: 'button',
      on: { click: () => onSelect(id) },
    });
    button.append(
      el('span', { text: ctx.graph.nodeLabel(id), className: 'mono' }),
      el('span', { text: ctx.graph.nodeKind(id), className: 'muted' }),
    );
    item.append(button);
    list.append(item);
  }
  section.append(list);
  if (ids.length > MAX_LIST) {
    section.append(el('p', { text: `Showing ${MAX_LIST} of ${number(ids.length)}.`, className: 'note' }));
  }
  return section;
}

export function render(container, ctx) {
  const { state, setState } = ctx;
  const report = state.report;
  const raw = report?.graph;
  const zoom = zoomOf(container);
  container.replaceChildren();

  if (!report) {
    emptyState(
      container,
      'No dependencies to inspect',
      'Run a scan to build the import graph for this workspace.',
      '⇄',
    );
    return;
  }

  if (!raw || !raw.nodes?.length) {
    emptyState(
      container,
      'No dependency graph in this report',
      'Health scans and repositories without JS/TS sources do not build an import graph. Run a full or structure scan to see dependencies.',
      '⇄',
    );
    return;
  }

  const graph = ctx.graph.buildGraph(raw);
  const focus = resolveFocus(state, graph, ctx.graph);
  const radius = focus ? ctx.graph.blastRadius(graph, focus.id) : null;
  const severityOf = severityByNode(graph, ctx.graph, report);

  const layout = el('div', { className: 'dep-layout' });
  const shell = el('section', { className: 'panel dep-panel' });

  const heading = el('div', { className: 'panel-heading' });
  const copy = el('div');
  copy.append(el('h2', { text: 'Dependencies' }), el('p', { text: 'Direct imports and importers for any node' }));
  const summary = ctx.graph.graphSummary(graph);
  heading.append(copy, el('span', {
    className: 'pill',
    text: [
      `${number(summary.files)} ${plural(summary.files, 'FILE')}`,
      `${number(summary.edges)} ${plural(summary.edges, 'EDGE')}`,
      `${number(summary.packages)} ${plural(summary.packages, 'PACKAGE')}`,
    ].join(' · '),
  }));
  shell.append(heading);

  if (report.scan?.partial || report.scan?.graph_partial) {
    const banner = el('div', { className: 'dep-banner' });
    banner.append(
      el('strong', { text: 'Partial scan' }),
      el('span', { text: 'Coverage or graph information is incomplete; the blast radius may be smaller than reality.' }),
      el('button', {
        className: 'secondary',
        type: 'button',
        text: 'Open Coverage',
        on: { click: () => ctx.view('coverage') },
      }),
    );
    shell.append(banner);
  }

  const controls = el('div', { className: 'dep-toolbar' });
  controls.append(el('span', { className: 'dep-hint', text: 'Blast flow / select a node' }));
  const search = el('input', {
    className: 'dep-search',
    value: state.dependencyQuery ?? '',
    attrs: {
      type: 'search',
      'aria-label': 'Search nodes',
      placeholder: 'Filter nodes…',
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  const zoomGroup = el('div', { className: 'dep-zoom' });
  zoomGroup.append(
    el('button', {
      className: 'dep-zoom-btn',
      type: 'button',
      text: '−',
      attrs: { 'aria-label': 'Zoom out' },
      on: { click: () => applyZoom(container, zoomOf(container) / ZOOM_STEP) },
    }),
    el('span', { className: 'dep-zoom-value', text: `${Math.round(zoom * 100)}%` }),
    el('button', {
      className: 'dep-zoom-btn',
      type: 'button',
      text: '+',
      attrs: { 'aria-label': 'Zoom in' },
      on: { click: () => applyZoom(container, zoomOf(container) * ZOOM_STEP) },
    }),
  );
  controls.append(el('span', { className: 'dep-spacer' }), search, zoomGroup);
  if (focus) {
    controls.append(el('button', {
      className: 'secondary',
      type: 'button',
      text: 'Clear focus',
      on: { click: () => setState({ graphFocus: null, dependencyFocus: null }) },
    }));
  }
  controls.append(el('span', { className: 'dep-hint', text: `${number(graph.nodes.length)} nodes` }));
  shell.append(controls);

  const rendered = new Set(graph.nodes.slice(0, MAX_RENDERED));
  if (focus) rendered.add(focus.id);
  const visibleEdges = graph.edges.filter(edge => rendered.has(edge.source) && rendered.has(edge.target));
  const graphLayout = ctx.graph.layeredLayout(graph, {
    focus: focus ? focus.id : null,
    nodes: [...rendered],
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  });

  const stage = el('div', { className: 'dep-stage' });
  const canvas = svg('svg', {
    class: 'dep-svg',
    viewBox: `0 0 ${graphLayout.width} ${graphLayout.height}`,
    width: Math.round(graphLayout.width * zoom),
    height: Math.round(graphLayout.height * zoom),
    role: 'img',
    'aria-label': `Dependency graph with ${number(graph.nodes.length)} nodes`,
    'data-zoom': zoom,
    'data-width': graphLayout.width,
    'data-height': graphLayout.height,
  });

  const defs = svg('defs');
  for (const [id, hot] of [['dep-arrow', false], ['dep-arrow-hot', true]]) {
    const marker = svg('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: 8,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: 'auto',
    });
    marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: hot ? 'dep-arrowhead hot' : 'dep-arrowhead' }));
    defs.append(marker);
  }
  const edgeLayer = svg('g', { class: 'dep-edges' });
  const nodeLayer = svg('g', { class: 'dep-nodes' });
  canvas.append(defs, edgeLayer, nodeLayer);
  stage.append(canvas);
  shell.append(stage);

  const active = new Set(focus ? [focus.id, ...(radius?.affected ?? [])] : []);

  for (const edge of visibleEdges) {
    const from = graphLayout.positions.get(edge.source);
    const to = graphLayout.positions.get(edge.target);
    if (!from || !to) continue;
    const incident = Boolean(radius) && (edge.source === focus.id || edge.target === focus.id);
    const within = Boolean(radius) && !incident && active.has(edge.source) && active.has(edge.target);
    const hot = incident || within;
    const className = hot ? 'dep-edge is-impact' : 'dep-edge is-dim';
    if (edge.source === edge.target) {
      edgeLayer.append(svg('circle', { class: className, cx: from.x, cy: from.y - 30, r: 8 }));
      continue;
    }
    edgeLayer.append(svg('path', {
      class: className,
      d: edgePath(
        { x: from.x, y: from.y, kind: ctx.graph.nodeKind(edge.source) },
        { x: to.x, y: to.y, kind: ctx.graph.nodeKind(edge.target) },
      ),
      'marker-end': hot ? 'url(#dep-arrow-hot)' : 'url(#dep-arrow)',
    }));
  }

  // Labels are a budgeted resource: the focus node first, then its blast
  // radius. Small graphs label every node, as in the preview; large graphs
  // fall back to the most-depended-on nodes.
  const labelled = new Set();
  if (focus) labelled.add(focus.id);
  let labelBudget = MAX_LABELS;
  const candidates = radius
    ? [...radius.direct, ...radius.affected]
    : (graph.nodes.length <= MAX_LABELS
      ? [...graph.nodes]
      : ctx.graph.mostDependedOn(graph, 8).map(item => item.id));
  for (const id of candidates) {
    if (labelBudget <= 0) break;
    if (!labelled.has(id)) {
      labelled.add(id);
      labelBudget -= 1;
    }
  }

  for (const id of rendered) {
    const position = graphLayout.positions.get(id);
    if (!position) continue;
    const kind = ctx.graph.nodeKind(id);
    let className = 'dep-node';
    if (focus && id === focus.id) className += ' is-selected';
    else if (active.has(id)) className += ' is-impact';
    else if (focus) className += ' is-dim';

    const group = svg('g', {
      class: className,
      tabindex: '0',
      role: 'button',
      'aria-label': `${kind} ${ctx.graph.nodeLabel(id)}`,
    });
    group.append(nodeShape(kind, position.x, position.y, severityOf.get(id) ?? null));
    group.append(svg('title', {}, `${id} — ${number((graph.incoming.get(id) ?? []).length)} dependents`));
    if (labelled.has(id)) {
      group.append(svg('text', {
        x: position.x,
        y: position.y + 32,
        class: 'dep-label',
        'text-anchor': 'middle',
      }, truncate(ctx.graph.nodeLabel(id), 26)));
      group.append(svg('text', {
        x: position.x,
        y: position.y + 43,
        class: 'dep-type',
        'text-anchor': 'middle',
      }, kind.toUpperCase()));
    }
    group.addEventListener('click', () => activate(id));
    group.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (event.repeat) return;
      activate(id);
    });
    nodeLayer.append(group);
  }

  const legend = el('div', { className: 'dep-legend' });
  for (const [kind, label] of [['file', 'File'], ['package', 'Package'], ['unresolved', 'Unresolved']]) {
    const item = el('span', { className: 'dep-legend-item' });
    const swatch = svg('svg', { class: 'dep-legend-shape', viewBox: '0 0 14 14', 'aria-hidden': 'true' });
    const path = kind === 'file'
      ? svg('rect', { x: 2.5, y: 2.5, width: 9, height: 9 })
      : svg('path', { d: kind === 'package' ? 'M7 1.5 12.5 7 7 12.5 1.5 7Z' : 'M7 2 13 12H1Z' });
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    swatch.append(path);
    item.append(swatch, el('span', { text: label }));
    legend.append(item);
  }
  for (const severity of ['high', 'medium', 'low']) {
    const item = el('span', { className: 'dep-legend-item' });
    item.append(
      el('span', { className: `sev-swatch sev-${severity}` }),
      el('span', { text: severity }),
    );
    legend.append(item);
  }
  shell.append(legend);

  const side = el('div', { className: 'dep-side' });
  layout.append(shell, side);
  container.append(layout);

  const query = String(state.dependencyQuery ?? '').trim().toLowerCase();
  const matches = (query
    ? graph.nodes.filter(id => id.toLowerCase().includes(query))
    : graph.nodes).slice(0, MAX_INDEX);

  const index = el('section', { className: 'panel dep-index' });
  const indexHead = el('div', { className: 'section-head' });
  indexHead.append(
    el('h2', { text: 'Nodes' }),
    el('span', { className: 'meta', text: `${number(matches.length)} shown${query ? ` matching “${query}”` : ''}` }),
  );
  index.append(indexHead);
  if (!matches.length) {
    index.append(el('p', { className: 'note', text: 'No nodes match this filter.' }));
  } else {
    const indexList = el('ul', { className: 'dep-list' });
    for (const id of matches) {
      const item = el('li');
      const button = el('button', {
        className: `dep-link${focus && id === focus.id ? ' selected' : ''}`,
        type: 'button',
        attrs: { 'aria-pressed': focus && id === focus.id ? 'true' : 'false' },
        on: { click: () => activate(id) },
      });
      button.append(
        el('span', { text: truncate(ctx.graph.nodeLabel(id), 70), className: 'mono' }),
        el('span', { text: ctx.graph.nodeKind(id), className: 'muted' }),
      );
      item.append(button);
      indexList.append(item);
    }
    index.append(indexList);
  }
  side.append(index);

  const detail = el('section', { className: 'panel dep-detail' });
  if (!focus) {
    detail.append(el('p', {
      className: 'note',
      text: 'Select a node in the graph or the index to see its imports, importers and blast radius.',
    }));
  } else {
    const kind = ctx.graph.nodeKind(focus.id);
    const focusHead = el('div', { className: 'dep-focus' });
    focusHead.append(
      el('span', { className: 'pill', text: kind }),
      el('strong', { className: 'mono', text: truncate(ctx.graph.nodeLabel(focus.id), 70) }),
    );
    detail.append(focusHead);

    const issue = ctx.graph.isFileNode(focus.id)
      ? (report.issues ?? []).find(item => `file:${item.file}` === focus.id)
      : null;
    if (issue) {
      detail.append(el('button', {
        className: 'secondary',
        type: 'button',
        text: `Open finding ${issue.file}:${issue.line} →`,
        on: { click: () => ctx.view('findings', issueId(issue)) },
      }));
    }

    const incident = graph.edges.filter(edge => edge.source === focus.id || edge.target === focus.id).length;
    const stats = el('div', { className: 'dep-stats' });
    for (const [name, value] of [
      ['Blast radius', radius.affected.length],
      ['Incident edges', incident],
      ['Imports', graph.dependencies(focus.id).length],
      ['Imported by', graph.dependents(focus.id).length],
    ]) {
      const stat = el('div', { className: 'dep-stat' });
      stat.append(el('span', { className: 'k', text: name }), el('strong', { className: 'v', text: number(value) }));
      stats.append(stat);
    }
    detail.append(stats);

    const select = id => activate(id);
    detail.append(listBlock('Imports', 'Nodes this node points at', graph.dependencies(focus.id), ctx, select));
    detail.append(listBlock('Imported by', 'Nodes that depend on this one', graph.dependents(focus.id), ctx, select));
    detail.append(listBlock(
      'Blast radius',
      `Reverse dependents — ${number(radius.direct.length)} direct · ${number(radius.transitive.length)} transitive`,
      radius.affected,
      ctx,
      select,
    ));

    if (radius.affected.length) {
      detail.append(el('button', {
        className: 'secondary',
        type: 'button',
        text: 'Show on map →',
        on: { click: () => { setState({ graphFocus: focus.id, dependencyFocus: null }); ctx.view('map'); } },
      }));
    }
  }
  side.append(detail);

  function activate(id) {
    if (focus && id === focus.id) {
      setState({ graphFocus: null, dependencyFocus: null });
    } else {
      setState({ graphFocus: id, dependencyFocus: null });
    }
  }

  search.addEventListener('input', () => {
    caret = search.selectionStart;
    setState({ dependencyQuery: search.value });
  });
  if (caret !== null) {
    search.focus();
    const position = Math.min(caret, search.value.length);
    search.setSelectionRange(position, position);
    caret = null;
  }
}
