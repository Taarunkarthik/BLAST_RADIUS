/**
 * Overview — Swiss impact-first dashboard.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * Ported from preview.html (the design source of truth). The dashboard is a
 * roll-up of the current report, not another findings list:
 *
 *   1. Metric strip on the 12-column grid (files checked, issues, high
 *      severity, affected files).
 *   2. Severity donut — inline SVG from report.summary.{high,medium,low}.
 *      Geometry lives in attributes; every colour comes from a CSS class.
 *   3. "Top blast radius" leaderboard — issues with impact.has_tree_impact,
 *      ranked by affected_count (tie-break: file). Rows deep-link to the
 *      finding via ctx.view('findings', format.issueId(issue)).
 *   4. Coverage bar — checked vs unsupported, from report.scan.
 *   5. Partial-scan banner when scan.partial || scan.graph_partial.
 *
 * Strictly black / white / grey except on severity elements (donut segments,
 * swatches, the severity stack). border-radius is 0, no shadows, monospace for
 * paths and numbers, and only tokens from styles.css are used.
 */

import { el, svg } from '../lib/dom.js';
import { issueId, number, percent, severityLabel, shortId, truncate } from '../lib/format.js';

const DONUT_SIZE = 200;
const DONUT_RADIUS = 76;
const DONUT_GAP = 1.2;
const MAX_LEADER_ROWS = 5;
const MAX_BLAST_CELLS = 16;

function pad2(value) {
  return String(value ?? 0).padStart(2, '0');
}

/** Width bucket class (w-0 … w-100 in 5% steps) for class-only bar widths. */
function widthBucket(share) {
  const clamped = Math.min(100, Math.max(0, Math.round(share)));
  return `w-${Math.min(100, Math.round(clamped / 5) * 5)}`;
}

/** Unique dependent files across every tree-impact issue. */
function affectedFiles(report) {
  const affected = new Set();
  for (const issue of report.issues ?? []) {
    if (!issue?.impact?.has_tree_impact) continue;
    for (const file of issue.impact.direct_dependents ?? []) affected.add(file);
    for (const file of issue.impact.transitive_dependents ?? []) affected.add(file);
  }
  return affected;
}

/** Tree-impact issues ranked by affected_count desc, tie-break file asc. */
function rankByBlast(issues) {
  return (issues ?? [])
    .filter(issue => issue?.impact?.has_tree_impact)
    .sort((left, right) =>
      (right.impact?.affected_count ?? 0) - (left.impact?.affected_count ?? 0)
      || String(left.file ?? '').localeCompare(String(right.file ?? '')))
    .slice(0, MAX_LEADER_ROWS);
}

function summaryTotals(summary) {
  return (summary?.high ?? 0) + (summary?.medium ?? 0) + (summary?.low ?? 0);
}

/* ------------------------------------------------------------------ pieces */

/**
 * Metric card on the 12-column grid. `valueParts` is either a plain string or
 * an array of parts (`{ text, denom }` renders the smaller `/10` suffix).
 * `extra` (the severity stack) slots between the value and the note.
 */
function metricCard(label, valueParts, note, flag, extra = null) {
  const card = el('article', { className: 'metric' });
  const head = el('div', { className: 'metric-head' });
  head.append(
    el('span', { className: 'metric-label', text: label }),
    el('span', { className: 'metric-flag', text: flag || '' }),
  );
  const value = el('div', { className: 'metric-value' });
  if (Array.isArray(valueParts)) {
    for (const part of valueParts) {
      if (!part) continue;
      value.append(el('span', part.denom ? { className: 'denom', text: part.text } : { text: part.text }));
    }
  } else {
    value.append(el('span', { text: valueParts }));
  }
  card.append(head, value);
  if (extra) card.append(extra);
  card.append(el('div', { className: 'metric-note', text: note }));
  return card;
}

/** Severity split for the issues metric — width buckets, no inline styles. */
function severityStack(summary) {
  const stack = el('div', { className: 'stack', attrs: { 'aria-hidden': 'true' } });
  const total = summaryTotals(summary);
  const shares = ['high', 'medium', 'low'].map(level => ({
    level,
    share: total ? ((summary?.[level] ?? 0) / total) * 100 : 0,
  }));
  // Round high/medium to 5% buckets and give low the remainder so the three
  // spans always fill the track exactly. With no issues every bucket is 0.
  let used = 0;
  shares.forEach((segment, index) => {
    const bucket = !total ? 0 : index === shares.length - 1
      ? Math.max(0, 100 - used)
      : Math.min(100 - used, Math.round(segment.share / 5) * 5);
    used += bucket;
    stack.append(el('span', { className: `${segment.level} ${widthBucket(bucket)}` }));
  });
  return stack;
}

