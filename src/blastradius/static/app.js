/**
 * BlastRadius browser harness — bootstrap and router only.
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
 * the shell (sidebar, scan form, notice, footer), read location.hash directly,
 * or keep module-level mutable UI state: the router re-renders on every state
 * change and on Back/Forward.
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
 *   }
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
 * ---------------------------------------------------------------------------
 */

import { api } from './lib/api.js';
import { createStore } from './lib/state.js';
import { node as makeNode, emptyState } from './lib/dom.js';
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
  overview: { module: overviewView, title: 'Repository health', subtitle: 'Find what’s broken. Understand what depends on it.' },
  findings: { module: findingsView, title: 'Findings', subtitle: 'Every diagnostic, with the dependency impact behind it.' },
  map: { module: mapView, title: 'Component map', subtitle: 'Every file as a tree node, with its import links and blast radius.' },
  dependencies: { module: dependenciesView, title: 'Dependency graph', subtitle: 'The JS/TS import graph and reverse blast radius, node by node.' },
  coverage: { module: coverageView, title: 'Coverage', subtitle: 'An explicit account of what was and was not checked.' },
  history: { module: historyView, title: 'Saved scans', subtitle: 'Compare how this workspace changes over time.' },
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

/* ------------------------------------------------------------------ notices */

function notify(message = '') {
  const notice = $('notice');
  notice.textContent = message;
  notice.hidden = !message;
}

/* ------------------------------------------------------------------ routing */

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
  title.replaceChildren(document.createTextNode(meta.title), makeNode('span', '.', 'accent'));
  $('page-subtitle').textContent = meta.subtitle;
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

    const state = store.get();
    syncChrome(state);

    const ctx = {
      state,
      api,
      node: makeNode,
      notify,
      format,
      tree,
      graph,
      setState: patch => store.set(patch),
      view,
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
    $('project-name').textContent = session.name;
    $('root-path').textContent = session.root;
    save.hidden = !session.persistence;
  }

  if (!report) {
    $('nav-count').textContent = '0';
    $('report-id').textContent = '';
    actions.hidden = true;
    $('footer-status').textContent = 'Waiting for a scan';
    return;
  }

  const scan = report.scan;
  const summary = report.summary;
  $('nav-count').textContent = format.number(summary.issues);
  $('nav-count').title = `${format.number(affectedFileCount(report))} affected files`;
  $('report-id').textContent = `SCAN ${scan.id}`;
  actions.hidden = false;
  $('footer-status').textContent = `${String(scan.mode).toUpperCase()} · ${scan.partial ? 'PARTIAL COVERAGE' : 'SCAN COMPLETE'}`;
}

/* ------------------------------------------------------------ shared events */

function wireScanForm() {
  $('scan-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('scan-button');
    const save = $('save-button');
    button.disabled = true;
    button.textContent = 'Scanning…';
    button.classList.add('busy');
    $('scan-state').textContent = 'Checking files and dependencies…';
    save.disabled = true;
    notify();
    try {
      const report = await api('/api/scan', {
        path: $('scan-path').value || '.',
        mode: $('scan-mode').value,
      });
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
      $('scan-state').textContent = report.scan.partial ? 'Partial coverage' : 'Scan complete';
      if (report.scan.partial || report.scan.graph_partial) {
        notify('This report has incomplete coverage or graph information. Open Coverage for the details.');
      }
      view(DEFAULT_ROUTE);
    } catch (error) {
      notify(error.message);
      $('scan-state').textContent = 'Scan did not complete';
    } finally {
      button.disabled = false;
      button.textContent = 'Run scan ↗';
      button.classList.remove('busy');
      save.disabled = false;
    }
  });
}

function wireNav() {
  document.querySelectorAll('[data-view]').forEach(button => {
    button.addEventListener('click', () => view(button.dataset.view));
  });
}

function wireActions() {
  $('export-button').addEventListener('click', () => {
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

  $('save-button').addEventListener('click', async () => {
    const report = store.get().report;
    if (!report) return;
    const button = $('save-button');
    button.disabled = true;
    try {
      const saved = await api('/api/save', { report_id: report.scan.id });
      notify(`Scan saved. ID: ${saved.id}`);
      store.set({ history: null });
    } catch (error) {
      notify(error.message);
    } finally {
      button.disabled = false;
    }
  });
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
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;

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
    case 'Enter':
      // Focused rows/buttons activate natively; otherwise open the selected finding.
      if (isInteractiveTarget(target)) return;
      event.preventDefault();
      const { selectedId } = store.get();
      if (selectedId) view('findings', selectedId);
      break;
  }
}

function wireKeyboard() {
  window.addEventListener('keydown', onGlobalKeyDown);
}

/* ------------------------------------------------------------- theme toggle */

const THEME_KEY = 'blastradius-theme';

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  const toggle = $('theme-toggle');
  if (toggle) {
    toggle.textContent = next === 'light' ? '☀' : '☾';
    toggle.setAttribute('aria-label', next === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    toggle.setAttribute('aria-pressed', next === 'light' ? 'true' : 'false');
  }
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Storage unavailable (private mode): the toggle still works for the session.
  }
}

function wireThemeToggle() {
  const toggle = $('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    });
  }
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    stored = null;
  }
  applyTheme(stored === 'light' ? 'light' : 'dark');
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

/* ---------------------------------------------------------------- bootstrap */

async function bootstrap() {
  wireNav();
  wireScanForm();
  wireActions();
  wireKeyboard();
  wireThemeToggle();
  wireSkipLink();

  window.addEventListener('hashchange', render);
  store.subscribe(() => {
    if (currentRoute) render();
  });

  try {
    const session = await api('/api/session');
    store.set({ session });
  } catch (error) {
    notify(error.message);
    $('scan-button').disabled = true;
  }

  // Restore the most recent in-memory report so reloads and deep links keep
  // working. A 404 simply means this harness process has not scanned yet.
  try {
    const report = await api('/api/report');
    if (report) {
      const selected = report.issues?.[0] ? format.issueId(report.issues[0]) : null;
      store.set({ report, selectedId: selected });
      $('scan-state').textContent = report.scan.partial ? 'Partial coverage' : 'Scan complete';
    }
  } catch (error) {
    if (error.status !== 404) notify(error.message);
  }

  if (!location.hash) {
    // Replace so the initial route does not add a spurious history entry.
    window.history.replaceState(null, '', hrefFor(DEFAULT_ROUTE));
  }
  render();
}

bootstrap();
