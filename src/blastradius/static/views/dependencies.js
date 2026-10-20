/**
 * Dependencies — full-bleed SVG import graph.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * Swiss port of preview.html's Dependencies view, reworked as a single
 * edge-to-edge graph: no side index, no inspector panel. Chrome is reduced to
 * two floating docks — tools (top) and legend + selected-node card (bottom) —
 * so the drawing itself owns the tab.
 *
 * Node kinds get distinct shapes — files are squares, packages are diamonds,
 * unresolved specifiers are triangles — drawn with 1px rule-strong strokes on
 * a node-fill surface. Severity colour appears only on fills that encode a
 * finding's severity (`.sev-high` / `.sev-medium` / `.sev-low`).
 *
 * Edges are smooth cubic Bézier S-curves (x-dominant, or y-dominant when the
 * edge reads more vertically) with arrowheads; edges incident to the focus
 * node or inside its blast radius render in --fg, everything else dims.
 * Reciprocal A→B / B→A pairs are pushed apart perpendicularly so two wires
 * never sit on top of each other.
 *
 * Labels are a budgeted, collision-aware resource: at most MAX_LABELS are
 * placed, greedily, by priority (focus, search matches, most-depended-on, the
 * rest) and any label whose estimated box would overlap a placed one is
 * skipped. Every node keeps its full id in a <title> for hover.
 *
 * Layout can be read left→right (default) or top→down: the top→down view is
 * the same layered layout with its axes swapped, which the vertical branch of
 * `edgePath()` already routes. The choice is persisted on the container
 * (`dataset.depOrient`), like zoom/pan are persisted on the SVG.
 *
 * Keyboard: nodes use a roving tabindex (one tab stop). Arrow keys walk the
 * graph in reading order, Enter/Space activates, Home/End jump to the ends.
 * In the filter field, Enter / Shift+Enter cycle matches and Escape clears.
 *
 * Cycles are safe: layout passes are capped in lib/graph.js, blastRadius tracks
 * visited nodes, and every render loop below is bounded.
 *
 * The SVG always fills the stage (100% × 100%); zoom is a transform on the
 * `.dep-zoom-layer` group, so the drawing scales without changing the element
 * box. Zoom/pan survive re-renders via the canvas' data attributes.
 */

import { el, svg, emptyState } from '../lib/dom.js';
import { SEVERITIES, number, plural, severityRank, truncate } from '../lib/format.js';

const MAX_RENDERED = 300;
const MAX_LABELS = 60;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.25;
const MIN_STAGE_WIDTH = 560;
const MIN_STAGE_HEIGHT = 480;

const FALLBACK_WIDTH = 1142;
const FALLBACK_HEIGHT = 776;

// Room for the node grid: a uniform gutter plus insets that keep the outer
// rows clear of the tools dock (top) and the legend/card dock (bottom).
const PAD = 52;
const TOP_INSET = 64;
const BOTTOM_INSET = 52;

// Edge start/end padding per node kind, so lines meet shape borders.
const KIND_PAD = { file: 14, package: 20, unresolved: 18 };

// Label boxes are estimated, not measured: each label is one monospace line.
const LABEL_CHAR = 6.5;
const LABEL_HEIGHT = 11;
const LABEL_GAP = 2;
const LABEL_MAX_CHARS = 26;

// Reciprocal edge pairs are pushed apart perpendicularly, in user units.
const RECIPROCAL_OFFSET = 7;

// Pointer travel (px) below which a press on the background counts as a click.
const CLICK_SLOP = 4;

function clampZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, numeric));
}

