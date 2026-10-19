/**
 * Dependencies — inline SVG graph + node inspector for the JS/TS import graph.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * The graph is plain SVG positioned by `lib/graph.js` layeredLayout: without a
 * focus, layers follow longest-path depth; with one, layers are reverse-BFS
 * distance ("blast radius"). Node kinds get distinct shapes — files are
 * circles, packages squares, unresolved specifiers triangles. Cycles are safe:
 * layout passes are capped in lib/graph.js, blastRadius tracks visited nodes,
 * and every render loop below is bounded.
 *
 * Zoom is applied through the SVG width/height attributes (never inline
 * styles) and survives re-renders via the canvas' data-zoom attribute.
 */

import { el, svg, emptyState } from '../lib/dom.js';
import { issueId, number, truncate } from '../lib/format.js';

const MAX_RENDERED = 300;
const MAX_LABELS = 60;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.25;
const CANVAS_WIDTH = 980;
const CANVAS_HEIGHT = 520;

// Caret position survives the re-render caused by typing in the filter.
let caret = null;

function clampZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, numeric));
}

// Zoom lives on the canvas element so re-renders (node clicks, filtering)
// keep the scale without module-level mutable state.
function zoomOf(container) {
  const canvas = container.querySelector('svg.deps-canvas');
  return canvas ? clampZoom(canvas.dataset.zoom) : 1;
}

function applyZoom(container, zoom) {
  const canvas = container.querySelector('svg.deps-canvas');
  if (!canvas) return;
  const next = clampZoom(zoom);
  const width = Number(canvas.dataset.width) || CANVAS_WIDTH;
  const height = Number(canvas.dataset.height) || CANVAS_HEIGHT;
  canvas.setAttribute('width', String(Math.round(width * next)));
  canvas.setAttribute('height', String(Math.round(height * next)));
  canvas.dataset.zoom = String(next);
  const range = container.querySelector('.deps-zoom-range');
  if (range) range.value = String(next);
  const label = container.querySelector('.deps-zoom-value');
  if (label) label.textContent = `${Math.round(next * 100)}%`;
}

/**
 * The focused node. Clicks set `graphFocus` (shared with Map); `dependencyFocus`
 * is still honoured because Findings and Map deep-link into this view with it.
 */
function resolveFocus(state, graph, lib) {
  const fromGraph = state.graphFocus && graph.has(state.graphFocus) ? lib.nodeId(state.graphFocus) : null;
  if (fromGraph) return { key: 'graphFocus', id: fromGraph };
  const fromDeps = state.dependencyFocus && graph.has(state.dependencyFocus) ? lib.nodeId(state.dependencyFocus) : null;
  if (fromDeps) return { key: 'dependencyFocus', id: fromDeps };
  return null;
}

/** Distinct shape per node kind: circle (file), square (package), triangle (unresolved). */
function nodeShape(kind, x, y, r) {
  if (kind === 'package') {
    const side = r * 1.9;
    return svg('rect', { class: `deps-shape ${kind}`, x: x - side / 2, y: y - side / 2, width: side, height: side, rx: 2 });
  }
  if (kind === 'unresolved') {
    const w = r * 1.1;
    return svg('polygon', { class: `deps-shape ${kind}`, points: `${x},${y - w} ${x + w},${y + w * 0.8} ${x - w},${y + w * 0.8}` });
  }
  return svg('circle', { class: `deps-shape ${kind}`, cx: x, cy: y, r });
}

