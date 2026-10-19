/**
 * Overview — dashboard for the current report.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * The dashboard is a roll-up, not another findings list: a metrics row, a
 * partial-scan banner, an inline SVG severity donut, the top blast radius
 * ranked by affected files, plus coverage and dependency-graph summaries.
 */

import { el, svg } from '../lib/dom.js';
import { issueId, number, percent, severityLabel } from '../lib/format.js';
import { buildTree } from '../lib/tree.js';
import { buildGraph, graphSummary, mostDependedOn, nodeLabel } from '../lib/graph.js';

const DONUT_RADIUS = 46;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;
const DONUT_MID = 60;

function affectedFiles(report) {
  const affected = new Set();
  for (const issue of report.issues ?? []) {
    if (!issue.impact?.has_tree_impact) continue;
    for (const file of issue.impact.direct_dependents ?? []) affected.add(file);
    for (const file of issue.impact.transitive_dependents ?? []) affected.add(file);
  }
  return affected;
}

function barClass(value, max) {
  if (!max) return 'w-0';
  const bucket = Math.min(100, Math.max(0, Math.round((value / max) * 20) * 5));
  return `w-${bucket}`;
}

function metric(label, value, detail, valueClass = '') {
  const card = el('article', { className: 'metric' });
  card.append(
    el('span', { text: label }),
    el('strong', { text: value, className: valueClass }),
    el('small', { text: detail }),
  );
  return card;
}

function panel(title, subtitle, ...children) {
  const section = el('article', { className: 'panel' });
  const heading = el('div', { className: 'panel-heading' });
  const copy = el('div');
  copy.append(el('h2', { text: title }), el('p', { text: subtitle }));
  heading.append(copy);
  section.append(heading, ...children);
  return section;
}

/**
 * Inline SVG donut of report.summary.{high,medium,low}. Position, dash
 * pattern and rotation are geometry attributes; every color comes from a CSS
 * class so the CSP never sees an inline style.
 */
function severityDonut(summary) {
  const total = (summary.high ?? 0) + (summary.medium ?? 0) + (summary.low ?? 0);
  const wrap = el('div', { className: 'overview-donut' });
  const canvas = svg('svg', {
    class: 'overview-donut-canvas',
    viewBox: `0 0 ${DONUT_MID * 2} ${DONUT_MID * 2}`,
    role: 'img',
    'aria-label': `Severity breakdown: ${number(summary.high)} high, ${number(summary.medium)} medium and ${number(summary.low)} low findings`,
  });
  canvas.append(svg('title', {}, 'Severity breakdown'));

  if (!total) {
    canvas.append(svg('circle', {
      class: 'donut-seg donut-empty',
      cx: DONUT_MID,
      cy: DONUT_MID,
      r: DONUT_RADIUS,
      'stroke-dasharray': `${DONUT_CIRCUMFERENCE} ${DONUT_CIRCUMFERENCE}`,
      transform: `rotate(-90 ${DONUT_MID} ${DONUT_MID})`,
    }));
  } else {
    const segments = [
      { level: 'high', value: summary.high },
      { level: 'medium', value: summary.medium },
      { level: 'low', value: summary.low },
    ].filter(segment => segment.value > 0);
    const gap = segments.length > 1 ? 2 : 0;
    let seen = 0;
    for (const segment of segments) {
      const length = (segment.value / total) * DONUT_CIRCUMFERENCE;
      canvas.append(svg('circle', {
        class: `donut-seg donut-${segment.level}`,
        cx: DONUT_MID,
        cy: DONUT_MID,
        r: DONUT_RADIUS,
        'stroke-dasharray': `${Math.max(0, length - gap)} ${DONUT_CIRCUMFERENCE}`,
        'stroke-dashoffset': `${-(seen / total) * DONUT_CIRCUMFERENCE}`,
        transform: `rotate(-90 ${DONUT_MID} ${DONUT_MID})`,
      }));
      seen += segment.value;
    }
  }

  canvas.append(svg('text', {
    class: 'donut-center',
    x: DONUT_MID,
    y: DONUT_MID + 6,
    'text-anchor': 'middle',
  }, number(total)));
  wrap.append(canvas);

  const legend = el('ul', { className: 'donut-legend' });
  for (const level of ['high', 'medium', 'low']) {
    const share = total ? (summary[level] / total) * 100 : 0;
    const item = el('li');
    item.append(
      el('span', { className: `donut-dot ${level}` }),
      el('span', { text: `${severityLabel(level)} · ${number(summary[level])}` }),
      el('span', { className: 'donut-share', text: percent(share) }),
    );
    legend.append(item);
  }
  wrap.append(legend);
  return wrap;
}