function round(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** `lr` (default) or `td`; persisted on the view container, not in a module. */
function orientationOf(container) {
  return container.dataset.depOrient === 'td' ? 'td' : 'lr';
}

/**
 * Zoom/pan state lives on the SVG element so re-renders (node clicks,
 * filtering) keep the view without module-level mutable state.
 */
function transformOf(container) {
  const canvas = container.querySelector('svg.dep-svg');
  if (!canvas) {
    return { zoom: 1, panX: 0, panY: 0, width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT };
  }
  return {
    zoom: clampZoom(canvas.dataset.zoom),
    panX: Number(canvas.dataset.panx) || 0,
    panY: Number(canvas.dataset.pany) || 0,
    width: Number(canvas.dataset.width) || FALLBACK_WIDTH,
    height: Number(canvas.dataset.height) || FALLBACK_HEIGHT,
  };
}

/** translate(tx ty) scale(z), anchored on the stage centre plus the pan. */
function layerTransform(state) {
  const { zoom, panX, panY, width, height } = state;
  const tx = (width / 2) * (1 - zoom) + panX;
  const ty = (height / 2) * (1 - zoom) + panY;
  return `translate(${round(tx)} ${round(ty)}) scale(${round(zoom)})`;
}

/** Pan is bounded so the drawing can never be dragged clear of the stage. */
function clampPan(state) {
  const { zoom, width, height } = state;
  const limitX = Math.max(0, (width * zoom - width) / 2);
  const limitY = Math.max(0, (height * zoom - height) / 2);
  return {
    ...state,
    panX: Math.max(-limitX, Math.min(limitX, Number(state.panX) || 0)),
    panY: Math.max(-limitY, Math.min(limitY, Number(state.panY) || 0)),
  };
}

function applyTransform(container, patch) {
  const canvas = container.querySelector('svg.dep-svg');
  const layer = container.querySelector('.dep-zoom-layer');
  if (!canvas) return;
  const current = transformOf(container);
  const next = clampPan({
    ...current,
    ...patch,
    zoom: clampZoom(patch.zoom ?? current.zoom),
  });
  canvas.dataset.zoom = String(next.zoom);
  canvas.dataset.panx = String(round(next.panX));
  canvas.dataset.pany = String(round(next.panY));
  if (layer) layer.setAttribute('transform', layerTransform(next));
  const label = container.querySelector('.dep-zoom-value');
  if (label) label.textContent = `${Math.round(next.zoom * 100)}%`;
}

/** Scale about the stage centre while keeping the panned centre in place. */
function zoomTo(container, nextZoom) {
  const current = transformOf(container);
  const zoom = clampZoom(nextZoom);
  const ratio = zoom / current.zoom;
  applyTransform(container, {
    zoom,
    panX: current.panX * ratio,
    panY: current.panY * ratio,
  });
}

/**
 * Convert a pointer position to viewBox user units. `preserveAspectRatio`
 * centres the drawing, so the letterbox offset is part of the mapping.
 */
function canvasPoint(canvas, width, height, clientX, clientY) {
  const box = canvas.getBoundingClientRect();
  const scale = Math.min(box.width / width, box.height / height) || 1;
  return {
    x: (clientX - box.left - (box.width - width * scale) / 2) / scale,
    y: (clientY - box.top - (box.height - height * scale) / 2) / scale,
  };
}

/**
 * Scale about the pointer: the user-space point under the cursor stays under
 * the cursor after the zoom, so the wheel zooms where the eye is.
 */
function zoomAtPoint(container, factor, clientX, clientY) {
  const canvas = container.querySelector('svg.dep-svg');
  if (!canvas) return;
  const current = transformOf(container);
  const zoom = clampZoom(current.zoom * factor);
  if (zoom === current.zoom) return;

  const point = canvasPoint(canvas, current.width, current.height, clientX, clientY);
  const tx = (current.width / 2) * (1 - current.zoom) + current.panX;
  const ty = (current.height / 2) * (1 - current.zoom) + current.panY;
  const userX = (point.x - tx) / current.zoom;
  const userY = (point.y - ty) / current.zoom;

  applyTransform(container, {
    zoom,
    panX: point.x - userX * zoom - (current.width / 2) * (1 - zoom),
    panY: point.y - userY * zoom - (current.height / 2) * (1 - zoom),
  });
}

/** Fit: 100% and centred. */
function fitView(container) {
  applyTransform(container, { zoom: 1, panX: 0, panY: 0 });
}

function stageBox(container) {
  const box = container.getBoundingClientRect();
  const width = Math.max(
    MIN_STAGE_WIDTH,
    Math.round(box.width) > 0 ? Math.round(box.width) - 2 : FALLBACK_WIDTH,
  );
  // Measure from the real top of the view: on #dependencies the shell chrome is
  // hidden, so this is just the top bar plus padding and the graph fills the tab.
  const top = Math.max(0, Math.round(box.top));
  const height = Math.max(MIN_STAGE_HEIGHT, Math.round(window.innerHeight) - top - 24) - 2;
  return { width, height };
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

/**
 * Smooth cubic Bézier S-curve. Horizontal when the layers read side by side
 * (the layered layout's normal case); vertical when the edge is clearly more
 * vertical than horizontal, so stacked nodes do not get a flat, kinked wire.
 * The top→down layout relies on the vertical branch.
 */
function edgePath(from, to) {
  const startPad = KIND_PAD[from.kind] ?? 14;
  const endPad = KIND_PAD[to.kind] ?? 14;
  const dxRaw = to.x - from.x;
  const dyRaw = to.y - from.y;

  if (Math.abs(dyRaw) > Math.abs(dxRaw) * 1.5) {
    const dir = dyRaw >= 0 ? 1 : -1;
    const sy = from.y + dir * startPad;
    const ey = to.y - dir * endPad;
    const dy = Math.max(40, Math.abs(ey - sy) * 0.45);
    return `M ${from.x} ${sy} C ${from.x} ${sy + dir * dy}, ${to.x} ${ey - dir * dy}, ${to.x} ${ey}`;
  }

  const dir = dxRaw >= 0 ? 1 : -1;
  const sx = from.x + dir * startPad;
  const ex = to.x - dir * endPad;
  const dx = Math.max(40, Math.abs(ex - sx) * 0.45);
  return `M ${sx} ${from.y} C ${sx + dir * dx} ${from.y}, ${ex - dir * dx} ${to.y}, ${ex} ${to.y}`;
}

/** A node that depends on itself gets a small loop above the shape. */
function selfLoopPath(position) {
  const { x, y } = position;
  return `M ${x + 7} ${y - 12} C ${x + 40} ${y - 46}, ${x - 40} ${y - 46}, ${x - 7} ${y - 12}`;
}

/** Legend swatch for each node kind, drawn with the live text colour. */
function legendShape(kind) {
  const swatch = svg('svg', { class: 'dep-legend-shape', viewBox: '0 0 14 14', 'aria-hidden': 'true' });
  const path = kind === 'file'
    ? svg('rect', { x: 2.5, y: 2.5, width: 9, height: 9 })
    : svg('path', { d: kind === 'package' ? 'M7 1.5 12.5 7 7 12.5 1.5 7Z' : 'M7 2 13 12H1Z' });
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  swatch.append(path);
  return swatch;
}

function legendItem(kind, label) {
  const item = el('span', { className: 'dep-legend-item' });
  item.append(legendShape(kind), el('span', { text: label }));
  return item;
}

/** Text-only legend entry (edge direction). */
function legendArrow(label) {
  const item = el('span', { className: 'dep-legend-item dep-legend-arrow' });
  item.append(
    el('span', { className: 'dep-legend-glyph', text: '→', attrs: { 'aria-hidden': 'true' } }),
    el('span', { text: label }),
  );
  return item;
}

/** Estimated label box (one line, centred on x, baseline y + 32). */
function labelAnchorX(position, value, width) {
  const half = Math.max(10, String(value).length * LABEL_CHAR) / 2;
  // Keep labels of the outermost columns inside the canvas instead of clipping.
  return Math.min(width - half - 4, Math.max(half + 4, position.x));
}

function labelBox(position, value, width) {
  const boxWidth = Math.max(10, String(value).length * LABEL_CHAR);
  const centerX = labelAnchorX(position, value, width);
  const centerY = position.y + 32 - 4.5;
  return {
    left: centerX - boxWidth / 2,
    right: centerX + boxWidth / 2,
    top: centerY - LABEL_HEIGHT / 2,
    bottom: centerY + LABEL_HEIGHT / 2,
  };
}

function boxesOverlap(a, b) {
  return (
    a.left < b.right + LABEL_GAP
    && a.right > b.left - LABEL_GAP
    && a.top < b.bottom + LABEL_GAP
    && a.bottom > b.top - LABEL_GAP
  );
}

/** Download the current report as JSON (same Blob/anchor pattern as the shell). */
function exportReport(report, notify) {
  const scanId = report?.scan?.id;
  if (!scanId) {
    notify('Nothing to export yet.');
    return;
  }
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }));
  const link = el('a');
  link.href = url;
  link.download = `blastradius-${scanId}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`Exported blastradius-${scanId}.json`);
}

export function render(container, ctx) {
  const { state, setState } = ctx;
  const report = state.report;
  const raw = report?.graph;
  const previous = transformOf(container);
  const orientation = orientationOf(container);
  // The filter is re-created on every render; remember whether it owned focus
  // (and where the caret was) before the old DOM is discarded.
  const activeElement = document.activeElement;
  const restoreFilter = activeElement && activeElement.classList?.contains('dep-search')
    ? { start: activeElement.selectionStart, end: activeElement.selectionEnd }
    : null;
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
  const summary = ctx.graph.graphSummary(graph);
  const { width, height } = stageBox(container);

  const query = String(state.dependencyQuery ?? '').trim().toLowerCase();
  const matches = query
    ? new Set(graph.nodes.filter(id => id.toLowerCase().includes(query)))
    : null;

  const layout = el('div', { className: 'dep-layout' });
  const shell = el('section', { className: 'panel dep-panel' });
  const stage = el('div', { className: 'dep-stage' });

  // ---------------------------------------------------------------- overlays

  const chrome = el('div', { className: 'dep-overlay dep-overlay--tools' });

  const titleRow = el('div', { className: 'dep-chrome-head' });
  titleRow.append(
    el('h2', { className: 'dep-chrome-title', text: 'Dependency graph' }),
    el('span', {
      className: 'dep-chrome-counts',
      text: [
        `${number(summary.files)} ${plural(summary.files, 'FILE')}`,
        `${number(summary.edges)} ${plural(summary.edges, 'EDGE')}`,
        `${number(summary.packages)} ${plural(summary.packages, 'PACKAGE')}`,
      ].join(' · '),
    }),
  );

  const controls = el('div', { className: 'dep-chrome-controls' });
  const search = el('input', {
    className: 'dep-search',
    value: state.dependencyQuery ?? '',
    attrs: {
      type: 'search',
      'aria-label': 'Filter graph nodes',
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
      on: { click: () => zoomTo(container, transformOf(container).zoom / ZOOM_STEP) },
    }),
    el('span', { className: 'dep-zoom-value', text: `${Math.round(previous.zoom * 100)}%` }),
    el('button', {
      className: 'dep-zoom-btn',
      type: 'button',
      text: '+',
      attrs: { 'aria-label': 'Zoom in' },
      on: { click: () => zoomTo(container, transformOf(container).zoom * ZOOM_STEP) },
    }),
  );

  const controlsTail = el('div', { className: 'dep-chrome-tail' });
  controlsTail.append(
    el('button', {
      className: 'dep-action dep-orientation',
      type: 'button',
      text: orientation === 'lr' ? '↔ L→R' : '↕ T→D',
      attrs: {
        'aria-label': orientation === 'lr'
          ? 'Layout: left to right. Switch to top down.'
          : 'Layout: top down. Switch to left to right.',
        title: orientation === 'lr' ? 'Switch to top→down' : 'Switch to left→right',
        'data-orientation': orientation,
      },
      on: {
        click: () => {
          container.dataset.depOrient = orientation === 'lr' ? 'td' : 'lr';
          render(container, ctx);
        },
      },
    }),
    el('button', {
      className: 'dep-action',
      type: 'button',
      text: 'Fit',
      attrs: { 'aria-label': 'Fit graph to view' },
      on: { click: () => fitView(container) },
    }),
    el('button', {
      className: 'dep-action',
      type: 'button',
      text: 'Scan',
      attrs: { 'aria-label': 'Run scan' },
      on: { click: () => document.getElementById('scan-form')?.requestSubmit() },
    }),
    el('button', {
      className: 'dep-action',
      type: 'button',
      text: 'Export JSON',
      attrs: { 'aria-label': 'Export report as JSON' },
      on: { click: () => exportReport(report, ctx.notify) },
    }),
  );
  if (focus) {
    controlsTail.append(el('button', {
      className: 'dep-action',
      type: 'button',
      text: 'Clear focus',
      attrs: { 'aria-label': 'Clear node focus' },
      on: { click: () => setState({ graphFocus: null, dependencyFocus: null }) },
    }));
  }
  controls.append(search);
  if (query) {
    controls.append(el('span', {
      className: 'dep-hint',
      text: `${number(matches.size)} / ${number(graph.nodes.length)} match`,
      attrs: { role: 'status' },
    }));
  }
  controls.append(el('span', { className: 'dep-spacer' }), zoomGroup, controlsTail);
  chrome.append(titleRow, controls);

  if (report.scan?.partial || report.scan?.graph_partial) {
    const banner = el('div', { className: 'dep-banner' });
    banner.append(
      el('strong', { text: 'Partial scan' }),
      el('span', { text: 'Coverage or graph information is incomplete; the blast radius may be smaller than reality.' }),
      el('button', {
        className: 'dep-action',
        type: 'button',
        text: 'Open Coverage',
        on: { click: () => ctx.view('coverage') },
      }),
    );
    chrome.append(banner);
  }

  const legend = el('div', {
    className: 'dep-overlay dep-overlay--legend dep-legend',
    attrs: { role: 'note', 'aria-label': 'Graph legend' },
  });
  legend.append(
    legendItem('file', 'File'),
    legendItem('package', 'Package'),
    legendItem('unresolved', 'Unresolved'),
    legendArrow('imports'),
  );
  for (const severity of ['high', 'medium', 'low']) {
    const item = el('span', { className: 'dep-legend-item' });
    item.append(
      el('span', { className: `sev-swatch sev-${severity}` }),
      el('span', { text: severity }),
    );
    legend.append(item);
  }

  // ------------------------------------------------------- selected-node card

  const card = focus ? el('aside', {
    className: 'dep-overlay dep-overlay--focus',
    attrs: { 'aria-label': 'Selected node' },
  }) : null;
  if (card) {
    const cardHead = el('div', { className: 'dep-focus-head' });
    cardHead.append(
      el('span', { className: 'dep-focus-kind', text: ctx.graph.nodeKind(focus.id) }),
      el('button', {
        className: 'dep-focus-clear',
        type: 'button',
        text: 'Clear',
        attrs: { 'aria-label': 'Clear node focus' },
        on: { click: () => setState({ graphFocus: null, dependencyFocus: null }) },
      }),
    );
    card.append(cardHead);
    card.append(el('strong', {
      className: 'dep-focus-id mono',
      text: truncate(ctx.graph.nodeLabel(focus.id), 64),
    }));
    const stats = el('div', { className: 'dep-focus-stats' });
    for (const [name, value] of [
      ['Blast radius', radius?.affected.length ?? 0],
      ['Imports', graph.dependencies(focus.id).length],
      ['Imported by', graph.dependents(focus.id).length],
    ]) {
      const stat = el('div', { className: 'dep-focus-stat' });
      stat.append(
        el('span', { className: 'k', text: name }),
        el('span', { className: 'v', text: number(value) }),
      );
      stats.append(stat);
    }
    card.append(stats);
  }

  // Top dock: tools, plus the truncation note when the graph exceeds the cap.
  const topDock = el('div', { className: 'dep-top' });
  topDock.append(chrome);
  if (graph.nodes.length > MAX_RENDERED) {
    topDock.append(el('button', {
      className: 'dep-overlay dep-overlay--cap dep-cap',
      type: 'button',
      text: `Showing ${MAX_RENDERED} of ${number(graph.nodes.length)} nodes — filter to narrow`,
      attrs: { 'aria-label': `Showing ${MAX_RENDERED} of ${number(graph.nodes.length)} nodes. Focus the filter to narrow the graph.` },
      on: {
        click: () => {
          search.focus();
          search.select();
        },
      },
    }));
  }

  // Bottom dock: legend and focus card share one row (one column when narrow).
  const dock = el('div', { className: 'dep-dock' });
  dock.append(legend);
  if (card) dock.append(card);

  // Paint the chrome first so its measured height can reserve space for the
  // first node layer; the SVG is inserted underneath it at the end.
  stage.append(topDock, dock);
  shell.append(stage);
  layout.append(shell);
  container.append(layout);

  const dockHeight = Math.round(topDock.getBoundingClientRect().height);
  const topReserve = Math.max(TOP_INSET, dockHeight + 24);

  // ----------------------------------------------------------------- encoding

  const rendered = new Set(graph.nodes.slice(0, MAX_RENDERED));
  if (focus) rendered.add(focus.id);
  const visibleEdges = graph.edges.filter(edge => rendered.has(edge.source) && rendered.has(edge.target));
  const kinds = new Map([...rendered].map(id => [id, ctx.graph.nodeKind(id)]));

  // Reciprocal edges are detected once, from the full edge set, then each pair
  // is offset perpendicularly at draw time.
  const edgeKeys = new Set(graph.edges.map(edge => `${edge.source}\u0000${edge.target}`));
  const isReciprocal = (source, target) => (
    source !== target && edgeKeys.has(`${target}\u0000${source}`)
  );

  const availableHeight = Math.max(240, height - topReserve - BOTTOM_INSET);
  const sideInset = Math.min((LABEL_CHAR * LABEL_MAX_CHARS) / 2 + 8, width * 0.16);
  const graphLayout = ctx.graph.layeredLayout(graph, {
    focus: focus ? focus.id : null,
    nodes: [...rendered],
    width: orientation === 'td' ? availableHeight : width,
    height: orientation === 'td' ? width : availableHeight,
    padding: PAD,
  });
  for (const position of graphLayout.positions.values()) {
    if (orientation === 'td') {
      const x = position.y;
      position.y = position.x;
      position.x = x;
    }
    // Keep the outermost columns far enough in for centred labels to fit.
    position.x = Math.min(width - sideInset, Math.max(sideInset, position.x));
    position.y += topReserve;
  }

  // ------------------------------------------------------------------- canvas

  const canvas = svg('svg', {
    class: 'dep-svg',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'group',
    'aria-label': `Dependency graph with ${number(graph.nodes.length)} nodes and ${number(graph.edges.length)} edges`,
    'data-zoom': previous.zoom,
    'data-panx': previous.panX,
    'data-pany': previous.panY,
    'data-width': width,
    'data-height': height,
    'data-orientation': orientation,
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

  const zoomLayer = svg('g', {
    class: 'dep-zoom-layer',
    transform: layerTransform({ ...previous, width, height }),
  });
  const edgeLayer = svg('g', { class: 'dep-edges' });
  const nodeLayer = svg('g', { class: 'dep-nodes' });
  zoomLayer.append(edgeLayer, nodeLayer);
  canvas.append(defs, zoomLayer);
  stage.insertBefore(canvas, topDock);

  const active = new Set(focus ? [focus.id, ...(radius?.affected ?? [])] : []);

  for (const edge of visibleEdges) {
    const from = graphLayout.positions.get(edge.source);
    const to = graphLayout.positions.get(edge.target);
    if (!from || !to) continue;
    const incident = Boolean(radius) && (edge.source === focus.id || edge.target === focus.id);
    const within = Boolean(radius) && !incident && active.has(edge.source) && active.has(edge.target);
    const hot = incident || within;
    let className = hot ? 'dep-edge is-impact' : 'dep-edge is-dim';
    if (matches && (!matches.has(edge.source) || !matches.has(edge.target))) {
      className += ' is-filtered';
    }
    const marker = hot ? 'url(#dep-arrow-hot)' : 'url(#dep-arrow)';
    if (edge.source === edge.target) {
      edgeLayer.append(svg('path', {
        class: className,
        d: selfLoopPath(from),
        'marker-end': marker,
      }));
      continue;
    }

    let start = { x: from.x, y: from.y, kind: kinds.get(edge.source) ?? 'file' };
    let end = { x: to.x, y: to.y, kind: kinds.get(edge.target) ?? 'file' };
    if (isReciprocal(edge.source, edge.target)) {
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const length = Math.hypot(dx, dy) || 1;
      // Opposite directions produce opposite perpendiculars, so the two wires
      // of a reciprocal pair land on either side of the straight line.
      const ox = (-dy / length) * RECIPROCAL_OFFSET;
      const oy = (dx / length) * RECIPROCAL_OFFSET;
      start = { ...start, x: from.x + ox, y: from.y + oy };
      end = { ...end, x: to.x + ox, y: to.y + oy };
    }
    edgeLayer.append(svg('path', {
      class: className,
      d: edgePath(start, end),
      'marker-end': marker,
    }));
  }

  // Labels are a budgeted resource. Candidates are ordered by priority — focus,
  // search matches, most-depended-on, everything else — and each label is
  // placed only if its estimated box does not collide with one already placed.
  const labelCandidates = [];
  const seen = new Set();
  const candidate = id => {
    if (!id || seen.has(id) || !rendered.has(id)) return;
    seen.add(id);
    labelCandidates.push(id);
  };
  if (focus) candidate(focus.id);
  if (matches) {
    for (const id of matches) candidate(id);
  }
  for (const item of ctx.graph.mostDependedOn(graph, graph.nodes.length)) candidate(item.id);
  for (const id of rendered) candidate(id);

  const labelled = new Set();
  const placedBoxes = [];
  for (const id of labelCandidates) {
    if (labelled.size >= MAX_LABELS) break;
    const position = graphLayout.positions.get(id);
    if (!position) continue;
    const text = truncate(ctx.graph.nodeLabel(id), LABEL_MAX_CHARS);
    const box = labelBox(position, text, width);
    if (placedBoxes.some(other => boxesOverlap(box, other))) continue;
    placedBoxes.push(box);
    labelled.add(id);
  }

  // Reading order follows the drawing: left→right then top→bottom, or the
  // transpose when the layout is top→down. Keyboard traversal uses this order.
  const ordered = [...rendered].sort((left, right) => {
    const a = graphLayout.positions.get(left);
    const b = graphLayout.positions.get(right);
    if (!a || !b) return left.localeCompare(right);
    return orientation === 'td'
      ? (a.y - b.y) || (a.x - b.x) || left.localeCompare(right)
      : (a.x - b.x) || (a.y - b.y) || left.localeCompare(right);
  });
  const tabbable = focus && rendered.has(focus.id) ? focus.id : ordered[0] ?? null;
  const nodeElements = new Map();

  for (const id of ordered) {
    const position = graphLayout.positions.get(id);
    if (!position) continue;
    const kind = kinds.get(id) ?? ctx.graph.nodeKind(id);
    let className = 'dep-node';
    if (focus && id === focus.id) className += ' is-selected';
    else if (active.has(id)) className += ' is-impact';
    else if (focus) className += ' is-dim';
    if (matches && !matches.has(id)) className += ' is-filtered';

    const group = svg('g', {
      class: className,
      tabindex: id === tabbable ? '0' : '-1',
      role: 'button',
      'aria-label': `${kind} ${ctx.graph.nodeLabel(id)}`,
    });
    group.append(nodeShape(kind, position.x, position.y, severityOf.get(id) ?? null));
    // Attribution: the full namespaced id is always available on hover, even
    // when the visible label was skipped for collision reasons.
    group.append(svg('title', {}, `${id} — ${number((graph.incoming.get(id) ?? []).length)} dependents`));
    if (labelled.has(id)) {
      const label = truncate(ctx.graph.nodeLabel(id), LABEL_MAX_CHARS);
      const anchorX = labelAnchorX(position, label, width);
      group.append(svg('text', {
        x: anchorX,
        y: position.y + 32,
        class: 'dep-label',
        'text-anchor': 'middle',
      }, label));
      group.append(svg('text', {
        x: anchorX,
        y: position.y + 43,
        class: 'dep-type',
        'text-anchor': 'middle',
      }, kind.toUpperCase()));
    }
    group.addEventListener('click', () => activate(id));
    group.addEventListener('keydown', event => {
      handleNodeKey(event, ordered.indexOf(id));
    });
    nodeElements.set(id, group);
    nodeLayer.append(group);
  }

  /** Roving tabindex: exactly one node is reachable with Tab at a time. */
  function focusNode(index) {
    if (!ordered.length) return;
    const next = Math.max(0, Math.min(ordered.length - 1, index));
    const targetId = ordered[next];
    const target = nodeElements.get(targetId);
    if (!target) return;
    for (const [nodeId, element] of nodeElements) {
      element.setAttribute('tabindex', nodeId === targetId ? '0' : '-1');
    }
    target.focus();
  }

  function handleNodeKey(event, index) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        focusNode(index - 1);
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        focusNode(index + 1);
        break;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        focusNode(0);
        break;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        focusNode(ordered.length - 1);
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat) return;
        activate(ordered[index]);
        break;
      default:
        break;
    }
  }

  // Drag-to-pan: the background (not a node) moves the zoom layer. The
  // pointer delta is converted to user units through the viewBox scale.
  let drag = null;
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    if (event.target?.closest?.('.dep-node')) return;
    const box = canvas.getBoundingClientRect();
    const scale = Math.min(box.width / width, box.height / height) || 1;
    const current = transformOf(container);
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: current.panX,
      panY: current.panY,
      scale,
      moved: false,
    };
    canvas.setPointerCapture?.(event.pointerId);
    canvas.classList.add('is-panning');
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    if (Math.abs(event.clientX - drag.x) > CLICK_SLOP || Math.abs(event.clientY - drag.y) > CLICK_SLOP) {
      drag.moved = true;
    }
    applyTransform(container, {
      panX: drag.panX + (event.clientX - drag.x) / drag.scale,
      panY: drag.panY + (event.clientY - drag.y) / drag.scale,
    });
  });
  const endDrag = event => {
    if (!drag) return;
    if (event.pointerId !== undefined && event.pointerId !== drag.id) return;
    const wasClick = !drag.moved;
    drag = null;
    canvas.classList.remove('is-panning');
    // A click on the background — not the end of a drag — clears the focus.
    if (wasClick && focus) setState({ graphFocus: null, dependencyFocus: null });
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  // Wheel zoom is anchored at the pointer; the −/%/+ buttons stay centred.
  canvas.addEventListener('wheel', event => {
    if (!event.deltaY) return;
    event.preventDefault();
    zoomAtPoint(
      container,
      event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
      event.clientX,
      event.clientY,
    );
  }, { passive: false });

  // --------------------------------------------------------------- actions

  function activate(id) {
    if (focus && id === focus.id) {
      setState({ graphFocus: null, dependencyFocus: null });
    } else {
      setState({ graphFocus: id, dependencyFocus: null });
    }
  }

  /** Enter / Shift+Enter step through the matches, wrapping at both ends. */
  function cycleMatch(direction) {
    if (!matches || matches.size === 0) return;
    const ids = [...matches];
    const index = focus ? ids.indexOf(focus.id) : -1;
    const next = index === -1
      ? (direction > 0 ? 0 : ids.length - 1)
      : (index + direction + ids.length) % ids.length;
    setState({ graphFocus: ids[next], dependencyFocus: null });
  }

  search.addEventListener('input', () => {
    setState({ dependencyQuery: search.value });
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!search.value) return;
      setState({ dependencyQuery: '' });
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    event.stopPropagation();
    cycleMatch(event.shiftKey ? -1 : 1);
  });
  if (restoreFilter) {
    search.focus();
    const length = search.value.length;
    const start = Math.min(Number.isFinite(restoreFilter.start) ? restoreFilter.start : length, length);
    const end = Math.min(Number.isFinite(restoreFilter.end) ? restoreFilter.end : length, length);
    search.setSelectionRange(start, Math.max(start, end));
  }
}