/** Quadratic curve so bidirectional (cyclic) edges stay distinguishable. */
function edgePath(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const offset = Math.min(36, length * 0.18);
  const cx = (from.x + to.x) / 2 - (dy / length) * offset;
  const cy = (from.y + to.y) / 2 + (dx / length) * offset;
  return `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
}

function listBlock(title, subtitle, ids, ctx, onSelect) {
  const section = el('div', { className: 'deps-block' });
  section.append(el('h3', { text: title }), el('p', { text: subtitle, className: 'note' }));
  if (!ids.length) {
    section.append(el('p', { text: 'None', className: 'note' }));
    return section;
  }
  const list = el('ul', { className: 'deps-list' });
  for (const id of ids.slice(0, 100)) {
    const item = el('li');
    const button = el('button', {
      className: 'deps-link',
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
  if (ids.length > 100) {
    section.append(el('p', { text: `Showing 100 of ${number(ids.length)}. Export JSON for the full graph.`, className: 'note' }));
  }
  return section;
}

export function render(container, ctx) {
  const { state, setState } = ctx;
  const report = state.report;
  const raw = report?.graph;
  const zoom = zoomOf(container);
  container.replaceChildren();

  if (!report || !raw || !raw.nodes?.length) {
    emptyState(
      container,
      'No dependencies to inspect',
      'This report has no dependency graph. Run a full or structure scan to see dependencies.',
      '⇄',
    );
    return;
  }

  const graph = ctx.graph.buildGraph(raw);
  const focus = resolveFocus(state, graph, ctx.graph);
  const radius = focus ? ctx.graph.blastRadius(graph, focus.id) : null;

  const shell = el('section', { className: 'panel deps-panel' });
  const heading = el('div', { className: 'panel-heading' });
  const copy = el('div');
  copy.append(el('h2', { text: 'Dependencies' }), el('p', { text: 'Direct imports and importers for any node' }));
  heading.append(copy, el('span', { className: 'pill', text: `${number(graph.nodes.length)} nodes · ${number(graph.edges.length)} edges` }));
  shell.append(heading);

  if (report.scan?.partial || report.scan?.graph_partial) {
    shell.append(el('div', {
      className: 'deps-banner',
      text: 'Partial scan — coverage or graph information is incomplete. Open Coverage for the details.',
    }));
  }

  const controls = el('div', { className: 'deps-controls' });
  const search = el('input', {
    className: 'deps-search',
    value: state.dependencyQuery ?? '',
    attrs: { 'aria-label': 'Search nodes', placeholder: 'Filter by path, package or specifier…', autocomplete: 'off', spellcheck: 'false' },
  });
  const zoomGroup = el('div', { className: 'deps-zoom' });
  const zoomOut = el('button', {
    className: 'secondary',
    type: 'button',
    text: '−',
    attrs: { 'aria-label': 'Zoom out' },
    on: { click: () => applyZoom(container, zoomOf(container) / ZOOM_STEP) },
  });
  const range = el('input', {
    className: 'deps-zoom-range',
    attrs: { type: 'range', min: String(MIN_ZOOM), max: String(MAX_ZOOM), step: '0.1', value: String(zoom), 'aria-label': 'Zoom graph' },
  });
  range.addEventListener('input', () => applyZoom(container, Number(range.value)));
  const zoomIn = el('button', {
    className: 'secondary',
    type: 'button',
    text: '+',
    attrs: { 'aria-label': 'Zoom in' },
    on: { click: () => applyZoom(container, zoomOf(container) * ZOOM_STEP) },
  });
  const zoomValue = el('span', { className: 'deps-zoom-value', text: `${Math.round(zoom * 100)}%` });
  zoomGroup.append(zoomOut, range, zoomIn, zoomValue);
  controls.append(search, zoomGroup);
  if (focus) {
    controls.append(el('button', {
      className: 'secondary',
      type: 'button',
      text: 'Clear focus',
      on: { click: () => setState({ graphFocus: null, dependencyFocus: null }) },
    }));
  }
  shell.append(controls);

  const rendered = new Set(graph.nodes.slice(0, MAX_RENDERED));
  if (focus) rendered.add(focus.id);
  const visibleEdges = graph.edges.filter(edge => rendered.has(edge.source) && rendered.has(edge.target));
  const layout = ctx.graph.layeredLayout(graph, {
    focus: focus ? focus.id : null,
    nodes: [...rendered],
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  });

  const canvas = svg('svg', {
    class: 'deps-canvas',
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    width: Math.round(layout.width * zoom),
    height: Math.round(layout.height * zoom),
    role: 'img',
    'aria-label': `JS/TS dependency graph with ${graph.nodes.length} nodes`,
    'data-zoom': zoom,
    'data-width': layout.width,
    'data-height': layout.height,
  });
  const defs = svg('defs');
  for (const [id, hot] of [['deps-arrow', false], ['deps-arrow-hot', true]]) {
    const marker = svg('marker', {
      id,
      viewBox: '0 0 10 10',
      refX: 8,
      refY: 5,
      markerWidth: 6,
      markerHeight: 6,
      orient: 'auto',
    });
    marker.append(svg('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: hot ? 'deps-arrowhead hot' : 'deps-arrowhead' }));
    defs.append(marker);
  }
  const edgeLayer = svg('g', { class: 'deps-edges' });
  const nodeLayer = svg('g', { class: 'deps-nodes' });
  canvas.append(defs, edgeLayer, nodeLayer);

  const radiusSet = new Set(radius?.affected ?? []);
  const directSet = new Set(radius?.direct ?? []);
  const weightOf = id => Math.min(9, 4 + Math.sqrt((graph.incoming.get(id) ?? []).length) * 2);

  for (const edge of visibleEdges) {
    const from = layout.positions.get(edge.source);
    const to = layout.positions.get(edge.target);
    if (!from || !to) continue;
    const hot = Boolean(radius) && (edge.source === focus.id || edge.target === focus.id);
    const inRadius = Boolean(radius) && !hot && radiusSet.has(edge.source) && radiusSet.has(edge.target);
    const className = hot ? 'deps-edge hot' : inRadius ? 'deps-edge radius' : 'deps-edge';
    if (edge.source === edge.target) {
      const r = weightOf(edge.source);
      edgeLayer.append(svg('circle', { class: className, cx: from.x, cy: from.y - r * 2.1, r: Math.max(3, r * 0.5) }));
      continue;
    }
    edgeLayer.append(svg('path', {
      class: className,
      d: edgePath(from, to),
      'marker-end': hot ? 'url(#deps-arrow-hot)' : 'url(#deps-arrow)',
    }));
  }

  const labelled = radius
    ? new Set([focus.id, ...radius.direct, ...radius.affected])
    : new Set(ctx.graph.mostDependedOn(graph, 8).map(item => item.id));
  let labelBudget = MAX_LABELS;

  for (const id of rendered) {
    const position = layout.positions.get(id);
    if (!position) continue;
    const kind = ctx.graph.nodeKind(id);
    const r = weightOf(id);
    let className = 'deps-node';
    if (focus && id === focus.id) className += ' focus';
    else if (directSet.has(id)) className += ' direct';
    else if (radiusSet.has(id)) className += ' affected';
    else if (radius) className += ' dimmed';

    const group = svg('g', { class: className, tabindex: '0', role: 'button' });
    group.append(nodeShape(kind, position.x, position.y, r));
    group.append(svg('title', {}, `${id} — ${number((graph.incoming.get(id) ?? []).length)} dependents`));
    if (labelBudget > 0 && labelled.has(id)) {
      labelBudget -= 1;
      group.append(svg('text', {
        x: position.x,
        y: position.y + r + 12,
        class: 'deps-label',
        'text-anchor': 'middle',
      }, truncate(ctx.graph.nodeLabel(id), 26)));
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

  const scroll = el('div', { className: 'deps-canvas-scroll' });
  scroll.append(canvas);
  shell.append(scroll);

  const legend = el('div', { className: 'deps-legend' });
  for (const [kind, label] of [['file', 'file'], ['package', 'package'], ['unresolved', 'unresolved import']]) {
    const item = el('span', { className: 'deps-legend-item' });
    const swatch = svg('svg', { class: 'deps-legend-swatch', viewBox: '0 0 20 20', 'aria-hidden': 'true' });
    swatch.append(nodeShape(kind, 10, 10, 5.5));
    item.append(swatch, el('span', { text: label }));
    legend.append(item);
  }
  shell.append(legend);

  const body = el('div', { className: 'deps-body' });
  shell.append(body);

  const query = String(state.dependencyQuery ?? '').trim().toLowerCase();
  const matches = (query
    ? graph.nodes.filter(id => id.toLowerCase().includes(query))
    : graph.nodes).slice(0, 200);

  const index = el('div', { className: 'deps-index' });
  index.append(el('h3', { text: 'Nodes' }), el('p', { className: 'note', text: `${number(matches.length)} shown${query ? ` matching “${query}”` : ''}` }));
  const indexList = el('ul', { className: 'deps-list deps-index-list' });
  for (const id of matches) {
    const item = el('li');
    const button = el('button', {
      className: `deps-link${focus && id === focus.id ? ' selected' : ''}`,
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
  if (!matches.length) index.append(el('p', { text: 'No nodes match this filter.', className: 'note' }));
  else index.append(indexList);
  body.append(index);

  const detail = el('div', { className: 'deps-detail' });
  if (!focus) {
    detail.append(el('p', {
      className: 'note',
      text: 'Select a node in the graph or the index to see its imports, importers and blast radius.',
    }));
  } else {
    const header = el('div', { className: 'deps-focus' });
    header.append(
      el('span', { text: ctx.graph.nodeKind(focus.id), className: 'pill' }),
      el('strong', { text: ctx.graph.nodeLabel(focus.id), className: 'mono' }),
    );
    detail.append(header);

    const issue = ctx.graph.isFileNode(focus.id)
      ? (report.issues ?? []).find(item => `file:${item.file}` === focus.id)
      : null;
    if (issue) {
      detail.append(el('button', {
        className: 'secondary',
        type: 'button',
        text: `Open finding for ${issue.file}:${issue.line} →`,
        on: { click: () => ctx.view('findings', issueId(issue)) },
      }));
    }

    const facts = el('div', { className: 'deps-facts' });
    for (const [name, value] of [
      ['Direct dependents', radius.direct.length],
      ['Transitive dependents', radius.transitive.length],
      ['Blast radius', radius.affected.length],
    ]) {
      const fact = el('div');
      fact.append(el('strong', { text: number(value) }), el('span', { text: name }));
      facts.append(fact);
    }
    detail.append(facts);

    const select = id => activate(id);
    detail.append(listBlock('Imports', 'Nodes this node points at', graph.dependencies(focus.id), ctx, select));
    detail.append(listBlock('Imported by', 'Nodes that depend on this one', graph.dependents(focus.id), ctx, select));

    if (radius.affected.length) {
      detail.append(el('button', {
        className: 'secondary',
        type: 'button',
        text: 'Show on map →',
        on: { click: () => { setState({ graphFocus: focus.id, dependencyFocus: null }); ctx.view('map'); } },
      }));
    }
  }
  body.append(detail);
  container.append(shell);

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
