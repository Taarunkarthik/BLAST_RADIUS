/**
 * Filesystem tree built from a scan report.
 *
 * Sources, in priority order: `scan.checked_files`, `scan.not_checked_files`,
 * `scan.excluded_files`, `scan.skipped_files`, then every `issue.file` (issues
 * may reference files outside the checked set, e.g. imports that resolved
 * outside it). Each leaf keeps the coverage status and its findings; every
 * directory aggregates counts and a maximum severity for its subtree.
 *
 * Pure data: no DOM, no state. Views own presentation.
 */

import { SEVERITY_ORDER, severityRank } from './format.js';

export const STATUS = Object.freeze({
  CHECKED: 'checked',
  UNCHECKED: 'unchecked',
  EXCLUDED: 'excluded',
  SKIPPED: 'skipped',
  ISSUE_ONLY: 'issueOnly',
});

function blankCounts() {
  return {
    files: 0,
    checked: 0,
    unchecked: 0,
    excluded: 0,
    skipped: 0,
    issueOnly: 0,
    issues: 0,
    issueFiles: 0,
    high: 0,
    medium: 0,
    low: 0,
  };
}

function newDirectory(name, path) {
  return {
    name,
    path,
    kind: 'directory',
    status: null,
    reason: '',
    children: [],
    childMap: new Map(),
    issues: [],
    counts: blankCounts(),
    maxSeverity: null,
  };
}

function newFile(name, path, status, reason = '') {
  return {
    name,
    path,
    kind: 'file',
    status,
    reason,
    children: [],
    childMap: null,
    issues: [],
    counts: blankCounts(),
    maxSeverity: null,
  };
}

function childFor(parent, segment, path) {
  let child = parent.childMap.get(segment);
  if (!child) {
    child = newDirectory(segment, path);
    parent.childMap.set(segment, child);
    parent.children.push(child);
  }
  return child;
}

function segmentsOf(file) {
  return String(file ?? '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(segment => segment !== '' && segment !== '.');
}

function ensureFile(root, file) {
  const segments = segmentsOf(file);
  if (!segments.length) return null;
  let cursor = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const path = segments.slice(0, index + 1).join('/');
    cursor = childFor(cursor, segments[index], path);
  }
  const name = segments.at(-1);
  let leaf = cursor.childMap.get(name);
  if (!leaf) {
    leaf = newFile(name, segments.join('/'), STATUS.ISSUE_ONLY);
    cursor.childMap.set(name, leaf);
    cursor.children.push(leaf);
  }
  return leaf;
}

function setStatus(leaf, status, reason) {
  // First writer wins for status: checked beats excluded beats skipped beats
  // issue-only, which is the order the scanner itself uses.
  const priority = {
    [STATUS.CHECKED]: 4,
    [STATUS.UNCHECKED]: 3,
    [STATUS.EXCLUDED]: 2,
    [STATUS.SKIPPED]: 1,
    [STATUS.ISSUE_ONLY]: 0,
  };
  if (!leaf) return;
  if (priority[status] >= priority[leaf.status ?? STATUS.ISSUE_ONLY]) {
    leaf.status = status;
    leaf.reason = reason ?? leaf.reason;
  }
}

function accumulate(node) {
  if (node.kind === 'file') {
    const counts = node.counts;
    counts.files = 1;
    counts.issues = node.issues.length;
    counts.issueFiles = node.issues.length ? 1 : 0;
    if (node.status) counts[node.status] = (counts[node.status] ?? 0) + 1;
    for (const issue of node.issues) {
      if (Object.hasOwn(SEVERITY_ORDER, issue.severity)) counts[issue.severity] += 1;
    }
    let max = null;
    for (const issue of node.issues) {
      if (max === null || severityRank(issue.severity) < severityRank(max)) max = issue.severity;
    }
    node.maxSeverity = max;
    return node;
  }

  const counts = blankCounts();
  let max = null;
  for (const child of node.children) {
    accumulate(child);
    for (const key of Object.keys(counts)) counts[key] += child.counts[key] ?? 0;
    if (child.maxSeverity && (max === null || severityRank(child.maxSeverity) < severityRank(max))) {
      max = child.maxSeverity;
    }
  }
  node.counts = counts;
  node.maxSeverity = max;
  return node;
}

