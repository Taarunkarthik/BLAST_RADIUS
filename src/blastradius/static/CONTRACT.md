# BlastRadius view contract

The browser harness is a dependency-free ES-module app. `app.js` is the shell and
router; every screen is an independent module under `views/` that one agent can
own without touching any other file.

## Module layout

```
static/
  index.html          shell markup: rail, top bar, scan strip, notice, #view-root, status bar
  app.js              bootstrap + hash router + shell chrome (no view markup)
  styles.css          design tokens + shared primitives + 12-column grid
  styles/shell.css    rail, top bar, project switcher, palette, notice, status bar
  lib/
    api.js            api(path, body) with X-BlastRadius-Token and error handling
    dom.js            node()/el()/svg()/append()/emptyState() — textContent only
    state.js          createStore(): get / set / subscribe
    format.js         numbers, severity, dates, issueId(), findIssue()
    tree.js           filesystem tree from scan coverage + issues
    graph.js          adjacency, reverse BFS blast radius, layered SVG layout
    palette.js        command palette behaviour (Ctrl/Cmd-K)
  views/
    overview.js       dashboard
    findings.js       full list + search/severity/pagination + tree-impact detail
    map.js            SVG dependency map
    dependencies.js   node inspector (imports / imported by)
    coverage.js       coverage report
    history.js        saved scans + compare
  styles/
    overview.css findings.css map.css dependencies.css coverage.css history.css
```

All files are served same-origin by `harness.py`: `/app.js`, `/styles.css` keep
working as before, and everything else is under `/static/…` via `StaticFiles`.
The CSP stays `script-src 'self'; style-src 'self'` — no inline scripts, no
inline styles, no external CDNs, no bundler.

## Required export

```js
export function render(container, ctx)
```

* `container` — an empty `HTMLElement` (`#view-root`) owned by the router. The
  view must replace its children and paint itself. It must not touch the shell
  (sidebar, scan form, notice, footer, `#report-actions`).
* The router re-renders the active view on every store change and on
  Back/Forward. Views are pure functions of `ctx.state` plus their own DOM
  listeners; keep no module-level mutable UI state.

Views may attach listeners to elements they created. Listeners may call
`ctx.setState` / `ctx.view`; both cause a re-render, so do not hold references
to DOM nodes across calls.

## ctx

| key | type | meaning |
| --- | --- | --- |
| `state` | object | read-only snapshot of the store (shape below) |
| `api` | `(path, body?) => Promise<any>` | same-origin JSON fetch, token header, throws `ApiError` with `.status` / `.data` |
| `node` | `(tag, text?, className?) => HTMLElement` | safe element helper (`textContent` only) |
| `notify` | `(message?) => void` | writes the aria-live notice; `''` hides it |
| `format` | namespace | `lib/format.js` |
| `tree` | namespace | `lib/tree.js` |
| `graph` | namespace | `lib/graph.js` |
| `setState` | `(patch \| (state) => patch) => void` | shallow-merged store update |
| `view` | `(name, id?) => void` | router navigation / deep link |
| `theme` | `'light' \| 'dark'` | active shell theme (additive, optional) |
| `toggleTheme` | `() => void` | flip + persist the theme (additive, optional) |
| `openPalette` | `() => void` | open the Ctrl/Cmd-K command palette (additive, optional) |
| `project` | `{ path, label, open }` | scan path relative to the harness root, display label, and `open()` for the project switcher (additive, optional) |

### Shell extensions

These keys are additive: existing views can ignore them and keep using the
original contract. They exist so new views can reach shell-level actions
without touching `location.hash`, `localStorage` or the rail directly.

```js
ctx.theme        // 'light' | 'dark'
ctx.toggleTheme  // function — flips the theme and persists it
ctx.openPalette  // function — opens the command palette
ctx.project      // { path: '.', label: 'demo', open: function }
```

The project switcher reads `GET /api/directories?path=<relative-path>`, which
returns `{ path, parent, directories: [{ name, path }] }` scoped to the harness
root. If the endpoint is missing (older harness) the menu degrades to the
localStorage recent-folder list and says so; the rest of the shell keeps working.

### State shape

```js
{
  report: null,            // /api/scan or /api/report payload
  session: null,           // /api/session payload
  selectedId: null,        // stable finding id: `file:line:type:target`
  filters: { query: '', severity: 'all', page: 0 },
  graphFocus: null,        // namespaced node id: file:/package:/unresolved:
  dependencyFocus: null,   // namespaced node id
  dependencyQuery: '',
  history: null            // last /api/history payload
}
```

## Routes

`#overview` (default), `#findings`, `#findings/<encodeURIComponent(issueId)>`,
`#map`, `#dependencies`, `#coverage`, `#history`. Unknown routes fall back to
`#overview`. Navigation uses `location.hash`, so browser Back/Forward work and
deep links survive reloads (the shell restores the last report from
`GET /api/report` on boot).

## Rules

1. **No HTML injection.** Build DOM with `lib/dom.js`; never assign `innerHTML`,
   `outerHTML` or `insertAdjacentHTML`. Report content is untrusted data.
2. **No inline styles.** The CSP blocks them. Use classes from the view's CSS
   file (e.g. `.w-25` for bar widths) or add a rule to that file.
3. **No new dependencies, no build step.** Plain ES modules only.
4. **No direct routing.** Read navigation state from `ctx.state`; navigate with
   `ctx.view(name, id)`. Do not read/write `location.hash` directly.
5. **Stable ids.** Select findings by `format.issueId(issue)`, never by object
   identity, so deep links and restored reports agree.
6. **Own only your files.** A view agent edits `views/<name>.js` and
   `styles/<name>.css`. Shared changes belong in `lib/` (architect-owned).
7. **Read-only.** No view may write to the scanned repository; the only writes
   are the existing `/api/save` and `/api/compare` calls.
