/**
 * Dependency-graph helpers.
 *
 * `report.graph` is `{ nodes: string[], edges: {source, target}[] }` where ids
 * are namespaced: `file:<path>`, `package:<name>` and `unresolved:<specifier>`.
 * Nothing here mutates the report; every helper returns fresh data.
 *
 * Reverse BFS answers "what depends on this node?" for any node id, including
 * ids that only appear as an edge target (e.g. an unresolved import).
 */

const PREFIXES = ['file:', 'package:', 'unresolved:'];

/** Normalize a path or raw id to a namespaced node id. */
export function nodeId(value, fallbackPrefix = 'file:') {
  const id = String(value ?? '');
  if (PREFIXES.some(prefix => id.startsWith(prefix))) return id;
  return `${fallbackPrefix}${id}`;
}

export function isFileNode(id) {
  return String(id ?? '').startsWith('file:');
}

/** Human label without the namespace prefix. */
export function nodeLabel(id) {
  const value = String(id ?? '');
  const prefix = PREFIXES.find(candidate => value.startsWith(candidate));
  return prefix ? value.slice(prefix.length) : value;
}

export function nodeKind(id) {
  const value = String(id ?? '');
  const prefix = PREFIXES.find(candidate => value.startsWith(candidate));
  return prefix ? prefix.slice(0, -1) : 'unknown';
}

function pushMulti(map, key, value) {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  if (!list.includes(value)) list.push(value);
}

/**
 * Build adjacency maps.
 * @returns {{
 *   nodes: string[], edges: {source: string, target: string}[],
 *   outgoing: Map<string, string[]>, incoming: Map<string, string[]>,
 *   nodeSet: Set<string>, has: (id: string) => boolean,
 *   dependencies: (id: string) => string[], dependents: (id: string) => string[]
 * }}
 */
export function buildGraph(graph) {
  const edges = (graph?.edges ?? []).map(edge => ({
    source: nodeId(edge.source),
    target: nodeId(edge.target),
  }));
  const nodeSet = new Set((graph?.nodes ?? []).map(id => nodeId(id)));
  for (const edge of edges) {
    nodeSet.add(edge.source);
    nodeSet.add(edge.target);
  }
  const nodes = [...nodeSet].sort();
  const outgoing = new Map();
  const incoming = new Map();
  for (const id of nodes) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const { source, target } of edges) {
    pushMulti(outgoing, source, target);
    pushMulti(incoming, target, source);
  }
  for (const list of outgoing.values()) list.sort();
  for (const list of incoming.values()) list.sort();

  return {
    nodes,
    edges,
    outgoing,
    incoming,
    nodeSet,
    has: id => nodeSet.has(nodeId(id)),
    dependencies: id => [...(outgoing.get(nodeId(id)) ?? [])],
    dependents: id => [...(incoming.get(nodeId(id)) ?? [])],
  };
}


/**
 * Reverse BFS from any node id.
 *
 * @returns {{
 *   id: string, known: boolean, affected: string[],
 *   direct: string[], transitive: string[],
 *   distances: Map<string, number>, parents: Map<string, string|null>,
 *   isRoot: boolean
 * }}
 */
export function blastRadius(graph, value) {
  const id = nodeId(value);
  const reverse = graph?.incoming ?? new Map();
  const distances = new Map([[id, 0]]);
  const parents = new Map([[id, null]]);
  const queue = [id];
  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const distance = distances.get(current) ?? 0;
    for (const dependent of reverse.get(current) ?? []) {
      if (distances.has(dependent)) continue;
      distances.set(dependent, distance + 1);
      parents.set(dependent, current);
      queue.push(dependent);
    }
  }
  const affected = queue.slice(1).sort();
  const direct = [...(reverse.get(id) ?? [])].filter(dependent => dependent !== id).sort();
  const directSet = new Set(direct);
  return {
    id,
    known: Boolean(graph?.nodeSet?.has(id)),
    affected,
    direct,
    transitive: affected.filter(dependent => !directSet.has(dependent)),
    distances,
    parents,
    isRoot: affected.length === 0,
  };
}

/** Reconstruct one shortest reverse path from `id` to `dependent`. */
export function pathTo(radius, dependent) {
  const id = nodeId(dependent);
  if (!radius?.parents?.has(id)) return [];
  const path = [];
  let cursor = id;
  while (cursor !== null && cursor !== undefined) {
    path.push(cursor);
    cursor = radius.parents.get(cursor) ?? null;
  }
  return path.reverse();
}

