/**
 * BlastRadius browser harness — shell, bootstrap and router.
 *
 * ---------------------------------------------------------------------------
 * VIEW CONTRACT
 * ---------------------------------------------------------------------------
 * Every module in views/ exports exactly one required entry point:
 *
 *   export function render(container, ctx)
 *
 * `container` is an empty HTMLElement owned by the router. The view must paint
 * it with DOM nodes (textContent / lib/dom.js helpers only — never innerHTML,
 * never inline styles) and may attach its own listeners. Views must not touch
 * the shell (rail, top bar, scan form, notice, status bar), read
 * location.hash directly, or keep module-level mutable UI state: the router
 * re-renders on every state change and on Back/Forward.
 *
 * `ctx` is:
 *   {
 *     state:    read-only snapshot of the store (see below),
 *     api:      (path, body?) => Promise<any>   // token header + error handling
 *     node:     (tag, text?, className?) => HTMLElement
 *     notify:   (message?) => void              // aria-live notice; '' hides it
 *     format:   lib/format.js namespace
 *     tree:     lib/tree.js namespace
 *     graph:    lib/graph.js namespace
 *     setState: (patch | (state) => patch) => void
 *     view:     (name, id?) => void             // router navigation / deep link
 *
 *   Additive shell extensions (safe to ignore; existing keys are unchanged):
 *     theme:        'light' | 'dark'            // active theme
 *     toggleTheme:  () => void                  // flip + persist the theme
 *     openPalette:  () => void                  // Ctrl/Cmd-K command palette
 *     project: {
 *       path:  string                           // scan path relative to the harness root
 *       label: string                           // display label, e.g. "examples / demo"
 *       open:  () => void                       // open the project switcher menu
 *     }
 *
 * State shape (all keys always present):
 *   report          object | null   last /api/scan or /api/report payload
 *   session         object | null   /api/session payload
 *   selectedId      string | null   stable finding id `file:line:type:target`
 *   filters         { query, severity, page }   findings search + pagination
 *   graphFocus      string | null   namespaced node id for Map
 *   dependencyFocus string | null   namespaced node id for Dependencies
 *   dependencyQuery string        Dependencies node filter
 *   history         object | null   last /api/history payload
 *
 * Routes: #overview, #findings, #findings/<encoded-id>, #map, #dependencies,
 * #coverage, #history. The router maps unknown routes to #overview.
 *
 * Theme: light is the default; the choice persists in localStorage under
 * `blastradius-theme`. The project switcher remembers folders under
 * `blastradius-recents` and the selected scan path under `blastradius-project`.
 * ---------------------------------------------------------------------------
 */

import { api } from './lib/api.js';
import { createStore } from './lib/state.js';
import { node as makeNode, emptyState } from './lib/dom.js';
import { createCommandPalette } from './lib/palette.js';
import * as format from './lib/format.js';
import * as tree from './lib/tree.js';
import * as graph from './lib/graph.js';

import * as overviewView from './views/overview.js';
import * as findingsView from './views/findings.js';
import * as mapView from './views/map.js';
import * as dependenciesView from './views/dependencies.js';
import * as coverageView from './views/coverage.js';
import * as historyView from './views/history.js';

const ROUTES = Object.freeze({
  overview: {
    module: overviewView,
    num: '01',
    name: 'Overview',
    title: 'Repository health',
    headline: 'What breaks',
    thin: 'when this changes?',
    subtitle: 'Find what’s broken. Understand what depends on it.',
  },
  findings: {
    module: findingsView,
    num: '02',
    name: 'Findings',
    title: 'Findings',
    headline: 'Every issue,',
    thin: 'pinned to a line.',
    subtitle: 'Every diagnostic, with the dependency impact behind it.',
  },
  map: {
    module: mapView,
    num: '03',
    name: 'Map',
    title: 'Component map',
    headline: 'Follow the blast',
    thin: 'through the tree.',
    subtitle: 'Every file as a tree node, with its import links and blast radius.',
  },
  dependencies: {
    module: dependenciesView,
    num: '04',
    name: 'Dependencies',
    title: 'Dependency graph',
    headline: 'Imports are',
    thin: 'liability edges.',
    subtitle: 'The JS/TS import graph and reverse blast radius, node by node.',
  },
  coverage: {
    module: coverageView,
    num: '05',
    name: 'Coverage',
    title: 'Coverage',
    headline: 'Say what was',
    thin: 'not looked at.',
    subtitle: 'An explicit account of what was and was not checked.',
  },
  history: {
    module: historyView,
    num: '06',
    name: 'Saved scans',
    title: 'Saved scans',
    headline: 'Change, measured',
    thin: 'between scans.',
    subtitle: 'Compare how this workspace changes over time.',
  },
});
const DEFAULT_ROUTE = 'overview';

