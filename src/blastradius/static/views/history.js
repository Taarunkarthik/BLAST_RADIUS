/**
 * History — saved scans and report comparison.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * Loads through ctx.api('/api/history') and compares through
 * ctx.api('/api/compare', {base, head}). The shell still gates the Save button
 * on session.persistence; this view explains why history is unavailable.
 *
 * Presentation rules: DOM + textContent only (no innerHTML), no inline styles
 * (the harness CSP allows stylesheets only). Every value passes through
 * ctx.format so numbers, severities, dates and ids read consistently with the
 * rest of the harness.
 */

import { el, emptyBlock } from '../lib/dom.js';

// Categories rendered as tables, in report order. Each carries its own accent.
const CATEGORIES = [
  { key: 'added', label: 'Added', hint: 'Findings present in the head scan but not the base.' },
  { key: 'resolved', label: 'Resolved', hint: 'Base findings absent from the head’s verified coverage.' },
  { key: 'changed', label: 'Changed', hint: 'The same finding with one or more modified fields.' },
  { key: 'unverified', label: 'Unverified', hint: 'Base findings the head scan could not verify.' },
];

// Order matches /api/compare summary keys so the strip reads like the CLI.
const SUMMARY_KEYS = ['added', 'resolved', 'changed', 'unchanged', 'unverified'];

// Fields we diff for a "changed" record; everything else is summarised.
const DIFF_FIELDS = ['file', 'line', 'type', 'severity', 'target'];

// Guard rails: never paint an unbounded table.
const ROW_LIMIT = 100;

/* ------------------------------------------------------------------ pieces */

function partialBadge(partial) {
  return el('span', {
    className: `badge ${partial ? 'partial' : 'complete'}`,
    text: partial ? 'Partial' : 'Complete',
  });
}

function severityBadge(severity) {
  const value = severity || 'unknown';
  return el('span', { className: `badge ${value}`, text: value });
}

function unconfiguredNote() {
  const block = el('div', { className: 'history-unconfigured' });
  block.append(
    el('span', { className: 'history-unconfigured-glyph', text: '◷', attrs: { 'aria-hidden': 'true' } }),
    el('h3', { text: 'Saved history is not configured' }),
    el('p', {
      text: 'Saving scans and comparing them over time needs PostgreSQL. Set BLASTRADIUS_DATABASE_URL, run the database migrations, and register this workspace with the CLI.',
    }),
    el('p', {
      className: 'note',
      text: 'Scanning, the dependency map and JSON export all keep working without a database.',
    }),
  );
  return block;
}

function compareControls(scans, format) {
  const wrapper = el('div', { className: 'compare-controls' });
  const base = el('select', { attrs: { 'aria-label': 'Base scan' } });
  const head = el('select', { attrs: { 'aria-label': 'Head scan' } });
  for (const scan of scans) {
    const label = [
      format.dateTime(scan.saved_at),
      format.modeLabel(scan.mode),
      format.shortId(scan.id),
      scan.partial ? 'partial' : null,
    ].filter(Boolean).join(' · ');
    for (const select of [base, head]) select.append(el('option', { value: scan.id, text: label }));
  }
  // Newest is index 0 (history is ordered by saved_at DESC), so default the
  // base to the previous scan and the head to the latest one.
  if (scans.length > 1) base.selectedIndex = 1;

  const baseField = el('div', { className: 'field' });
  baseField.append(el('label', { text: 'Base scan' }), base);
  const headField = el('div', { className: 'field' });
  headField.append(el('label', { text: 'Head scan' }), head);

  const button = el('button', {
    className: 'primary',
    type: 'button',
    text: 'Compare scans',
    disabled: scans.length < 2,
  });
  wrapper.append(baseField, el('span', { text: '→', attrs: { 'aria-hidden': 'true' } }), headField, button);
  return { wrapper, base, head, button };
}

/** Compact per-category counters. */
function summaryStrip(summary, format) {
  const strip = el('div', { className: 'compare-stats' });
  for (const key of SUMMARY_KEYS) {
    const stat = el('div', { className: `compare-stat ${key}` });
    stat.append(
      el('strong', { text: format.number(summary?.[key] ?? 0) }),
      el('span', { text: key }),
    );
    strip.append(stat);
  }
  return strip;
}