function panelHead(title, sub, meta) {
  const head = el('div', { className: 'panel-head' });
  const wrap = el('div');
  wrap.append(
    el('h2', { text: title }),
    el('div', { className: 'panel-sub', text: sub }),
  );
  head.append(wrap, el('span', { className: 'micro', text: meta }));
  return head;
}

/**
 * Inline SVG donut of report.summary.{high,medium,low}. Position, dash pattern
 * and rotation are geometry attributes; every colour comes from a CSS class so
 * the CSP never sees an inline style.
 */
function severityDonut(summary) {
  const total = summaryTotals(summary);
  const canvas = svg('svg', {
    class: 'donut-svg',
    viewBox: `0 0 ${DONUT_SIZE} ${DONUT_SIZE}`,
    role: 'img',
    'aria-label': `Severity distribution: ${number(summary?.high ?? 0)} high, ${number(summary?.medium ?? 0)} medium and ${number(summary?.low ?? 0)} low.`,
  });

  if (!total) {
    canvas.append(svg('circle', {
      class: 'donut-seg donut-empty',
      cx: DONUT_SIZE / 2,
      cy: DONUT_SIZE / 2,
      r: DONUT_RADIUS,
      'stroke-dasharray': '100 0',
      pathLength: 100,
      transform: `rotate(-90 ${DONUT_SIZE / 2} ${DONUT_SIZE / 2})`,
    }));
  } else {
    const segments = [
      { level: 'high', value: summary?.high ?? 0 },
      { level: 'medium', value: summary?.medium ?? 0 },
      { level: 'low', value: summary?.low ?? 0 },
    ].filter(segment => segment.value > 0);
    const gap = segments.length > 1 ? DONUT_GAP : 0;
    let offset = 0;
    for (const segment of segments) {
      const portion = (segment.value / total) * 100;
      const length = Math.max(portion - gap, 0.5);
      canvas.append(svg('circle', {
        class: `donut-seg donut-stroke-${segment.level}`,
        cx: DONUT_SIZE / 2,
        cy: DONUT_SIZE / 2,
        r: DONUT_RADIUS,
        'stroke-dasharray': `${length} ${100 - length}`,
        'stroke-dashoffset': -offset,
        pathLength: 100,
        transform: `rotate(-90 ${DONUT_SIZE / 2} ${DONUT_SIZE / 2})`,
      }));
      offset += portion;
    }
  }

  canvas.append(
    svg('text', {
      class: 'donut-center-value',
      x: DONUT_SIZE / 2,
      y: DONUT_SIZE / 2 + 3,
      'text-anchor': 'middle',
    }, pad2(total)),
    svg('text', {
      class: 'donut-center-label',
      x: DONUT_SIZE / 2,
      y: DONUT_SIZE / 2 + 24,
      'text-anchor': 'middle',
    }, 'ISSUES'),
  );

  const legend = el('div', { className: 'donut-legend' });
  for (const level of ['high', 'medium', 'low']) {
    const share = total ? ((summary?.[level] ?? 0) / total) * 100 : 0;
    const row = el('div', { className: 'donut-row' });
    row.append(
      el('span', { className: `sev-swatch sev-${level}`, attrs: { 'aria-hidden': 'true' } }),
      el('span', { text: severityLabel(level) }),
      el('span', { className: 'count', text: pad2(summary?.[level] ?? 0) }),
      el('span', { className: 'pct', text: percent(share, 0) }),
    );
    legend.append(row);
  }

  const layout = el('div', { className: 'donut-layout' });
  layout.append(canvas, legend);
  return layout;
}

