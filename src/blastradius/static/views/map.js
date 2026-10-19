/**
 * Map — tidy node-link tree of the scanned filesystem.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * Ported from the approved Swiss-map preview (preview.html): the real report's
 * scan coverage lists (`checked_files`, `not_checked_files`, `excluded_files`,
 * `skipped_files`) and `report.issues` are folded into a directory→file tree,
 * laid out as a tidy tree (leaves in sequence, parents centred) and painted in
 * inline SVG. Three orientations — top-down, left-right and radial — share one
 * layout engine; linear orientations use orthogonal elbow connectors and the
 * radial layout uses quadratic arcs.
 *
 * Folders are 1px rectangles, files are 1px circles. Severity colour appears
 * only as a file's fill (or a badge); unchecked / excluded / skipped files are
 * dashed and muted. Folders can be collapsed, files can be selected to inspect
 * their issues, imports, importers and reverse blast radius in the side panel.
 *
 * Selection is the namespaced file node id (`file:<path>`) stored in
 * `state.graphFocus`, so deep links and re-renders agree. Transient UI state
 * (collapse set, orientation, zoom, search) lives in a module-level record of
 * plain data only — never DOM nodes — and is reset when the report changes.
 */

import { el, emptyState, svg } from '../lib/dom.js';
import { issueId, number } from '../lib/format.js';

const FOLDER_W = 120;
const FOLDER_H = 32;
const FILE_R = 9;
const LEAF_GAP_TD = 112;
const LEVEL_GAP_TD = 112;
const LEAF_GAP_LR = 56;
const LEVEL_GAP_LR = 196;
const RADIAL_STEP = 172;
const INITIAL_COLLAPSE_DEPTH = 3;
const MAX_MATCHES = 250;
const EDGE_LIMIT = 100;
const AFFECTED_LIMIT = 20;
const MIN_VIEW_W = 320;
const MIN_VIEW_H = 240;

const INACTIVE = new Set(['unchecked', 'excluded', 'skipped']);

const STATUS_LABEL = {
  checked: 'Checked',
  unchecked: 'Unchecked',
  excluded: 'Excluded',
  skipped: 'Skipped',
  issueOnly: 'Issue reference',
};

const ui = {
  reportId: null,
  seeded: false,
  collapsed: new Set(),
  orientation: 'td',
  zoom: 1,
  query: '',
  matches: [],
  matchIndex: 0,
  selected: null,
  hovered: null,
  rootPath: '',
  lastFocus: null,
  pendingFocus: null,
  baseView: null,
};