/** Coverage caveats, promoted above the tables rather than buried as lines. */
function warningsBlock(result, format) {
  const warnings = result.warnings ?? [];
  const coverage = result.coverage ?? {};
  const noLonger = coverage.no_longer_checked ?? [];
  const newly = coverage.newly_checked ?? [];
  if (!warnings.length && !noLonger.length && !newly.length) return null;

  const box = el('div', { className: `compare-warnings${result.partial ? ' partial' : ''}` });
  const head = el('div', { className: 'compare-warnings-head' });
  head.append(
    el('span', { text: '⚠', className: 'compare-warnings-glyph', attrs: { 'aria-hidden': 'true' } }),
    el('strong', { text: result.partial ? 'Partial comparison · coverage caveats' : 'Coverage caveats' }),
  );
  box.append(head);

  const list = el('ul', { className: 'compare-warnings-list' });
  for (const warning of warnings) list.append(el('li', { text: warning }));
  box.append(list);

  if (noLonger.length || newly.length) {
    const detail = el('div', { className: 'compare-coverage' });
    if (noLonger.length) {
      detail.append(el('p', {
        className: 'note',
        text: `${format.number(noLonger.length)} ${format.plural(noLonger.length, 'file')} no longer checked by the head scan.`,
      }));
    }
    if (newly.length) {
      detail.append(el('p', {
        className: 'note',
        text: `${format.number(newly.length)} ${format.plural(newly.length, 'file')} newly checked by the head scan.`,
      }));
    }
    box.append(detail);
  }
  return box;
}

/** Render a single diffed field value with the shared formatters. */
function fieldValue(field, value, format) {
  if (value === undefined || value === null || value === '') return '—';
  if (field === 'line') return format.number(value);
  if (field === 'severity') return format.severityLabel(value);
  if (field === 'file' || field === 'target') return format.truncate(String(value), 56);
  return String(value);
}

function issueCells(issue, format) {
  return [
    el('td', {}, severityBadge(issue.severity)),
    el('td', { className: 'mono compare-file', text: issue.file ?? '—' }),
    el('td', { className: 'mono', text: format.number(issue.line) }),
    el('td', { text: issue.type ?? '—' }),
    el('td', { className: 'mono', text: issue.target || '—' }),
  ];
}

/** Field-level base → head diff, one row spanning the whole table. */
function diffRow(record, format) {
  const row = el('tr', { className: 'diff-row' });
  const cell = el('td', { attrs: { colspan: '5' } });
  const changed = DIFF_FIELDS.filter(field => (record.fields ?? []).includes(field));

  if (!changed.length) {
    const extra = (record.fields ?? []).join(', ');
    cell.append(el('span', {
      className: 'note',
      text: extra ? `Fields changed: ${extra}` : 'Recorded as changed with no field detail.',
    }));
    row.append(cell);
    return row;
  }

  const list = el('ul', { className: 'diff-list' });
  for (const field of changed) {
    const item = el('li', { className: 'diff-item' });
    item.append(
      el('span', { className: 'diff-field', text: field }),
      el('span', { className: 'diff-from', text: fieldValue(field, record.base?.[field], format) }),
      el('span', { className: 'diff-arrow', text: '→', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'diff-to', text: fieldValue(field, record.head?.[field], format) }),
    );
    list.append(item);
  }
  cell.append(list);
  row.append(cell);
  return row;
}

function categoryTable(category, records, format) {
  const block = el('section', { className: `compare-group ${category.key}` });
  const heading = el('div', { className: 'compare-group-head' });
  heading.append(
    el('h3', { text: category.label }),
    el('span', { className: 'count', text: format.number(records.length) }),
  );
  block.append(heading, el('p', { className: 'note', text: category.hint }));

  if (!records.length) {
    block.append(el('p', { className: 'note compare-none', text: 'None' }));
    return block;
  }

  const wrap = el('div', { className: 'compare-table-wrap' });
  const table = el('table', { className: 'compare-table' });
  const thead = el('thead');
  const headRow = el('tr');
  for (const label of ['Severity', 'File', 'Line', 'Type', 'Target']) {
    headRow.append(el('th', { text: label, attrs: { scope: 'col' } }));
  }
  thead.append(headRow);

  const tbody = el('tbody');
  for (const record of records.slice(0, ROW_LIMIT)) {
    const issue = category.key === 'changed' ? record.head : record;
    const row = el('tr', { className: `compare-row ${category.key}` });
    row.append(...issueCells(issue ?? {}, format));
    tbody.append(row);
    if (category.key === 'changed') tbody.append(diffRow(record, format));
  }
  table.append(thead, tbody);
  wrap.append(table);
  block.append(wrap);

  if (records.length > ROW_LIMIT) {
    block.append(el('p', {
      className: 'note',
      text: `Showing the first ${format.number(ROW_LIMIT)} of ${format.number(records.length)} ${category.label.toLowerCase()} findings. Export JSON for the full comparison.`,
    }));
  }
  return block;
}