/** Leaderboard row: rank, file:line + type, blast scale, affected/eligible %. */
function leaderRow(issue, index, ctx) {
  const impact = issue.impact ?? {};
  const affected = impact.affected_count ?? 0;
  const eligible = impact.eligible_count ?? 0;
  const pct = impact.impact_percentage ?? 0;
  const row = el('button', {
    className: 'leader-row',
    type: 'button',
    on: { click: () => ctx.view('findings', issueId(issue)) },
    attrs: {
      'aria-label': `Open ${issue.file ?? ''}:${issue.line ?? 0} (${issue.type ?? 'issue'}) in findings. ${number(affected)} of ${number(eligible)} eligible files, ${pct}%.`,
    },
  });

  const main = el('span', { className: 'leader-main' });
  const path = el('span', { className: 'leader-path' });
  path.append(
    el('span', {
      className: `sev-swatch ${issue.severity ? `sev-${issue.severity}` : ''}`,
      attrs: { 'aria-hidden': 'true' },
    }),
    el('span', { text: `${issue.file ?? ''}:${issue.line ?? 0}` }),
  );
  main.append(path, el('span', { className: 'leader-note', text: issue.type ?? '' }));

  const scale = el('span', { className: 'blast-scale', attrs: { 'aria-hidden': 'true' } });
  const cells = Math.min(Math.max(eligible, 0), MAX_BLAST_CELLS);
  const filled = eligible > 0 ? Math.round((affected / eligible) * cells) : 0;
  for (let cell = 0; cell < cells; cell += 1) {
    scale.append(el('span', { className: cell < filled ? 'on' : '' }));
  }

  row.append(
    el('span', { className: 'leader-rank', text: pad2(index + 1), attrs: { 'aria-hidden': 'true' } }),
    main,
    scale,
    el('span', { className: 'leader-pct', text: `${number(affected)} / ${number(eligible)} · ${pct}%` }),
  );
  return row;
}

/** Banner shown when the scan could not cover every file or build the full graph. */
function partialScanBanner(ctx, scan) {
  const gaps = [];
  if (scan?.partial) gaps.push('file coverage is incomplete');
  if (scan?.graph_partial) gaps.push('the dependency graph is incomplete');
  if (!gaps.length) return null;
  return el('div', { className: 'overview-banner', attrs: { role: 'status' } },
    el('span', { className: 'overview-banner-mark', attrs: { 'aria-hidden': 'true' } }),
    el('div', { className: 'overview-banner-copy' },
      el('strong', { text: 'Partial scan — impact numbers may be understated' }),
      el('span', {
        text: `This report has ${gaps.join(' and ')}, so blast-radius counts can understate the real reach of a failure. Open Coverage for the full account.`,
      }),
    ),
    el('button', {
      className: 'btn btn--ghost',
      type: 'button',
      text: 'Review coverage →',
      on: { click: () => ctx.view('coverage') },
    }),
  );
}

/* ------------------------------------------------------------------- render */

