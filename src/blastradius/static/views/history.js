/**
 * History — saved scans and report comparison.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * Ported from the approved Swiss preview (preview.html): a three-card stat
 * strip, coverage caveats promoted above the table, then ONE flat diff-table
 * whose group header rows divide added / resolved / changed / unverified
 * findings. `changed` records carry a field-level base → head detail row
 * directly beneath them.
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

// Group header rows inside the flat diff-table, in report order.
const CATEGORIES = [
  { key: 'added', label: 'Added', sign: '+', delta: 'NEW' },
  { key: 'resolved', label: 'Resolved', sign: '−', delta: 'CLOSED' },
  { key: 'changed', label: 'Changed', sign: '~', delta: null },
  { key: 'unverified', label: 'Unverified', sign: '?', delta: 'UNVERIFIED' },
];

// Fields we diff for a "changed" record; everything else is summarised.
const DIFF_FIELDS = ['file', 'line', 'type', 'severity', 'target'];

// Guard rail: never paint an unbounded table.
const ROW_LIMIT = 100;

function pad2(value) {
  return String(value).padStart(2, '0');
}

/* ------------------------------------------------------------------ pieces */

function partialBadge(partial) {
  return partial
    ? el('span', { className: 'badge badge--unchecked', text: 'Partial' })
    : el('span', { className: 'badge badge--clean', text: 'Complete' });
}

function severityBadge(severity) {
  const value = severity || 'unknown';
  return el('span', { className: `badge badge--${value}`, text: value.toUpperCase() });
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
    className: 'btn',
    type: 'button',
    text: 'Compare scans',
    disabled: scans.length < 2,
  });
  wrapper.append(baseField, el('span', { className: 'compare-arrow', text: '→', attrs: { 'aria-hidden': 'true' } }), headField, button);
  return { wrapper, base, head, button };
}

/** Three-card strip: added / resolved / changed counts, monochrome. */
function summaryStrip(result, format) {
  const base = result.base_saved_id ?? result.base_id;
  const strip = el('div', { className: 'diff-summary' });
  for (const [key, value, note] of [
    ['Added', `+${format.number(result.summary?.added ?? 0)}`, 'New findings'],
    ['Resolved', `−${format.number(result.summary?.resolved ?? 0)}`, `Closed since ${format.shortId(base)}`],
    ['Changed', `~${format.number(result.summary?.changed ?? 0)}`, 'Identity updated'],
  ]) {
    const card = el('div', { className: `diff-card diff-card--${key.toLowerCase()}` });
    const v = el('div', { className: 'v' });
    v.append(document.createTextNode(value), el('span', { text: note }));
    card.append(el('div', { className: 'k', text: key }), v);
    strip.append(card);
  }
  return strip;
}