function comparisonResult(result, format) {
  const fragment = el('div', { className: 'comparison-result' });
  fragment.append(summaryStrip(result.summary, format));

  const warnings = warningsBlock(result, format);
  if (warnings) fragment.append(warnings);

  const base = result.base_saved_id ?? result.base_id;
  const head = result.head_saved_id ?? result.head_id;
  fragment.append(el('p', {
    className: 'note compare-meta',
    text: `Base ${format.shortId(base)} → Head ${format.shortId(head)}`,
  }));

  for (const category of CATEGORIES) {
    fragment.append(categoryTable(category, result[category.key] ?? [], format));
  }
  return fragment;
}

function historyList(scans, format) {
  const list = el('div', { className: 'history-list' });
  for (const scan of scans) {
    const row = el('div', { className: 'history-row' });
    const main = el('div', { className: 'history-row-main' });
    main.append(
      el('span', { className: 'history-time', text: format.dateTime(scan.saved_at) }),
      el('span', { className: 'history-mode', text: format.modeLabel(scan.mode) }),
    );
    const meta = el('div', { className: 'history-row-meta' });
    meta.append(
      partialBadge(scan.partial),
      el('span', { className: 'mono history-id', text: format.shortId(scan.id) }),
    );
    row.append(main, meta);
    list.append(row);
  }
  return list;
}

/* ------------------------------------------------------------------ render */

export function render(container, ctx) {
  const { state, api, notify, setState, format } = ctx;
  const session = state.session;
  container.replaceChildren();

  const shell = el('section', { className: 'panel history-panel' });
  const heading = el('div', { className: 'panel-heading' });
  const copy = el('div');
  copy.append(el('h2', { text: 'Saved scans' }), el('p', { text: 'Compare how this workspace changes over time' }));
  const refresh = el('button', { className: 'secondary', type: 'button', text: 'Refresh' });
  heading.append(copy, refresh);
  shell.append(heading);

  const body = el('div', { className: 'section-content' });
  shell.append(body);
  container.append(shell);

  if (!session?.persistence) {
    body.append(unconfiguredNote());
    return;
  }

  const cache = state.history;
  const note = el('p', { className: 'note' });
  const loading = el('p', { className: 'note', text: 'Loading this workspace’s saved scans…' });

  function paint(history, error) {
    body.replaceChildren(note);
    if (error) {
      note.textContent = error;
      return;
    }

    const scans = history?.scans ?? [];
    note.textContent = scans.length
      ? `${format.number(scans.length)} saved ${format.plural(scans.length, 'scan')} for ${history.project?.name ?? 'this workspace'}. Select a base and head to compare.`
      : 'No saved scans yet. Run a scan, then choose Save scan.';

    if (!scans.length) {
      body.append(emptyBlock('No saved scans', 'Save a scan to build a history you can compare.', '◷'));
      return;
    }

    const { wrapper, base, head, button } = compareControls(scans, format);
    body.append(wrapper);

    const output = el('div', { className: 'comparison-output' });
    body.append(output);

    button.addEventListener('click', async () => {
      button.disabled = true;
      output.replaceChildren(el('p', { className: 'note', text: 'Comparing saved scans…' }));
      try {
        const result = await api('/api/compare', { base: base.value, head: head.value });
        output.replaceChildren(comparisonResult(result, format));
      } catch (error) {
        notify(error.message);
        output.replaceChildren(el('p', { className: 'note', text: error.message }));
      } finally {
        button.disabled = false;
      }
    });

    body.append(historyList(scans, format));
  }

  async function load() {
    body.replaceChildren(note, loading);
    try {
      const history = await api('/api/history');
      // Storing the payload re-renders this view, which paints from the cache.
      setState({ history });
    } catch (error) {
      paint(cache, error.message);
    }
  }

  refresh.addEventListener('click', load);
  if (cache) paint(cache, null);
  else load();
}