const $ = id => document.getElementById(id);

const store = createStore({
  report: null,
  session: null,
  selectedId: null,
  filters: { query: '', severity: 'all', page: 0 },
  graphFocus: null,
  dependencyFocus: null,
  dependencyQuery: '',
  history: null,
});

const root = $('view-root');
let currentRoute = null;
let rendering = false;
let palette = null;

const THEME_KEY = 'blastradius-theme';
const PROJECT_KEY = 'blastradius-project';
const RECENTS_KEY = 'blastradius-recents';
const MAX_RECENTS = 6;

/* --------------------------------------------------------------- utilities */

function h(tag, className = '', text = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null && text !== undefined) element.textContent = String(text);
  return element;
}

function setText(id, text) {
  const element = typeof id === 'string' ? $(id) : id;
  if (element) element.textContent = String(text ?? '');
}

function shortId(value, length = 6) {
  return format.shortId(value, length).toUpperCase();
}

function scanStamp(scan) {
  if (scan?.created_at) {
    const date = new Date(scan.created_at);
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).toUpperCase();
    }
  }
  return 'LATEST REPORT';
}

function readStorage(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode): the shell still works per session.
  }
}

/* ------------------------------------------------------------------ notices */

function notify(message = '', kind = 'notice') {
  const notice = $('notice');
  if (!notice) return;
  if (!message) {
    notice.hidden = true;
    notice.classList.remove('is-busy');
    return;
  }
  setText('notice-title', kind === 'error' ? 'Error' : kind === 'busy' ? 'Working' : 'Notice');
  setText('notice-body', message);
  notice.hidden = false;
  notice.classList.toggle('is-busy', kind === 'busy');
}

function wireNotice() {
  const close = $('notice-close');
  if (close) close.addEventListener('click', () => notify(''));
}

/* ------------------------------------------------------------------- theme */

function currentTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(theme, persist = true) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;

  const toggle = $('theme-toggle');
  if (toggle) {
    const toDark = next === 'light';
    toggle.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
    toggle.setAttribute('aria-label', toDark ? 'Switch to dark theme' : 'Switch to light theme');
    setText('theme-label', toDark ? 'Dark' : 'Light');
  }

  if (persist) writeStorage(THEME_KEY, next);
}

function toggleTheme() {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

function wireThemeToggle() {
  const toggle = $('theme-toggle');
  if (toggle) toggle.addEventListener('click', toggleTheme);
  const stored = readStorage(THEME_KEY);
  applyTheme(stored === 'dark' ? 'dark' : 'light', false);
}

/* ----------------------------------------------------------------- routing */

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return { name: DEFAULT_ROUTE, param: null };
  const slash = raw.indexOf('/');
  const name = (slash === -1 ? raw : raw.slice(0, slash)).toLowerCase();
  const rest = slash === -1 ? '' : raw.slice(slash + 1);
  let param = null;
  if (rest) {
    try {
      param = decodeURIComponent(rest);
    } catch {
      param = rest;
    }
  }
  return { name: Object.hasOwn(ROUTES, name) ? name : DEFAULT_ROUTE, param };
}

function hrefFor(name, id = null) {
  return id ? `#${name}/${encodeURIComponent(id)}` : `#${name}`;
}

/**
 * Router entry used by views. Setting the hash triggers hashchange, which
 * performs the single render. If the target is already current we render
 * directly so re-selecting a finding still updates the detail panel.
 */
function view(name, id = null) {
  const target = Object.hasOwn(ROUTES, name) ? name : DEFAULT_ROUTE;
  const next = hrefFor(target, id);
  if (location.hash === next) {
    render();
    return;
  }
  location.hash = next;
}