export function render(container, ctx) {
  const { state, format } = ctx;
  const report = state.report;
  container.replaceChildren();

  if (!report) {
    const empty = el('div', { className: 'empty-state' });
    empty.append(
      el('span', { text: '◎', attrs: { 'aria-hidden': 'true' } }),
      el('h3', { text: 'Start with a scan' }),
      el('p', {
        text: 'Choose a directory in the top bar and run a scan. BlastRadius maps syntax and dependency problems to the files that depend on them — without changing a single file.',
      }),
    );
    container.append(empty);
    return;
  }

  const scan = report.scan ?? {};
  const summary = report.summary ?? {};
  const issues = report.issues ?? [];
  const affected = affectedFiles(report);
  const ranked = rankByBlast(issues);
  const top = ranked[0] ?? null;

  const banner = partialScanBanner(ctx, scan);
  if (banner) container.append(banner);

  /* 1 — metric strip on the 12-column grid */
  const checked = scan.files_checked ?? 0;
  const discovered = scan.files_discovered ?? 0;
  const checkedShare = discovered ? (checked / discovered) * 100 : 0;
  const metrics = el('section', { className: 'metric-grid metrics', attrs: { 'aria-label': 'Scan summary' } });
  metrics.append(
    metricCard(
      'Files checked',
      [{ text: number(checked) }, { text: `/${number(discovered)}`, denom: true }],
      `${percent(checkedShare)} of discovered files`,
      'COVERAGE',
    ),
    metricCard(
      'Issues found',
      number(summary.issues ?? 0),
      `${number(summary.medium ?? 0)} medium · ${number(summary.low ?? 0)} low · ${number(summary.high ?? 0)} high`,
      scan.id ? `SCAN ${shortId(scan.id, 6).toUpperCase()}` : 'SCAN',
      severityStack(summary),
    ),
    metricCard(
      'High severity',
      number(summary.high ?? 0),
      'Broken syntax or dependencies',
      '',
    ),
    metricCard(
      'Affected files',
      number(affected.size),
      top
        ? `${truncate(top.file ?? '', 28)} · ${top.impact?.impact_percentage ?? 0}% eligible`
        : 'No finding affects another checked file',
      'AFFECTED',
    ),
  );
  container.append(metrics);

  const grid = el('div', { className: 'grid12' });

  /* 2 — severity donut */
  const severityPanel = el('section', { className: 'col-4 panel panel--key' });
  severityPanel.append(
    panelHead('Severity distribution', 'Where the report needs attention.', `${pad2(summaryTotals(summary))} TOTAL`),
    severityDonut(summary),
  );
  grid.append(severityPanel);

  /* 3 — top blast radius leaderboard */
  const leaderPanel = el('section', { className: 'col-8 panel panel--key' });
  const leaderboard = el('div', { className: 'leaderboard' });
  const leaderHead = el('div', { className: 'leader-head' });
  leaderHead.append(
    el('span', { text: 'Rank', attrs: { 'aria-hidden': 'true' } }),
    el('span', { text: 'Module' }),
    el('span', { text: 'Blast', attrs: { 'aria-hidden': 'true' } }),
    el('span', { text: 'Affected', attrs: { 'aria-hidden': 'true' } }),
  );
  leaderboard.append(leaderHead);
  if (!ranked.length) {
    leaderboard.append(el('div', {
      className: 'leader-empty',
      text: scan.mode === 'health'
        ? 'Tree impact is disabled in health mode.'
        : 'No finding affects another checked file.',
    }));
  } else {
    ranked.forEach((issue, index) => leaderboard.append(leaderRow(issue, index, ctx)));
  }
  leaderPanel.append(
    panelHead(
      'Top blast radius',
      'Modules ranked by downstream files affected.',
      top
        ? `${pad2(top.impact?.affected_count ?? 0)} / ${pad2(top.impact?.eligible_count ?? 0)} ELIGIBLE`
        : '0 / 0 ELIGIBLE',
    ),
    leaderboard,
  );
  grid.append(leaderPanel);

  /* 4 — coverage bar (checked vs unsupported) */
  const unsupported = scan.not_checked_count ?? 0;
  const excluded = scan.excluded_files?.length ?? 0;
  const skipped = scan.skipped_files?.length ?? 0;
  const coveragePanel = el('section', { className: 'col-12 panel coverage-panel' });
  const coverageTop = el('div', { className: 'coverage-top' });
  const coverageBig = el('div', { className: 'coverage-big' });
  coverageBig.append(
    el('span', { text: percent(checkedShare) }),
    el('span', { className: 'denom', text: '%' }),
  );
  const coverageCopy = el('div');
  coverageCopy.append(
    el('div', { className: 'micro', text: 'Checked vs unsupported' }),
    el('div', {
      className: 'coverage-note',
      text: `${number(checked)} checked · ${number(unsupported)} unsupported · ${number(excluded)} excluded · ${number(skipped)} skipped`,
    }),
  );
  coverageTop.append(coverageBig, coverageCopy);

  // Class-based widths only: the checked span takes a 5% bucket, the
  // unsupported span flexes into the remainder — exact for any ratio.
  const bar = el('div', {
    className: 'coverage-bar',
    attrs: {
      role: 'img',
      'aria-label': `Coverage: ${number(checked)} of ${number(discovered)} files checked, ${number(unsupported)} unsupported.`,
    },
  });
  const checkedBucket = unsupported > 0
    ? Math.min(95, Math.round(checkedShare / 5) * 5)
    : Math.min(100, Math.round(checkedShare / 5) * 5);
  bar.append(el('span', { className: `checked ${widthBucket(checkedBucket)}` }));
  if (unsupported > 0) bar.append(el('span', { className: 'unsupported' }));

  const coverageMeta = el('div', { className: 'coverage-meta' });
  for (const [key, value] of [
    ['Checked', checked],
    ['Unsupported', unsupported],
    ['Discovered', discovered],
  ]) {
    const cell = el('div', { className: 'cov-cell' });
    cell.append(
      el('div', { className: 'key', text: key }),
      el('div', { className: 'val', text: number(value) }),
    );
    coverageMeta.append(cell);
  }

  coveragePanel.append(
    panelHead('Coverage', 'Explicit about what was checked.', `${pad2(checked)} / ${pad2(discovered)} FILES`),
    coverageTop,
    bar,
    coverageMeta,
  );
  grid.append(coveragePanel);

  container.append(grid);

  // format is part of the contract; use it for the scan identity line so the
  // dashboard never hand-rolls date or id handling.
  container.append(el('p', {
    className: 'note overview-meta',
    text: `Scan ${format.shortId(scan.id, 8)} · ${format.modeLabel(scan.mode)}${scan.partial || scan.graph_partial ? ' · partial coverage' : ' · complete'}`,
  }));
}