function sortTree(node) {
  if (node.kind === 'directory') {
    node.children.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    for (const child of node.children) sortTree(child);
  }
  return node;
}

/**
 * Build the tree.
 * @param {object} scan - report.scan
 * @param {Array<object>} issues - report.issues
 * @returns {object} root directory node (path '')
 */
export function buildTree(scan = {}, issues = []) {
  const root = newDirectory('.', '');
  const entries = [];

  for (const file of scan.checked_files ?? []) entries.push([file, STATUS.CHECKED, '']);
  for (const file of scan.not_checked_files ?? []) entries.push([file, STATUS.UNCHECKED, 'No configured checker']);
  for (const item of scan.excluded_files ?? []) {
    if (typeof item === 'string') entries.push([item, STATUS.EXCLUDED, 'Excluded']);
    else entries.push([item.file, STATUS.EXCLUDED, item.reason ?? 'Excluded']);
  }
  for (const item of scan.skipped_files ?? []) {
    if (typeof item === 'string') entries.push([item, STATUS.SKIPPED, 'Skipped']);
    else entries.push([item.file, STATUS.SKIPPED, item.reason ?? 'Skipped']);
  }

  for (const [file, status, reason] of entries) {
    setStatus(ensureFile(root, file), status, reason);
  }

  for (const issue of issues ?? []) {
    const leaf = ensureFile(root, issue.file);
    if (leaf) leaf.issues.push(issue);
  }

  accumulate(root);
  sortTree(root);
  return root;
}

/** Depth-first walk. Returning false from `visit` skips that node's children. */
export function walk(node, visit, depth = 0) {
  if (!node) return;
  if (visit(node, depth) === false) return;
  for (const child of node.children ?? []) walk(child, visit, depth + 1);
}

export function flatten(node) {
  const result = [];
  walk(node, current => {
    result.push(current);
  });
  return result;
}

/** Find a node by report-relative path ('' is the root). */
export function findNode(root, path) {
  const target = segmentsOf(path).join('/');
  if (target === '') return root ?? null;
  let cursor = root;
  for (const segment of segmentsOf(target)) {
    cursor = cursor?.childMap?.get(segment) ?? null;
    if (!cursor) return null;
  }
  return cursor;
}

/** Directory nodes only, depth first, excluding the root unless asked. */
export function directories(root, { includeRoot = false } = {}) {
  const result = [];
  walk(root, current => {
    if (current.kind !== 'directory') return false;
    if (current.path !== '' || includeRoot) result.push(current);
    return true;
  });
  return result;
}

/** Per-directory counts for a node's own subtree (already aggregated). */
export function directoryCounts(node) {
  return { ...(node?.counts ?? blankCounts()) };
}

/** Coverage ratio for a subtree, 0..1. */
export function coverageRatio(node) {
  const counts = node?.counts;
  if (!counts || !counts.files) return 0;
  return counts.checked / counts.files;
}

/** Files beneath a directory (or the file itself). */
export function filesUnder(node) {
  if (!node) return [];
  if (node.kind === 'file') return [node];
  const result = [];
  walk(node, current => {
    if (current.kind === 'file') result.push(current);
  });
  return result;
}

/** Nodes in a subtree that carry findings, worst severity first. */
export function issueNodes(node) {
  return filesUnder(node)
    .filter(file => file.issues.length)
    .sort((left, right) => severityRank(left.maxSeverity) - severityRank(right.maxSeverity) || left.path.localeCompare(right.path));
}

export { severityRank };