function setActiveNav(name) {
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    // aria-current="false" is invalid; omit the attribute when not current.
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function setHeading(route) {
  const meta = ROUTES[route];
  const title = $('page-title');
  if (title) {
    const thin = makeNode('span', meta.thin, 'thin');
    const br = document.createElement('br');
    title.replaceChildren(document.createTextNode(meta.headline), br, thin);
  }
  setText('page-subtitle', meta.subtitle);
  setText('page-kicker-num', meta.num);
  setText('page-kicker-label', meta.name);
  setText('status-view', `View / ${meta.name}`);
  document.title = `${meta.title} · BlastRadius`;
}

function render() {
  // A view render may call setState (e.g. deep-link normalization). The
  // subscriber re-enters here; the outer render already paints the final state.
  if (rendering) return;
  rendering = true;
  try {
    const previous = currentRoute;
    const { name, param } = parseHash();
    const before = store.get();

    // Canonicalize unknown/empty routes without adding a history entry.
    const canonical = hrefFor(name, param);
    if (location.hash !== canonical) window.history.replaceState(null, '', canonical);

    // Deep links carry the finding id; a bare #findings keeps the last valid one.
    if (name === 'findings') {
      const requested = param ?? before.selectedId;
      const valid = requested && format.findIssue(before.report, requested) ? requested : null;
      if (before.selectedId !== valid) store.set({ selectedId: valid });
      // An unknown id in the URL is dropped so reloads do not keep a dead link.
      if (param && !valid) window.history.replaceState(null, '', hrefFor('findings'));
    }

    currentRoute = name;
    setActiveNav(name);
    setHeading(name);
    // Expose the route on <body> so a view can opt into a full-bleed layout
    // (the Dependencies graph hides the shell header/scan chrome and status bar).
    document.body.dataset.route = name;

    const state = store.get();
    syncChrome(state);

    const ctx = {
      state,
      api,
      node: makeNode,
      notify: message => notify(message),
      format,
      tree,
      graph,
      setState: patch => store.set(patch),
      view,
      // Additive shell extensions (see CONTRACT.md).
      theme: currentTheme(),
      toggleTheme,
      openPalette: () => palette?.open(),
      project: {
        path: projectPath,
        label: projectLabel(),
        open: () => openProjectMenu(true),
      },
    };

    try {
      ROUTES[name].module.render(root, ctx);
    } catch (error) {
      console.error(`BlastRadius view "${name}" failed to render`, error);
      emptyState(root, 'This view could not render', error.message ?? String(error), '⚠');
    }

    // The "/" shortcut and Escape both hand focus to the findings search once
    // the view has painted (the input may not exist yet when the route changes).
    if (focusFindingsSearch) {
      focusFindingsSearch = false;
      if (name === 'findings') {
        const search = root.querySelector('input[aria-label="Search findings"]');
        if (search) search.focus();
      }
    }

    // Only jump to the top on route changes; typing in a filter must not scroll.
    if (previous !== name) window.scrollTo({ top: 0, behavior: 'auto' });
  } finally {
    rendering = false;
  }
}

/* ------------------------------------------------------- shared chrome sync */

function affectedFileCount(report) {
  const affected = new Set();
  for (const issue of report.issues ?? []) {
    if (!issue.impact?.has_tree_impact) continue;
    for (const file of issue.impact.direct_dependents ?? []) affected.add(file);
    for (const file of issue.impact.transitive_dependents ?? []) affected.add(file);
  }
  return affected.size;
}

function syncChrome(state) {
  const report = state.report;
  const session = state.session;
  const actions = $('report-actions');
  const save = $('save-button');

  if (session) {
    setText('root-path', session.root);
    save.hidden = !session.persistence;
  }

  updateProjectLabel();

  if (!report) {
    setText('nav-count', '0');
    const count = $('nav-count');
    if (count) count.title = 'No findings';
    setText('report-id', '');
    if (actions) actions.hidden = true;
    setText('footer-status', 'Waiting for a scan');
    setText('rail-scan', 'No scan');
    setText('rail-issues', '—');
    setText('rail-checked', '—');
    setText('page-meta-strong', 'No scan loaded');
    setText('page-meta-note', 'Read-only analysis');
    setText('status-summary', 'No report');
    return;
  }

  const scan = report.scan;
  const summary = report.summary;
  const stamp = `Scan ${shortId(scan.id)}`;

  const count = $('nav-count');
  if (count) {
    count.textContent = format.number(summary.issues);
    count.title = `${format.number(affectedFileCount(report))} affected files`;
  }

  setText('report-id', stamp);
  if (actions) actions.hidden = false;
  setText('footer-status', `${format.modeLabel(scan.mode).toUpperCase()} · ${scan.partial ? 'PARTIAL COVERAGE' : 'SCAN COMPLETE'}`);
  setText('rail-scan', stamp);
  setText('rail-issues', format.number(summary.issues));
  setText('rail-checked', `${format.number(scan.files_checked)} / ${format.number(scan.files_discovered)}`);
  setText('page-meta-strong', `${stamp} · ${scanStamp(scan)}`);
  setText('page-meta-note', scan.partial ? 'Partial coverage' : 'Read-only analysis');
  setText('status-summary', `${format.number(scan.files_discovered)} discovered · ${format.number(scan.files_checked)} checked · ${format.number(summary.issues)} issues`);
}

/* ------------------------------------------------------------ scan actions */

function setScanBusy(busy) {
  const button = $('scan-button');
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle('busy', busy);
  button.textContent = busy ? 'Scanning…' : 'Run scan ↗';
}

function wireScanForm() {
  const form = $('scan-form');
  if (!form) return;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const path = ($('scan-path').value || '.').trim() || '.';
    const mode = $('scan-mode').value;
    setScanBusy(true);
    setText('scan-state', 'Checking files and dependencies…');
    notify(`Walking ${path} · resolving imports · checking references`, 'busy');
    const save = $('save-button');
    if (save) save.disabled = true;

    try {
      const report = await api('/api/scan', { path, mode });
      projectPath = normalizePath(path);
      writeStorage(PROJECT_KEY, projectPath);
      updateProjectLabel();
      const first = report.issues?.[0] ? format.issueId(report.issues[0]) : null;
      store.set({
        report,
        selectedId: first,
        filters: { query: '', severity: 'all', page: 0 },
        graphFocus: null,
        dependencyFocus: null,
        dependencyQuery: '',
        history: null,
      });
      setText('scan-state', report.scan.partial ? 'Partial coverage' : 'Scan complete');
      notify(
        `${format.number(report.summary.issues)} issues across ${format.number(report.scan.files_discovered)} discovered files`
        + (report.scan.not_checked_count
          ? ` · ${format.number(report.scan.not_checked_count)} unsupported file${report.scan.not_checked_count === 1 ? '' : 's'} skipped.`
          : '.'),
        'notice',
      );
      rememberRecent(path);
      view(DEFAULT_ROUTE);
    } catch (error) {
      notify(error.message, 'error');
      setText('scan-state', 'Scan did not complete');
    } finally {
      setScanBusy(false);
      if (save) save.disabled = false;
    }
  });
}