/** Banner shown when the scan could not cover every file or build the full graph. */
function partialScanBanner(ctx, scan) {
  const gaps = [];
  if (scan.partial) gaps.push('file coverage is incomplete');
  if (scan.graph_partial) gaps.push('the dependency graph is incomplete');
  if (!gaps.length) return null;
  const banner = el('div', { className: 'overview-banner', attrs: { role: 'status' } });
  banner.append(
    el('span', { className: 'overview-banner-mark', text: '⚠', attrs: { 'aria-hidden': 'true' } }),
    el('div', { className: 'overview-banner-copy' },
      el('strong', { text: 'Partial scan — impact numbers may be understated' }),
      el('p', {
        text: `This report has ${gaps.join(' and ')}, so blast-radius counts can understate the real reach of a failure. Open Coverage for the full account.`,
      }),
    ),
    el('button', {
      className: 'secondary',
      type: 'button',
      text: 'Review coverage →',
      on: { click: () => ctx.view('coverage') },
    }),
  );
  return banner;
}

export function render(container, ctx) {
  const { state, format } = ctx;
  const report = state.report;
  container.replaceChildren();

  if (!report) {
    const welcome = el('section', { className: 'panel overview-welcome' });
    welcome.append(
      el('div', { className: 'overview-welcome-mark', text: '◎', attrs: { 'aria-hidden': 'true' } }),
      el('h2', { text: 'Start with a scan' }),
      el('p', {
        text: 'Choose a directory inside this workspace and run a scan. BlastRadius maps syntax and dependency problems to the files that depend on them — without changing a single file.',
      }),
    );
    const steps = el('ol', { className: 'overview-steps' });
    for (const [title, body] of [
      ['Scan', 'Pick a directory and a scan mode above.'],
      ['Inspect', 'Open Findings to follow a diagnostic through the dependency tree.'],
      ['Explore', 'Use Map and Dependencies to see the graph behind the impact.'],
    ]) {
      const item = el('li');
      item.append(el('strong', { text: title }), el('span', { text: body }));
      steps.append(item);
    }
    welcome.append(steps);
    container.append(welcome);
    return;
  }

  const scan = report.scan;
  const summary = report.summary;
  const affected = affectedFiles(report);
  const graph = report.graph ? buildGraph(report.graph) : null;
  const graphStats = graphSummary(report.graph);
  const tree = buildTree(scan, report.issues);

  const banner = partialScanBanner(ctx, scan);
  if (banner) container.append(banner);

  const metrics = el('section', { className: 'metrics', attrs: { 'aria-label': 'Scan summary' } });
  metrics.append(
    metric('Files checked', number(scan.files_checked), `${number(scan.files_discovered)} discovered · ${number(scan.not_checked_count)} unsupported`),
    metric('Issues found', number(summary.issues), `${number(summary.medium)} medium · ${number(summary.low)} low`),
    metric('High severity', number(summary.high), 'Broken syntax or dependencies', 'high-text'),
    metric('Affected files', scan.mode === 'health' ? '—' : number(affected.size), 'Unique dependent JS/TS files'),
  );
  container.append(metrics);

  const grid = el('div', { className: 'overview-grid' });

  const severity = panel('Severity breakdown', 'Where the report needs attention');
  const severityBody = el('div', { className: 'overview-body' });
  severityBody.append(severityDonut(summary), el('p', {
    text: summary.issues
      ? `${percent((summary.high / (summary.issues || 1)) * 100)} of findings are high severity.`
      : 'No findings were reported for this scan.',
    className: 'note',
  }));
  severity.append(severityBody);
  grid.append(severity);

  const top = panel('Top blast radius', 'Failures ranked by the files they can break');
  const topBody = el('div', { className: 'overview-body overview-impact-list' });
  const impacted = (report.issues ?? [])
    .filter(issue => issue.impact?.has_tree_impact)
    .sort((left, right) =>
      (right.impact.affected_count ?? 0) - (left.impact.affected_count ?? 0)
      || String(left.file ?? '').localeCompare(String(right.file ?? ''))
      || (left.line ?? 0) - (right.line ?? 0))
    .slice(0, 5);
  if (!impacted.length) {
    topBody.append(el('p', {
      text: scan.mode === 'health' ? 'Tree impact is disabled in health mode.' : 'No finding affects another checked file.',
      className: 'note',
    }));
  } else {
    impacted.forEach((issue, index) => {
      const impact = issue.impact ?? {};
      const button = el('button', {
        className: 'overview-impact',
        type: 'button',
        on: { click: () => ctx.view('findings', issueId(issue)) },
      });
      const row = el('span', { className: 'overview-impact-row' });
      row.append(
        el('span', { className: 'overview-impact-rank', text: String(index + 1), attrs: { 'aria-hidden': 'true' } }),
        el('span', { text: `${issue.file}:${issue.line}`, className: 'overview-finding-file' }),
        el('span', { text: issue.type, className: 'overview-impact-type' }),
      );
      button.append(row, el('span', {
        text: `${number(impact.affected_count)} / ${number(impact.eligible_count)} eligible · ${impact.impact_percentage}%`,
        className: 'overview-impact-metric',
      }));
      topBody.append(button);
    });
  }
  top.append(topBody);
  grid.append(top);

  const coverageCounts = tree.counts;
  const coverage = panel('Coverage', 'Explicit about what was checked');
  const coverageBody = el('div', { className: 'overview-body' });
  const ratio = coverageCounts.files ? coverageCounts.checked / coverageCounts.files : 0;
  coverageBody.append(
    el('div', { className: 'overview-big', text: percent(ratio * 100) }),
    el('p', { text: `${number(coverageCounts.checked)} of ${number(coverageCounts.files)} known files checked`, className: 'note' }),
  );
  const coverageBar = el('div', { className: 'overview-bar' });
  coverageBar.append(el('span', { className: `overview-bar-fill checked ${barClass(coverageCounts.checked, coverageCounts.files || 1)}` }));
  coverageBody.append(coverageBar);
  const coverageFacts = el('div', { className: 'overview-facts' });
  for (const [label, value] of [
    ['Unsupported', coverageCounts.unchecked],
    ['Excluded', coverageCounts.excluded],
    ['Skipped', coverageCounts.skipped],
  ]) {
    const fact = el('div');
    fact.append(el('strong', { text: number(value) }), el('span', { text: label }));
    coverageFacts.append(fact);
  }
  coverageBody.append(coverageFacts);
  const coverageLink = el('button', {
    className: 'secondary',
    type: 'button',
    text: 'Open coverage →',
    on: { click: () => ctx.view('coverage') },
  });
  coverageBody.append(coverageLink);
  coverage.append(coverageBody);
  grid.append(coverage);

  const graphPanel = panel('Dependency graph', 'The JS/TS import graph behind tree impact');
  const graphBody = el('div', { className: 'overview-body' });
  if (!graph) {
    graphBody.append(el('p', { text: 'No dependency graph was built for this scan.', className: 'note' }));
  } else {
    const stats = el('div', { className: 'overview-facts' });
    for (const [label, value] of [
      ['Files', graphStats.files],
      ['Edges', graphStats.edges],
      ['Packages', graphStats.packages],
      ['Unresolved', graphStats.unresolved],
    ]) {
      const fact = el('div');
      fact.append(el('strong', { text: number(value) }), el('span', { text: label }));
      stats.append(fact);
    }
    graphBody.append(stats);
    const hubs = mostDependedOn(graph, 3);
    if (hubs.length) {
      const list = el('ul', { className: 'overview-hubs' });
      for (const hub of hubs) {
        list.append(el('li', { text: `${nodeLabel(hub.id)} — ${number(hub.dependents)} dependents` }));
      }
      graphBody.append(el('p', { text: 'Most depended-on files', className: 'overview-subhead' }), list);
    }
    graphBody.append(el('button', {
      className: 'secondary',
      type: 'button',
      text: 'Open map →',
      on: { click: () => ctx.view('map') },
    }));
  }
  graphPanel.append(graphBody);
  grid.append(graphPanel);

  container.append(grid);

  // format is part of the contract; use it for the scan identity line so the
  // dashboard never hand-rolls date handling.
  const meta = el('p', {
    className: 'note overview-meta',
    text: `Scan ${scan.id} · ${format.modeLabel(scan.mode)} · ${scan.partial ? 'partial coverage' : 'complete'}`,
  });
  container.append(meta);
}