/** Group nodes by shortest reverse distance from a focus node. */
export function distanceLayers(graph, focus) {
  const radius = blastRadius(graph, focus);
  const layers = new Map();
  for (const [id, distance] of radius.distances) {
    if (!layers.has(distance)) layers.set(distance, []);
    layers.get(distance).push(id);
  }
  for (const list of layers.values()) list.sort();
  return { radius, layers };
}

/**
 * Simple layered layout for SVG.
 *
 * Without a focus, layers follow longest-path depth from nodes with no
 * dependencies (cycles are tolerated by capping passes). With a focus, layers
 * are reverse-BFS distance from that node, which reads as "blast radius";
 * nodes unreachable from the focus are parked in a trailing layer.
 *
 * @returns {{positions: Map<string, {x: number, y: number, layer: number}>, layers: number, width: number, height: number}}
 */
export function layeredLayout(graph, { focus = null, nodes = null, width = 960, height = 520, padding = 48, maxNodes = 600 } = {}) {
  const all = nodes ?? graph?.nodes ?? [];
  const selected = all.slice(0, maxNodes);
  const selectedSet = new Set(selected);
  const positions = new Map();
  if (!selected.length) return { positions, layers: 0, width, height };

  const UNREACHABLE = Number.MAX_SAFE_INTEGER;
  const layerOf = new Map();

  if (focus && selectedSet.has(nodeId(focus))) {
    const radius = blastRadius(graph, focus);
    for (const id of selected) {
      const distance = radius.distances.get(id);
      layerOf.set(id, distance === undefined ? UNREACHABLE : distance);
    }
  } else {
    // Longest-path layering over the induced subgraph.
    const depth = new Map(selected.map(id => [id, 0]));
    const passes = Math.min(selected.length, 40);
    for (let pass = 0; pass < passes; pass += 1) {
      let changed = false;
      for (const { source, target } of graph?.edges ?? []) {
        if (!selectedSet.has(source) || !selectedSet.has(target)) continue;
        const candidate = (depth.get(source) ?? 0) + 1;
        if (candidate > (depth.get(target) ?? 0) && candidate < selected.length) {
          depth.set(target, candidate);
          changed = true;
        }
      }
      if (!changed) break;
    }
    for (const [id, layer] of depth) layerOf.set(id, layer);
  }

  const grouped = new Map();
  for (const [id, layer] of layerOf) {
    if (!grouped.has(layer)) grouped.set(layer, []);
    grouped.get(layer).push(id);
  }
  const orderedLayers = [...grouped.entries()].sort((left, right) => left[0] - right[0]);
  const layerCount = orderedLayers.length || 1;
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  const step = layerCount > 1 ? usableWidth / (layerCount - 1) : 0;

  orderedLayers.forEach(([, list], index) => {
    const sorted = [...list].sort();
    const count = sorted.length;
    sorted.forEach((id, row) => {
      const x = padding + (layerCount > 1 ? index * step : usableWidth / 2);
      const y = count === 1 ? padding + usableHeight / 2 : padding + (row * usableHeight) / (count - 1);
      positions.set(id, { x, y, layer: index });
    });
  });

  // Nodes outside the laid-out set still get a stable slot so views can render.
  for (const id of all) {
    if (positions.has(id)) continue;
    positions.set(id, { x: padding, y: padding, layer: 0 });
  }

  return { positions, layers: layerCount, width, height };
}

/** Summarize graph size for dashboards. */
export function graphSummary(graph) {
  const edges = graph?.edges ?? [];
  const nodes = graph?.nodes ?? [];
  const packages = new Set();
  const unresolved = new Set();
  for (const id of nodes) {
    if (id.startsWith('package:')) packages.add(id);
    if (id.startsWith('unresolved:')) unresolved.add(id);
  }
  return {
    nodes: nodes.length,
    edges: edges.length,
    files: nodes.filter(id => id.startsWith('file:')).length,
    packages: packages.size,
    unresolved: unresolved.size,
  };
}

/** Nodes sorted by how many other nodes depend on them, descending. */
export function mostDependedOn(graph, limit = 10) {
  const incoming = graph?.incoming ?? new Map();
  return [...(graph?.nodes ?? [])]
    .map(id => ({ id, dependents: (incoming.get(id) ?? []).length }))
    .filter(item => item.dependents > 0)
    .sort((left, right) => right.dependents - left.dependents || left.id.localeCompare(right.id))
    .slice(0, limit);
}