/* ---------------------------------------------------------- project switcher */

let projectPath = normalizePath(readStorage(PROJECT_KEY, '.'));
const browse = { path: null, data: null, error: null, loading: false };
let browseRequest = 0;

function normalizePath(value) {
  let next = String(value ?? '.').replace(/\\/g, '/').trim();
  while (next.startsWith('./')) next = next.slice(2);
  next = next.replace(/\/+$/, '');
  return next === '' ? '.' : next;
}

function displayPath(path) {
  const normalized = normalizePath(path);
  if (normalized === '.') return store.get().session?.name || 'workspace';
  return normalized.split('/').filter(Boolean).join(' / ');
}

function projectLabel() {
  return displayPath(projectPath);
}

function updateProjectLabel() {
  const label = projectLabel();
  setText('project-label', label);
  setText('project-name', label);
  setText('page-meta-path', label);
  const button = $('project-btn');
  if (button) button.setAttribute('aria-label', `Current project: ${label}. Switch project.`);

  const session = store.get().session;
  setText('status-path', session?.root ? `${session.root} · Offline` : 'Local workspace · Offline');
}

function readRecents() {
  try {
    const parsed = JSON.parse(readStorage(RECENTS_KEY, '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(item => (typeof item === 'string' ? { path: item, label: displayPath(item) } : item))
      .filter(item => item && typeof item.path === 'string')
      .map(item => ({ path: normalizePath(item.path), label: String(item.label ?? displayPath(item.path)) }))
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

function saveRecents(items) {
  writeStorage(RECENTS_KEY, JSON.stringify(items.slice(0, MAX_RECENTS)));
}

function rememberRecent(path) {
  const normalized = normalizePath(path);
  const label = normalized === '.' ? (store.get().session?.name || 'workspace root') : displayPath(normalized);
  const items = readRecents().filter(item => item.path !== normalized);
  items.unshift({ path: normalized, label });
  saveRecents(items);
}

function selectProject(path) {
  projectPath = normalizePath(path);
  writeStorage(PROJECT_KEY, projectPath);
  const input = $('scan-path');
  if (input) input.value = projectPath;
  updateProjectLabel();
  closeProjectMenu(false);
  notify(`Project set to ${projectLabel()}. Run a scan to load it.`);
}

function menuSection(heading) {
  const section = h('div', 'menu-section');
  section.append(h('div', 'menu-heading', heading));
  return section;
}

function menuButton(label, meta, onClick, current = false) {
  const button = h('button', current ? 'menu-item is-current' : 'menu-item');
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  if (current) button.setAttribute('aria-current', 'true');
  button.append(h('span', 'menu-label', label), h('span', 'meta', meta));
  button.addEventListener('click', onClick);
  return button;
}

function renderProjectMenu() {
  const menu = $('project-menu');
  if (!menu) return;
  menu.replaceChildren();

  const currentSection = menuSection('Current project');
  const current = h('div', 'menu-item is-static');
  const currentLabel = h('span', 'menu-label');
  currentLabel.append(h('span', 'mono', projectLabel()));
  current.append(currentLabel, h('span', 'meta', 'Read-only'));
  currentSection.append(current);
  menu.append(currentSection);

  const recentSection = menuSection('Recent folders');
  const recents = readRecents();
  if (!recents.length) {
    recentSection.append(h('div', 'menu-empty', 'No recent folders yet. Run a scan to remember one.'));
  } else {
    recents.forEach(item => {
      recentSection.append(menuButton(
        item.label || displayPath(item.path),
        item.path === projectPath ? 'Current' : 'Recent',
        () => selectProject(item.path),
        item.path === projectPath,
      ));
    });
  }
  menu.append(recentSection);

  const folderSection = h('div', 'menu-section');
  const head = h('div', 'menu-browse-head');
  const title = h('div', 'menu-heading', 'Browse folders');
  const pathLabel = h('span', 'path', browse.loading ? 'Loading…' : displayPath(browse.path ?? projectPath));
  head.append(title, pathLabel);
  folderSection.append(head);

  if (browse.error) {
    folderSection.append(h('div', 'menu-empty', `${browse.error} Recent folders still work.`));
  } else if (browse.loading) {
    folderSection.append(h('div', 'menu-empty', 'Reading folders…'));
  } else if (browse.data) {
    const nav = h('div', 'menu-browse-nav');
    if (browse.data.parent) {
      const up = h('button', 'btn btn--ghost', '↑ Up');
      up.type = 'button';
      up.addEventListener('click', () => loadDirectories(browse.data.parent));
      nav.append(up);
    }
    const home = h('button', 'btn btn--ghost', '⌂ Root');
    home.type = 'button';
    home.addEventListener('click', () => loadDirectories('.'));
    nav.append(home);
    folderSection.append(nav);

    if (!browse.data.directories.length) {
      folderSection.append(h('div', 'menu-empty', 'No subfolders here.'));
    } else {
      browse.data.directories.forEach(entry => {
        const button = h('button', 'menu-item');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        const label = h('span', 'menu-label');
        label.append(h('span', 'dir-mark', '▸'), document.createTextNode(entry.name));
        button.append(label, h('span', 'meta', 'Dir'));
        button.addEventListener('click', () => loadDirectories(entry.path));
        folderSection.append(button);
      });
    }

    const use = h('button', 'btn btn--solid menu-use');
    use.type = 'button';
    use.append(h('span', '', `Use ${displayPath(browse.data.path)}`), h('span', '', '↵'));
    use.addEventListener('click', () => selectProject(browse.data.path));
    folderSection.append(use);
  }
  menu.append(folderSection);
}

async function loadDirectories(path) {
  const request = ++browseRequest;
  browse.path = normalizePath(path);
  browse.data = null;
  browse.error = null;
  browse.loading = true;
  renderProjectMenu();

  try {
    const data = await api(`/api/directories?path=${encodeURIComponent(browse.path)}`);
    if (request !== browseRequest) return;
    browse.data = {
      path: normalizePath(data?.path ?? browse.path),
      parent: data?.parent == null ? null : normalizePath(data.parent),
      directories: Array.isArray(data?.directories) ? data.directories : [],
    };
    browse.error = null;
  } catch (error) {
    if (request !== browseRequest) return;
    browse.data = null;
    browse.error = error.status === 404
      ? 'Folder browsing is not available on this harness.'
      : error.message;
  } finally {
    if (request !== browseRequest) return;
    browse.loading = false;
    const menu = $('project-menu');
    if (menu && !menu.hidden) renderProjectMenu();
  }
}

function openProjectMenu(focusFirst = false) {
  const menu = $('project-menu');
  const button = $('project-btn');
  if (!menu || !button) return;
  browse.path = projectPath;
  browse.data = null;
  browse.error = null;
  browse.loading = true;
  renderProjectMenu();
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  if (focusFirst) {
    const first = menu.querySelector('button');
    if (first) first.focus();
  }
  loadDirectories(projectPath);
}

function closeProjectMenu(restoreFocus = false) {
  const menu = $('project-menu');
  const button = $('project-btn');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (button) {
    button.setAttribute('aria-expanded', 'false');
    if (restoreFocus) button.focus();
  }
}

function wireProjectSwitcher() {
  const button = $('project-btn');
  const menu = $('project-menu');
  if (!button || !menu) return;

  button.addEventListener('click', () => {
    if (menu.hidden) openProjectMenu(false);
    else closeProjectMenu(false);
  });

  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && menu.hidden) {
      event.preventDefault();
      openProjectMenu(true);
    }
  });

  document.addEventListener('click', event => {
    if (menu.hidden) return;
    if (menu.contains(event.target) || button.contains(event.target)) return;
    closeProjectMenu(false);
  });
}

/* ------------------------------------------------------------ shared events */

function wireNav() {
  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', () => view(button.dataset.view));
  });
}