/* --------------------------------------------------------------- utilities */

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parentDir(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function ancestorPaths(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  const chain = [''];
  for (let index = 1; index <= parts.length; index += 1) {
    chain.push(parts.slice(0, index).join('/'));
  }
  return chain;
}

function truncateLabel(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function extensionOf(name) {
  const parts = String(name ?? '').split('.');
  return parts.length > 1 ? parts.pop().toUpperCase() : 'NO EXT';
}

function syncReport(report) {
  const id = report?.scan?.id ?? null;
  if (ui.reportId === id) return;
  ui.reportId = id;
  ui.seeded = false;
  ui.collapsed = new Set();
  ui.orientation = 'td';
  ui.zoom = 1;
  ui.query = '';
  ui.matches = [];
  ui.matchIndex = 0;
  ui.selected = null;
  ui.hovered = null;
  ui.rootPath = '';
  ui.lastFocus = null;
  ui.pendingFocus = null;
  ui.baseView = null;
}

function seedCollapsed(treeRoot) {
  ui.collapsed = new Set();
  const visit = (node, depth) => {
    if (node.kind === 'directory' && depth >= INITIAL_COLLAPSE_DEPTH && (node.children?.length ?? 0)) {
      ui.collapsed.add(node.path);
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(treeRoot, 0);
}

function revealPath(path) {
  const parts = String(path ?? '').split('/').filter(Boolean);
  for (let index = 1; index < parts.length; index += 1) {
    ui.collapsed.delete(parts.slice(0, index).join('/'));
  }
}

/* ------------------------------------------------------------ layout engine */

function buildVisibleNode(source, parent, depth, rootSource, collapsed) {
  const isRoot = source.path === rootSource.path;
  const node = {
    source,
    parent,
    depth,
    path: source.path,
    name: source.name,
    kind: source.kind,
    children: [],
    fileCount: source.counts?.files ?? (source.kind === 'file' ? 1 : 0),
    issueCount: source.counts?.issues ?? (source.issues?.length ?? 0),
    maxSeverity: source.maxSeverity ?? null,
    status: source.status ?? null,
    issues: source.issues ?? [],
  };
  if (source.kind === 'directory' && (isRoot || !collapsed.has(source.path))) {
    for (const child of source.children ?? []) {
      node.children.push(buildVisibleNode(child, node, depth + 1, rootSource, collapsed));
    }
  }
  return node;
}

function layoutTree(root, orientation) {
  const nodes = [];
  const edges = [];

  const countLeaves = node => {
    if (!node.children.length) node._leaves = 1;
    else node._leaves = node.children.reduce((sum, child) => sum + countLeaves(child), 0);
    return node._leaves;
  };
  countLeaves(root);

  if (orientation === 'radial') {
    const place = (node, depth, a0, a1) => {
      node.depth = depth;
      node.angle = (a0 + a1) / 2;
      node.radius = depth * RADIAL_STEP;
      node.x = Math.cos(node.angle) * node.radius;
      node.y = Math.sin(node.angle) * node.radius;
      if (!node.children.length) return;
      let start = a0;
      for (const child of node.children) {
        const span = (a1 - a0) * (child._leaves / node._leaves);
        place(child, depth + 1, start, start + span);
        start += span;
      }
    };
    place(root, 0, -Math.PI / 2, (3 * Math.PI) / 2);
  } else {
    let leafCounter = 0;
    const assign = (node, depth) => {
      node.depth = depth;
      if (!node.children.length) {
        node.order = leafCounter;
        leafCounter += 1;
      } else {
        for (const child of node.children) assign(child, depth + 1);
        node.order = (node.children[0].order + node.children.at(-1).order) / 2;
      }
    };
    assign(root, 0);

    const totalLeaves = leafCounter;
    const leafGap = orientation === 'lr' ? LEAF_GAP_LR : LEAF_GAP_TD;
    const levelGap = orientation === 'lr' ? LEVEL_GAP_LR : LEVEL_GAP_TD;
    const position = node => {
      if (orientation === 'lr') {
        node.x = node.depth * levelGap;
        node.y = (node.order - (totalLeaves - 1) / 2) * leafGap;
      } else {
        node.x = (node.order - (totalLeaves - 1) / 2) * leafGap;
        node.y = node.depth * levelGap;
      }
      for (const child of node.children) position(child);
    };
    position(root);
  }

  const collect = node => {
    nodes.push(node);
    for (const child of node.children) {
      edges.push({ parent: node, child });
      collect(child);
    }
  };
  collect(root);
  return { nodes, edges, root };
}

function edgePath(parent, child, orientation) {
  if (orientation === 'radial') {
    const dx = child.x - parent.x;
    const dy = child.y - parent.y;
    const length = Math.hypot(dx, dy) || 1;
    const ux = dx / length;
    const uy = dy / length;
    const startGap = parent.depth === 0 ? 22 : parent.kind === 'directory' ? 15 : 10;
    const endGap = child.kind === 'directory' ? 16 : 10;
    const sx = parent.x + ux * startGap;
    const sy = parent.y + uy * startGap;
    const ex = child.x - ux * endGap;
    const ey = child.y - uy * endGap;
    const midRadius = (parent.radius + child.radius) / 2 + 16;
    const qx = Math.cos(child.angle) * midRadius;
    const qy = Math.sin(child.angle) * midRadius;
    return `M ${sx.toFixed(2)} ${sy.toFixed(2)} Q ${qx.toFixed(2)} ${qy.toFixed(2)} ${ex.toFixed(2)} ${ey.toFixed(2)}`;
  }

  if (orientation === 'lr') {
    const sx = parent.x + (parent.kind === 'directory' ? FOLDER_W / 2 : FILE_R);
    const ex = child.x - (child.kind === 'directory' ? FOLDER_W / 2 : FILE_R);
    const midX = (sx + ex) / 2;
    return `M ${sx} ${parent.y} H ${midX} V ${child.y} H ${ex}`;
  }

  const sy = parent.y + (parent.kind === 'directory' ? FOLDER_H / 2 : FILE_R);
  const ey = child.y - (child.kind === 'directory' ? FOLDER_H / 2 : FILE_R);
  const midY = (sy + ey) / 2;
  return `M ${parent.x} ${sy} V ${midY} H ${child.x} V ${ey}`;
}

function labelExtents(node, orientation) {
  let minX = node.x;
  let maxX = node.x;
  let minY = node.y;
  let maxY = node.y;

  if (node.kind === 'directory') {
    minX -= FOLDER_W / 2;
    maxX += FOLDER_W / 2;
    minY -= FOLDER_H / 2;
    maxY += FOLDER_H / 2;
    return { minX, maxX, minY, maxY };
  }

  minX -= FILE_R;
  maxX += FILE_R;
  minY -= FILE_R;
  maxY += FILE_R;
  const labelWidth = Math.max(truncateLabel(node.name, 24).length * 6.1, 24);
  if (orientation === 'td') {
    minX = Math.min(minX, node.x - labelWidth / 2);
    maxX = Math.max(maxX, node.x + labelWidth / 2);
    maxY = Math.max(maxY, node.y + 28);
  } else if (orientation === 'lr') {
    maxX = Math.max(maxX, node.x + 17 + labelWidth);
    maxY = Math.max(maxY, node.y + 8);
  } else {
    minY -= 8;
    maxY += 8;
    if (Math.cos(node.angle || 0) >= 0) maxX = Math.max(maxX, node.x + 17 + labelWidth);
    else minX = Math.min(minX, node.x - 17 - labelWidth);
  }
  return { minX, maxX, minY, maxY };
}

function fitViewBox(layout, orientation) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const node of layout.nodes) {
    const ext = labelExtents(node, orientation);
    minX = Math.min(minX, ext.minX);
    maxX = Math.max(maxX, ext.maxX);
    minY = Math.min(minY, ext.minY);
    maxY = Math.max(maxY, ext.maxY);
  }
  const padding = orientation === 'radial' ? 40 : 28;
  minX -= padding;
  maxX += padding;
  minY -= padding;
  maxY += padding;

  const width = Math.max(maxX - minX, MIN_VIEW_W);
  const height = Math.max(maxY - minY, MIN_VIEW_H);
  return {
    x: (minX + maxX) / 2 - width / 2,
    y: (minY + maxY) / 2 - height / 2,
    w: width,
    h: height,
  };
}

/* ------------------------------------------------------------------- render */

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

  syncReport(report);

  const scan = report.scan ?? {};
  const sourceTree = ctx.tree.buildTree(scan, report.issues ?? []);
  if (!ui.seeded) {
    seedCollapsed(sourceTree);
    ui.seeded = true;
  }

  const rawGraph = report.graph;
  const graph = rawGraph?.nodes?.length ? ctx.graph.buildGraph(rawGraph) : null;

  const focusId = state.graphFocus ? ctx.graph.nodeId(state.graphFocus) : null;
  const focusPath = focusId && ctx.graph.isFileNode(focusId) ? ctx.graph.nodeLabel(focusId) : null;
  const focusNode = focusPath ? ctx.tree.findNode(sourceTree, focusPath) : null;

  if (focusNode?.kind === 'file') {
    const local = Boolean(ui.pendingFocus) && ui.pendingFocus === focusId;
    ui.pendingFocus = null;
    if (local) {
      ui.lastFocus = focusId;
    } else if (focusId !== ui.lastFocus) {
      // External deep link (dependencies / coverage): root at the file's folder.
      ui.selected = focusPath;
      ui.rootPath = parentDir(focusPath);
      revealPath(focusPath);
      ui.lastFocus = focusId;
    }
  } else {
    ui.pendingFocus = null;
    if (focusId && focusId !== ui.lastFocus) ui.selected = null;
    ui.lastFocus = focusId;
  }

  let rootSource = ui.rootPath ? ctx.tree.findNode(sourceTree, ui.rootPath) : sourceTree;
  if (!rootSource || rootSource.kind !== 'directory') {
    ui.rootPath = '';
    rootSource = sourceTree;
  }

  const projectBase = (() => {
    const path = ctx.project?.path;
    if (path && path !== '.' && path !== './') return String(path).replace(/^\.\//, '');
    return state.session?.name ?? '';
  })();

  const displayPath = path => {
    const clean = String(path ?? '').replaceAll('\\', '/');
    if (!clean) return projectBase || 'workspace';
    return projectBase ? `${projectBase}/${clean}` : clean;
  };

  const rootLabel = rootSource.path
    ? rootSource.name
    : (projectBase.split('/').filter(Boolean).at(-1) || state.session?.name || 'root');

  const rootCounts = rootSource.counts ?? { files: 0, issues: 0 };
  const folderCount = ctx.tree.directories(sourceTree, { includeRoot: true }).length;

  /* ------------------------------------------------------------- shell */

  const panel = el('section', { className: 'map-panel', attrs: { 'aria-label': 'Module tree map' } });

  const panelHead = el('div', { className: 'map-panel-head' });
  panelHead.append(
    el('span', { className: 'map-root', text: `ROOT / ${displayPath(rootSource.path)}` }),
    el('span', {
      className: 'map-counts',
      text: `${number(rootCounts.files)} ${rootCounts.files === 1 ? 'FILE' : 'FILES'} · ${number(folderCount)} ${folderCount === 1 ? 'FOLDER' : 'FOLDERS'} · ${number(rootCounts.issues)} ${rootCounts.issues === 1 ? 'ISSUE' : 'ISSUES'}`,
    }),
  );
  panel.append(panelHead);

  if (scan.partial || scan.graph_partial) {
    const banner = el('div', { className: 'map-banner' });
    const copy = el('div', { className: 'map-banner-copy' });
    copy.append(
      el('strong', { text: 'Partial coverage' }),
      el('span', {
        text: 'Some files or imports were not checked, so this tree and the blast radius may be incomplete.',
      }),
    );
    banner.append(copy, el('button', {
      className: 'secondary',
      type: 'button',
      text: 'Open Coverage',
      on: { click: () => ctx.view('coverage') },
    }));
    panel.append(banner);
  }

  const toolbar = el('div', { className: 'map-toolbar' });

  const segmented = el('div', { className: 'segmented', attrs: { role: 'group', 'aria-label': 'Tree orientation' } });
  const orientationButtons = ['td', 'lr', 'radial'].map(orientation => {
    const labels = { td: 'Top-down', lr: 'Left-right', radial: 'Radial' };
    const button = el('button', {
      type: 'button',
      text: labels[orientation],
      attrs: { 'aria-pressed': ui.orientation === orientation ? 'true' : 'false', 'data-orient': orientation },
    });
    segmented.append(button);
    return button;
  });

  const searchWrap = el('label', { className: 'map-search' });
  searchWrap.append(
    el('span', { className: 'search-mark', text: '⌕', attrs: { 'aria-hidden': 'true' } }),
    el('span', { className: 'sr-only', text: 'Find a file or folder in the tree' }),
  );
  const searchInput = el('input', {
    type: 'search',
    value: ui.query,
    placeholder: 'Find a node…',
    attrs: { autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Find a node in the tree' },
  });
  searchWrap.append(searchInput);

  const searchStatus = el('span', { className: 'map-status', attrs: { 'aria-live': 'polite' } });

  const zoomGroup = el('div', { className: 'zoom-group', attrs: { role: 'group', 'aria-label': 'Zoom tree' } });
  const zoomOut = el('button', { type: 'button', text: '−', attrs: { 'aria-label': 'Zoom out' } });
  const zoomLevel = el('span', { className: 'zoom-level', text: '100%' });
  const zoomIn = el('button', { type: 'button', text: '+', attrs: { 'aria-label': 'Zoom in' } });
  const zoomFit = el('button', { type: 'button', text: 'FIT', attrs: { 'aria-label': 'Fit tree' } });
  zoomGroup.append(zoomOut, zoomLevel, zoomIn, zoomFit);

  toolbar.append(segmented, searchWrap, searchStatus, el('span', { className: 'spacer' }), zoomGroup);
  panel.append(toolbar);

  const stage = el('div', { className: 'map-stage' });
  const svgRoot = svg('svg', {
    class: 'map-svg',
    role: 'img',
    'aria-label': 'Module tree. Folders are rectangles, files are circles. Filled nodes have findings.',
  });
  stage.append(svgRoot);
  panel.append(stage);

  const legend = el('div', { className: 'map-legend', attrs: { 'aria-label': 'Legend' } });
  const legendItem = (shape, label) => {
    const item = el('span', { className: 'legend-item' });
    const icon = svg('svg', { width: 12, height: 12, viewBox: '0 0 12 12', 'aria-hidden': 'true' });
    icon.append(shape);
    item.append(icon, el('span', { text: label }));
    return item;
  };
  legend.append(
    legendItem(svg('rect', { x: 0.5, y: 2.5, width: 11, height: 7, fill: 'none', stroke: 'currentColor' }), 'Folder'),
    legendItem(svg('circle', { cx: 6, cy: 6, r: 4.5, fill: 'none', stroke: 'currentColor' }), 'File'),
    legendItem(svg('circle', { cx: 6, cy: 6, r: 4.5, class: 'sev-fill-high', stroke: 'currentColor' }), 'High'),
    legendItem(svg('circle', { cx: 6, cy: 6, r: 4.5, class: 'sev-fill-medium', stroke: 'currentColor' }), 'Medium'),
    legendItem(svg('circle', { cx: 6, cy: 6, r: 4.5, class: 'sev-fill-low', stroke: 'currentColor' }), 'Low'),
    legendItem(svg('circle', { cx: 6, cy: 6, r: 4.5, fill: 'none', stroke: 'currentColor', 'stroke-dasharray': '2 2' }), 'Unchecked'),
  );
  panel.append(legend);

  const side = el('aside', {
    className: 'panel map-side',
    attrs: { 'aria-live': 'polite', 'aria-label': 'Selected node details' },
  });

  const shell = el('div', { className: 'map-shell' });
  shell.append(panel, side);
  container.append(shell);

  /* ---------------------------------------------------------- painting */

  const nodeEls = new Map();
  const edgeEls = new Map();

  const applyViewBox = () => {
    const base = ui.baseView;
    if (!base) return;
    const width = base.w / ui.zoom;
    const height = base.h / ui.zoom;
    const x = base.x + (base.w - width) / 2;
    const y = base.y + (base.h - height) / 2;
    svgRoot.setAttribute('viewBox', `${x.toFixed(2)} ${y.toFixed(2)} ${width.toFixed(2)} ${height.toFixed(2)}`);
    zoomLevel.textContent = `${Math.round(ui.zoom * 100)}%`;
  };

  const clearHighlight = () => {
    svgRoot.classList.remove('is-tracing');
    for (const node of nodeEls.values()) node.classList.remove('is-hl');
    for (const edge of edgeEls.values()) edge.classList.remove('is-hl');
  };

  const setHover = path => {
    ui.hovered = path || null;
    clearHighlight();
    if (!ui.hovered) return;
    svgRoot.classList.add('is-tracing');
    for (const key of ancestorPaths(ui.hovered)) {
      const nodeEl = nodeEls.get(key);
      if (nodeEl) nodeEl.classList.add('is-hl');
      const edgeEl = edgeEls.get(key);
      if (edgeEl) edgeEl.classList.add('is-hl');
    }
  };

  const applySearchHighlight = () => {
    for (const node of nodeEls.values()) node.classList.remove('is-search');
    for (const edge of edgeEls.values()) edge.classList.remove('is-search');
    const active = Boolean(ui.query) && ui.matches.length > 0;
    svgRoot.classList.toggle('is-searching', active);
    if (!active) return;
    const match = ui.matches[ui.matchIndex] ?? ui.matches[0];
    if (!match) return;
    for (const key of ancestorPaths(match)) {
      const nodeEl = nodeEls.get(key);
      if (nodeEl) nodeEl.classList.add('is-search');
      const edgeEl = edgeEls.get(key);
      if (edgeEl) edgeEl.classList.add('is-search');
    }
  };

  const syncSearchStatus = () => {
    if (!ui.query) {
      searchStatus.textContent = '';
      return;
    }
    if (!ui.matches.length) {
      searchStatus.textContent = 'NO MATCH';
      return;
    }
    searchStatus.textContent = `${ui.matchIndex + 1} OF ${ui.matches.length} · ${displayPath(ui.matches[ui.matchIndex])}`;
  };

  const selectPath = path => {
    const target = ctx.tree.findNode(sourceTree, path);
    if (!target) return;
    revealPath(path);
    ui.selected = path;
    const id = ctx.graph.nodeId(path);
    if (ctx.state.graphFocus === id) {
      paint();
      return;
    }
    ui.pendingFocus = id;
    ctx.setState({ graphFocus: id });
  };

  const createNode = node => {
    const isRoot = node.path === rootSource.path;
    const inactive = node.kind === 'file' && INACTIVE.has(node.status);
    const collapsed = node.kind === 'directory'
      && !isRoot
      && (node.source.children?.length ?? 0) > 0
      && ui.collapsed.has(node.path);

    const className = [
      'map-node',
      isRoot ? 'is-root' : '',
      inactive ? 'is-inactive' : '',
    ].filter(Boolean).join(' ');

    const group = svg('g', {
      class: className,
      'data-path': node.path,
      tabindex: 0,
      role: 'button',
    });

    const title = svg('title', {}, displayPath(node.path));
    group.append(title);

    if (node.kind === 'directory') {
      if ((node.source.children?.length ?? 0) > 0) {
        group.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      }
      group.setAttribute(
        'aria-label',
        `Folder ${node.name}, ${node.fileCount} ${node.fileCount === 1 ? 'file' : 'files'}, ${collapsed ? 'collapsed' : 'expanded'}.`,
      );

      group.append(svg('rect', {
        x: node.x - FOLDER_W / 2,
        y: node.y - FOLDER_H / 2,
        width: FOLDER_W,
        height: FOLDER_H,
        class: 'node-shape folder-shape',
      }));
      group.append(svg('text', {
        x: node.x - FOLDER_W / 2 + 10,
        y: node.y - 1,
        'text-anchor': 'start',
        class: 'node-label folder-label',
      }, truncateLabel(node.name, 12)));
      group.append(svg('text', {
        x: node.x - FOLDER_W / 2 + 10,
        y: node.y + 10,
        'text-anchor': 'start',
        class: 'node-meta',
      }, isRoot ? 'ROOT' : collapsed ? 'CLOSED +' : 'OPEN -'));
      group.append(svg('text', {
        x: node.x + FOLDER_W / 2 - 10,
        y: node.y + 10,
        'text-anchor': 'end',
        class: 'node-meta',
      }, `${number(node.fileCount)} ${node.fileCount === 1 ? 'FILE' : 'FILES'}`));
    } else {
      const severity = node.maxSeverity && !inactive ? ` sev-${node.maxSeverity}` : '';
      group.setAttribute(
        'aria-label',
        `File ${node.name}${node.maxSeverity ? `, ${node.maxSeverity} severity finding` : inactive ? `, ${node.status}` : ', no finding'}.`,
      );
      group.append(svg('circle', {
        cx: node.x,
        cy: node.y,
        r: FILE_R,
        class: `node-shape file-shape${severity}`,
      }));

      let labelX = node.x;
      let labelY = node.y + 24;
      let anchor = 'middle';
      if (ui.orientation === 'lr') {
        labelX = node.x + 16;
        labelY = node.y + 3.5;
        anchor = 'start';
      } else if (ui.orientation === 'radial') {
        anchor = Math.cos(node.angle || 0) >= 0 ? 'start' : 'end';
        labelX = node.x + (anchor === 'start' ? 14 : -14);
        labelY = node.y + 3.5;
      }
      group.append(svg('text', {
        x: labelX,
        y: labelY,
        'text-anchor': anchor,
        class: 'node-label',
      }, truncateLabel(node.name, ui.orientation === 'td' ? 18 : 24)));
    }

    const activate = () => {
      if (node.kind === 'directory') {
        if (isRoot || !(node.source.children?.length ?? 0)) return;
        if (ui.collapsed.has(node.path)) ui.collapsed.delete(node.path);
        else ui.collapsed.add(node.path);
        paint();
      } else {
        selectPath(node.path);
      }
    };

    group.addEventListener('click', event => {
      event.stopPropagation();
      activate();
    });

    group.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activate();
        return;
      }
      if (node.kind !== 'directory' || isRoot) return;
      if (event.key === 'ArrowRight' && ui.collapsed.has(node.path)) {
        event.preventDefault();
        ui.collapsed.delete(node.path);
        paint();
      } else if (event.key === 'ArrowLeft' && !ui.collapsed.has(node.path)) {
        event.preventDefault();
        ui.collapsed.add(node.path);
        paint();
      }
    });

    group.addEventListener('mouseenter', () => setHover(node.path));
    group.addEventListener('mouseleave', () => setHover(null));
    group.addEventListener('focus', () => setHover(node.path));
    group.addEventListener('blur', () => setHover(null));

    return group;
  };

  const renderSide = () => {
    side.replaceChildren();

    const selectedNode = ui.selected ? ctx.tree.findNode(rootSource, ui.selected) : null;
    if (!selectedNode || selectedNode.kind !== 'file') {
      const head = el('div', { className: 'side-head' });
      head.append(el('span', { className: 'micro', text: 'Selected file' }));
      side.append(
        head,
        el('div', {
          className: 'side-empty',
          text: 'Select a file node to inspect its issues, imports and blast radius.',
        }),
      );
      return;
    }

    const issues = selectedNode.issues ?? [];
    const inactive = INACTIVE.has(selectedNode.status);
    const selectedId = ctx.graph.nodeId(selectedNode.path);
    const imports = graph ? graph.dependencies(selectedId) : [];
    const inbound = graph ? graph.dependents(selectedId) : [];
    const radius = graph ? ctx.graph.blastRadius(graph, selectedId) : null;
    const fileNodes = graph ? graph.nodes.filter(id => ctx.graph.isFileNode(id)).length : 0;

    const severityCounts = { high: 0, medium: 0, low: 0 };
    for (const issue of issues) {
      if (Object.hasOwn(severityCounts, issue.severity)) severityCounts[issue.severity] += 1;
    }

    const head = el('div', { className: 'side-head' });
    head.append(el('span', { className: 'micro', text: 'Selected file' }));
    if (selectedNode.maxSeverity) {
      head.append(el('span', {
        className: `badge badge--${selectedNode.maxSeverity}`,
        text: selectedNode.maxSeverity.toUpperCase(),
      }));
    } else if (inactive) {
      head.append(el('span', {
        className: 'badge badge--unchecked',
        text: STATUS_LABEL[selectedNode.status]?.toUpperCase() ?? 'UNCHECKED',
      }));
    } else {
      head.append(el('span', { className: 'badge badge--clean', text: 'CLEAN' }));
    }
    side.append(head);

    side.append(el('div', { className: 'side-path', text: displayPath(selectedNode.path) }));
    side.append(el('div', {
      className: 'side-sub',
      text: `${STATUS_LABEL[selectedNode.status] ?? 'Not checked'} · ${extensionOf(selectedNode.name)}`,
    }));

    const stats = el('div', { className: 'side-stats' });
    const stat = (key, value, suffix) => {
      const cell = el('div', { className: 'side-stat' });
      const valueEl = el('div', { className: 'v', text: number(value) });
      if (suffix) valueEl.append(el('small', { text: ` ${suffix}` }));
      cell.append(el('div', { className: 'k', text: key }), valueEl);
      stats.append(cell);
    };
    stat('Issues', issues.length, '');
    stat('Blast', radius ? radius.affected.length : '—', radius && fileNodes ? `/ ${fileNodes}` : '');
    stat('Imports', imports.length, '');
    stat('Imported by', inbound.length, '');
    side.append(stats);

    const sevLine = el('div', { className: 'side-sevline', attrs: { 'aria-label': 'Issue severity counts' } });
    for (const severity of ['high', 'medium', 'low']) {
      const item = el('span', { className: 'side-sev' });
      item.append(
        el('span', { className: `sev-swatch sev-${severity}`, attrs: { 'aria-hidden': 'true' } }),
        el('span', { text: `${severity.toUpperCase()} ${pad2(severityCounts[severity])}` }),
      );
      sevLine.append(item);
    }
    side.append(sevLine);

    const actions = el('div', { className: 'map-actions' });
    const firstIssue = issues[0] ?? null;
    actions.append(
      el('button', {
        className: 'secondary',
        type: 'button',
        text: 'Open in Findings',
        on: {
          click: () => {
            if (firstIssue) {
              const id = issueId(firstIssue);
              ctx.setState({ selectedId: id });
              ctx.view('findings', id);
            } else {
              ctx.view('findings');
            }
          },
        },
      }),
      el('button', {
        className: 'secondary',
        type: 'button',
        text: 'Show in Dependencies',
        on: {
          click: () => {
            ctx.setState({ graphFocus: selectedId, dependencyFocus: selectedId, dependencyQuery: '' });
            ctx.view('dependencies');
          },
        },
      }),
    );
    side.append(actions);

    const listBlock = (title, ids, emptyText) => {
      const block = el('div', { className: 'side-block' });
      const blockTitle = el('div', { className: 'side-block-title' });
      blockTitle.append(el('span', { text: title }), el('span', { text: pad2(ids.length) }));
      block.append(blockTitle);

      if (!ids.length) {
        block.append(el('p', { className: 'side-quiet', text: emptyText }));
        return block;
      }

      const list = el('ul', { className: 'side-list' });
      for (const id of ids.slice(0, EDGE_LIMIT)) {
        const label = ctx.graph.nodeLabel(id);
        const kind = ctx.graph.nodeKind(id);
        const target = kind === 'file' ? ctx.tree.findNode(sourceTree, label) : null;
        const clickable = target?.kind === 'file';
        const item = el('li');
        const row = clickable
          ? el('button', {
            className: 'side-link',
            type: 'button',
            attrs: { 'aria-label': `Select ${label}` },
            on: { click: () => selectPath(label) },
          })
          : el('span', { className: 'side-link side-link--static' });
        row.append(
          el('span', { className: 'mono', text: label }),
          el('span', { className: 'kind', text: kind }),
        );
        item.append(row);
        list.append(item);
      }
      block.append(list);
      if (ids.length > EDGE_LIMIT) {
        block.append(el('p', {
          className: 'side-quiet',
          text: `Showing ${number(EDGE_LIMIT)} of ${number(ids.length)}.`,
        }));
      }
      return block;
    };

    if (!graph) {
      side.append(el('p', {
        className: 'side-quiet',
        text: 'This scan has no dependency graph, so imports and blast radius are unavailable.',
      }));
    } else {
      side.append(listBlock('Imports', imports, 'No resolved imports.'));
      side.append(listBlock('Imported by', inbound, 'No importers in this graph.'));

      const blastBlock = el('div', { className: 'side-block' });
      const blastTitle = el('div', { className: 'side-block-title' });
      blastTitle.append(
        el('span', { text: 'Blast radius' }),
        el('span', { text: `${number(radius.affected.length)} / ${number(fileNodes)}` }),
      );
      blastBlock.append(blastTitle);

      const blastValue = el('div', { className: 'side-blast' });
      blastValue.append(
        el('span', { className: 'big', text: number(radius.affected.length) }),
        el('span', {
          className: 'small',
          text: `${number(radius.direct.length)} direct · ${number(radius.transitive.length)} transitive`,
        }),
      );
      blastBlock.append(blastValue);

      if (radius.isRoot) {
        blastBlock.append(el('p', {
          className: 'side-quiet',
          text: 'No dependents in the scanned graph; this does not establish a runtime entry point.',
        }));
      } else {
        const radiusList = el('ul', { className: 'side-list' });
        for (const id of radius.affected.slice(0, AFFECTED_LIMIT)) {
          const item = el('li');
          const row = el('span', { className: 'side-link side-link--static' });
          row.append(
            el('span', { className: 'mono', text: ctx.graph.nodeLabel(id) }),
            el('span', { className: 'kind', text: `d${radius.distances.get(id)}` }),
          );
          item.append(row);
          radiusList.append(item);
        }
        blastBlock.append(radiusList);
        if (radius.affected.length > AFFECTED_LIMIT) {
          blastBlock.append(el('p', {
            className: 'side-quiet',
            text: `Showing ${number(AFFECTED_LIMIT)} of ${number(radius.affected.length)} affected nodes.`,
          }));
        }
      }
      side.append(blastBlock);
    }

    if (issues.length) {
      for (const issue of issues.slice(0, 3)) {
        const box = el('div', { className: 'side-issue' });
        box.append(
          el('span', { className: `badge badge--${issue.severity}`, text: issue.severity.toUpperCase() }),
          el('div', { className: 'type', text: `${issue.type} · line ${issue.line}` }),
        );
        if (issue.target) box.append(el('div', { className: 'type', text: issue.target }));
        side.append(box);
      }
      if (issues.length > 3) {
        side.append(el('p', {
          className: 'side-quiet',
          text: `+ ${number(issues.length - 3)} more ${issues.length - 3 === 1 ? 'finding' : 'findings'} in Findings.`,
        }));
      }
    } else if (inactive) {
      side.append(el('p', {
        className: 'side-quiet',
        text: selectedNode.reason || `This file was not checked (${selectedNode.status}).`,
      }));
    } else {
      side.append(el('p', { className: 'side-quiet', text: 'No findings for this file.' }));
    }
  };

  const paint = () => {
    const collapsed = new Set(ui.collapsed);
    collapsed.delete(rootSource.path);
    const visibleRoot = buildVisibleNode(rootSource, null, 0, rootSource, collapsed);
    visibleRoot.name = rootLabel;

    const layout = layoutTree(visibleRoot, ui.orientation);
    ui.baseView = fitViewBox(layout, ui.orientation);

    svgRoot.replaceChildren();
    nodeEls.clear();
    edgeEls.clear();

    for (const edge of layout.edges) {
      const path = svg('path', {
        d: edgePath(edge.parent, edge.child, ui.orientation),
        class: 'map-edge',
        'data-edge': edge.child.path,
      });
      svgRoot.append(path);
      edgeEls.set(edge.child.path, path);
    }

    for (const node of layout.nodes) {
      const group = createNode(node);
      if (node.path === ui.selected) group.classList.add('is-selected');
      svgRoot.append(group);
      nodeEls.set(node.path, group);
    }

    applyViewBox();
    applySearchHighlight();
    syncSearchStatus();
    if (ui.hovered) setHover(ui.hovered);
    renderSide();
  };

  /* --------------------------------------------------------- interactions */

  const recomputeMatches = () => {
    ui.matches = [];
    if (!ui.query) return;
    const needle = ui.query.toLowerCase();
    const visit = node => {
      if (node.path !== rootSource.path && (
        node.name.toLowerCase().includes(needle) || node.path.toLowerCase().includes(needle)
      )) {
        if (ui.matches.length < MAX_MATCHES) ui.matches.push(node.path);
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(rootSource);
    if (ui.matchIndex >= ui.matches.length) ui.matchIndex = 0;
  };

  searchInput.addEventListener('input', () => {
    ui.query = searchInput.value.trim();
    ui.matchIndex = 0;
    recomputeMatches();
    if (ui.matches.length) {
      revealPath(ui.matches[0]);
      ui.selected = ui.matches[0];
    }
    paint();
  });

  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && ui.matches.length) {
      event.preventDefault();
      const direction = event.shiftKey ? -1 : 1;
      ui.matchIndex = (ui.matchIndex + direction + ui.matches.length) % ui.matches.length;
      const match = ui.matches[ui.matchIndex];
      revealPath(match);
      ui.selected = match;
      paint();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      searchInput.value = '';
      ui.query = '';
      ui.matches = [];
      ui.matchIndex = 0;
      paint();
    }
  });

  for (const button of orientationButtons) {
    button.addEventListener('click', () => {
      ui.orientation = button.dataset.orient;
      ui.zoom = 1;
      for (const item of orientationButtons) {
        item.setAttribute('aria-pressed', item === button ? 'true' : 'false');
      }
      paint();
    });
  }

  zoomIn.addEventListener('click', () => {
    ui.zoom = Math.min(ui.zoom + 0.25, 2.5);
    applyViewBox();
  });

  zoomOut.addEventListener('click', () => {
    ui.zoom = Math.max(ui.zoom - 0.25, 0.5);
    applyViewBox();
  });

  zoomFit.addEventListener('click', () => {
    ui.zoom = 1;
    applyViewBox();
  });

  if (ui.query) recomputeMatches();
  paint();
}