/** Coverage caveats, promoted above the table rather than buried as lines. */
function warningsBlock(result, format) {
  const warnings = result.warnings ?? [];
  const coverage = result.coverage ?? {};
  const noLonger = coverage.no_longer_checked ?? [];
  const newly = coverage.newly_checked ?? [];
  if (!warnings.length && !noLonger.length && !newly.length) return null;

  const box = el('div', { className: 'compare-warnings' });
  const head = el('div', { className: 'compare-warnings-head' });
  head.append(
    el('span', { className: 'compare-warnings-glyph', text: '⚠', attrs: { 'aria-hidden': 'true' } }),
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

/** Field-level base → head diff, one detail row spanning the whole table. */
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

/** The flat Swiss diff-table: group header rows divide the four categories. */
function comparisonTable(result, format) {
  const wrap = el('div', { className: 'table-scroll' });
  const table = el('table', { className: 'diff-table' });
  const headRow = el('tr');
  for (const label of ['Change', 'Path', 'Finding', 'Delta', 'Severity']) {
    headRow.append(el('th', { text: label, attrs: { scope: 'col' } }));
  }
  table.append(el('thead', {}, headRow));

  const capNotes = [];
  for (const category of CATEGORIES) {
    const records = result[category.key] ?? [];
    const tbody = el('tbody');

    const groupRow = el('tr', { className: 'diff-group' });
    const groupCell = el('th', { attrs: { colspan: '5', scope: 'colgroup' } });
    groupCell.append(document.createTextNode(category.label), el('span', { text: pad2(records.length) }));
    groupRow.append(groupCell);
    tbody.append(groupRow);

    if (!records.length) {
      const emptyRow = el('tr');
      const emptyCell = el('td', { attrs: { colspan: '5' } });
      emptyCell.append(el('span', { className: 'diff-empty-note', text: 'None in this comparison.' }));
      emptyRow.append(emptyCell);
      tbody.append(emptyRow);
    }

    for (const record of records.slice(0, ROW_LIMIT)) {
      const issue = category.key === 'changed' ? (record.head ?? {}) : (record ?? {});
      const row = el('tr', { className: `compare-row ${category.key}` });

      const change = el('td', {});
      change.append(el('span', { className: 'diff-sign', text: category.sign }));

      const path = el('td', { className: 'path' });
      path.append(
        document.createTextNode(issue.file ?? '—'),
        el('span', { className: 'loc', text: `:${format.number(issue.line ?? 0)}` }),
      );

      const delta = category.key === 'changed'
        ? (record.fields ?? []).map(field => field.toUpperCase()).join(' · ') || 'UPDATED'
        : category.delta;

      row.append(
        change,
        path,
        el('td', { text: issue.type ?? '—' }),
        el('td', { className: 'delta', text: delta }),
      );
      const sevCell = el('td', { className: 'sev' });
      sevCell.append(severityBadge(issue.severity));
      row.append(sevCell);
      tbody.append(row);

      if (category.key === 'changed') tbody.append(diffRow(record, format));
    }
    table.append(tbody);

    if (records.length > ROW_LIMIT) {
      capNotes.push(`Showing the first ${format.number(ROW_LIMIT)} of ${format.number(records.length)} ${category.label.toLowerCase()}.`);
    }
  }

  wrap.append(table);
  const fragment = el('div', { className: 'diff-table-cap' });
  for (const note of capNotes) {
    fragment.append(el('p', { className: 'note', text: `${note} Export JSON for the full comparison.` }));
  }
  fragment.prepend(wrap);
  return fragment;
}

function comparisonResult(result, format) {
  const fragment = el('div', { className: 'comparison-result' });
  fragment.append(summaryStrip(result, format));

  const warnings = warningsBlock(result, format);
  if (warnings) fragment.append(warnings);

  const base = result.base_saved_id ?? result.base_id;
  const head = result.head_saved_id ?? result.head_id;

  const panel = el('section', { className: 'panel diff-panel' });
  const panelHead = el('div', { className: 'panel-head' });
  const copy = el('div');
  copy.append(
    el('h2', { text: 'Scan diff' }),
    el('div', { className: 'panel-sub', text: 'Added, resolved and changed findings between two scans.' }),
  );
  panelHead.append(copy, el('span', { className: 'micro', text: `${format.shortId(base)} → ${format.shortId(head)}` }));
  panel.append(panelHead, comparisonTable(result, format));
  fragment.append(panel);
  return fragment;
}

function historySection(scans, format, onRefresh) {
  const section = el('section', { className: 'history-section' });
  const head = el('div', { className: 'history-section-head' });
  const refresh = el('button', { className: 'btn btn--ghost history-refresh', type: 'button', text: 'Refresh' });
  if (onRefresh) refresh.addEventListener('click', onRefresh);
  head.append(
    el('h2', { text: 'Saved scans' }),
    el('span', { className: 'count', text: `${pad2(scans.length)} SCANS` }),
    refresh,
  );
  section.append(head);

  for (const scan of scans) {
    const row = el('div', { className: 'history-row' });
    const main = el('div', { className: 'history-row-main' });
    main.append(
      el('span', { className: 'history-time mono', text: format.dateTime(scan.saved_at) }),
      el('span', { className: 'history-mode', text: format.modeLabel(scan.mode) }),
    );
    const meta = el('div', { className: 'history-row-meta' });
    meta.append(
      partialBadge(scan.partial),
      el('span', { className: 'history-id mono', text: format.shortId(scan.id) }),
    );
    row.append(main, meta);
    section.append(row);
  }
  return section;
}

/* ------------------------------------------------------------------ render */

export function render(container, ctx) {
  const { state, api, notify, setState, format } = ctx;
  const session = state.session;
  container.replaceChildren();

  if (!session?.persistence) {
    container.append(unconfiguredNote());
    return;
  }

  const cache = state.history;
  const note = el('p', { className: 'note' });
  const loading = el('p', { className: 'note', text: 'Loading this workspace’s saved scans…' });

  function paint(history, error) {
    container.replaceChildren(note);
    if (error) {
      note.textContent = error;
      return;
    }

    const scans = history?.scans ?? [];
    note.textContent = scans.length
      ? `${format.number(scans.length)} saved ${format.plural(scans.length, 'scan')} for ${history.project?.name ?? 'this workspace'}.`
      : 'No saved scans yet. Run a scan, then choose Save scan.';

    if (!scans.length) {
      container.append(emptyBlock('No saved scans', 'Save a scan to build a history you can compare.', '◷'));
      return;
    }

    const { wrapper, base, head, button } = compareControls(scans, format);
    container.append(wrapper);

    const output = el('div', { className: 'comparison-output' });
    container.append(output);

    button.addEventListener('click', async () => {
      button.disabled = true;
      output.replaceChildren(el('p', { className: 'note', text: 'Comparing saved scans…' }));
      try {
        const result = await api('/api/compare', { base: base.value, head: head.value });
        output.replaceChildren(comparisonResult(result, format));
      } catch (compareError) {
        notify(compareError.message);
        output.replaceChildren(el('p', { className: 'note', text: compareError.message }));
      } finally {
        button.disabled = false;
      }
    });

    container.append(historySection(scans, format, load));
  }

  async function load() {
    container.replaceChildren(note, loading);
    try {
      const history = await api('/api/history');
      // Storing the payload re-renders this view, which paints from the cache.
      setState({ history });
    } catch (error) {
      paint(cache, error.message);
    }
  }

  if (cache) paint(cache, null);
  else load();
}