function wireActions() {
  const exportButton = $('export-button');
  if (exportButton) {
    exportButton.addEventListener('click', () => {
      const report = store.get().report;
      if (!report) return;
      const url = URL.createObjectURL(new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' }));
      const link = makeNode('a');
      link.href = url;
      link.download = `blastradius-${report.scan.id}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  const saveButton = $('save-button');
  if (saveButton) {
    saveButton.addEventListener('click', async () => {
      const report = store.get().report;
      if (!report) return;
      saveButton.disabled = true;
      try {
        const saved = await api('/api/save', { report_id: report.scan.id });
        notify(`Scan saved. ID: ${saved.id}`);
        store.set({ history: null });
      } catch (error) {
        notify(error.message, 'error');
      } finally {
        saveButton.disabled = false;
      }
    });
  }
}

/* --------------------------------------------------------- keyboard shortcuts */

// Set by the "/" shortcut and Escape so render() can move focus to the
// findings search input once the view has painted.
let focusFindingsSearch = false;

function isTypingTarget(target) {
  return target instanceof HTMLElement && (
    target.tagName === 'INPUT' ||
    target.tagName === 'SELECT' ||
    target.tagName === 'TEXTAREA' ||
    target.isContentEditable
  );
}

/** Elements with their own activation behaviour; global keys must not double-fire. */
function isInteractiveTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (isTypingTarget(target)) return true;
  const tag = target.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') return true;
  const role = target.getAttribute('role');
  return Boolean(role && ['option', 'button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'treeitem'].includes(role));
}

/** Move the finding selection by one row in the visible, ordered list. */
function moveFindingSelection(delta) {
  const state = store.get();
  if (!state.report) return;
  const ids = findingsView.visibleIssueIds(state.report, state.filters);
  if (!ids.length) return;
  const current = state.selectedId ? ids.indexOf(state.selectedId) : -1;
  const next = Math.min(ids.length - 1, Math.max(0, current + delta));
  if (next !== current) store.set({ selectedId: ids[next] });
}

function onGlobalKeyDown(event) {
  // The palette owns Escape and arrow keys while it is open.
  if (palette?.isOpen()) return;
  if (event.defaultPrevented) return;

  const target = event.target;

  if (event.key === 'Escape') {
    const menu = $('project-menu');
    if (menu && !menu.hidden) {
      event.preventDefault();
      closeProjectMenu(true);
      return;
    }
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;

  // Escape is a command key, not a typing key: it clears the findings search
  // and the selection even while the search field itself has focus.
  if (event.key === 'Escape') {
    const state = store.get();
    const patch = {};
    if (state.filters.query) patch.filters = { ...state.filters, query: '' };
    if (state.selectedId) patch.selectedId = null;
    if (Object.keys(patch).length > 0) {
      if (target?.getAttribute?.('aria-label') === 'Search findings') focusFindingsSearch = true;
      store.set(patch);
    }
    return;
  }

  // Never hijack keys while the user is typing in a field.
  if (isTypingTarget(target)) return;

  switch (event.key) {
    case '/':
      event.preventDefault();
      if (currentRoute !== 'findings') {
        focusFindingsSearch = true;
        view('findings');
      } else {
        const search = root.querySelector('input[aria-label="Search findings"]');
        if (search) search.focus();
      }
      break;
    case 'ArrowDown':
    case 'j':
      event.preventDefault();
      moveFindingSelection(1);
      break;
    case 'ArrowUp':
    case 'k':
      event.preventDefault();
      moveFindingSelection(-1);
      break;
    case 'Enter': {
      // Focused rows/buttons activate natively; otherwise open the selected finding.
      if (isInteractiveTarget(target)) return;
      event.preventDefault();
      const { selectedId } = store.get();
      if (selectedId) view('findings', selectedId);
      break;
    }
    default:
      break;
  }
}

function wireKeyboard() {
  window.addEventListener('keydown', onGlobalKeyDown);
}

/* ---------------------------------------------------------------- skip link */

function wireSkipLink() {
  const skip = $('skip-link');
  if (!skip) return;
  // Prevent the anchor from rewriting location.hash (the router owns the hash).
  skip.addEventListener('click', event => {
    event.preventDefault();
    const main = $('main-content');
    if (main) {
      main.focus();
      main.scrollIntoView();
    }
  });
}

/* ----------------------------------------------------------- command palette */

function paletteCommands() {
  const commands = Object.entries(ROUTES).map(([id, meta]) => ({
    label: `Go to ${meta.name}`,
    meta: `${meta.num} / ${meta.name.toUpperCase()}`,
    keywords: id,
    run: () => view(id),
  }));

  commands.push({
    label: 'Toggle theme',
    meta: currentTheme() === 'dark' ? 'To light' : 'To dark',
    run: () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark'),
  });

  commands.push({
    label: 'Switch project',
    meta: projectLabel(),
    run: () => openProjectMenu(true),
  });

  commands.push({
    label: 'Run scan',
    meta: projectPath === '.' ? 'Workspace root' : displayPath(projectPath),
    run: () => $('scan-form')?.requestSubmit(),
  });

  if (store.get().report) {
    commands.push({
      label: 'Clear findings filters',
      meta: 'Reset search',
      run: () => {
        store.set({ filters: { query: '', severity: 'all', page: 0 } });
        view('findings');
      },
    });
  }

  return commands;
}

function wirePalette() {
  palette = createCommandPalette({
    getCommands: paletteCommands,
    onOpen: () => closeProjectMenu(false),
  });
}

/* ---------------------------------------------------------------- bootstrap */

async function bootstrap() {
  wireThemeToggle();
  wireNotice();
  wireNav();
  wireScanForm();
  wireActions();
  wireProjectSwitcher();
  wirePalette();
  wireKeyboard();
  wireSkipLink();
  updateProjectLabel();
  const initialPath = $('scan-path');
  if (initialPath) initialPath.value = projectPath;

  window.addEventListener('hashchange', render);
  store.subscribe(() => {
    if (currentRoute) render();
  });

  try {
    const session = await api('/api/session');
    store.set({ session });
    updateProjectLabel();
    if (!$('project-menu')?.hidden) renderProjectMenu();
  } catch (error) {
    notify(error.message, 'error');
    const scanButton = $('scan-button');
    if (scanButton) scanButton.disabled = true;
    setText('project-label', 'workspace');
    setText('project-name', 'workspace');
  }

  // Restore the most recent in-memory report so reloads and deep links keep
  // working. A 404 simply means this harness process has not scanned yet.
  try {
    const report = await api('/api/report');
    if (report) {
      const selected = report.issues?.[0] ? format.issueId(report.issues[0]) : null;
      store.set({ report, selectedId: selected });
      setText('scan-state', report.scan.partial ? 'Partial coverage' : 'Scan complete');
    }
  } catch (error) {
    if (error.status !== 404) notify(error.message, 'error');
  }

  if (!location.hash) {
    // Replace so the initial route does not add a spurious history entry.
    window.history.replaceState(null, '', hrefFor(DEFAULT_ROUTE));
  }
  render();
}

bootstrap();
