/**
 * Coverage — explicit account of what was checked, excluded and skipped.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * The summary strip is a tiny inline SVG (no libraries, no inline styles): the
 * stacked segments are sized from `report.scan` counts and coloured by class.
 * Every file row is a button that opens Findings (deep-linked to the file's
 * top finding) when there is one, otherwise the Map with `graphFocus` set.
 */

import { el, svg, emptyState } from '../lib/dom.js';
import { issueId, number, percent } from '../lib/format.js';

const PAGE = 200;

/** Accept a scan file entry as a string or a `{file, reason, ...}` object. */
function fileInfo(item, fallbackReason = '') {
  if (typeof item === 'string') return { file: item, reason: fallbackReason };
  return {
    file: item?.file ?? '',
    reason: item?.reason ?? fallbackReason,
    line: item?.line,
    target: item?.target,
  };
}

/** Map every file to the stable id of its highest-priority finding. */
function firstFindingByFile(report) {
  const map = new Map();
  for (const issue of report?.issues ?? []) {
    if (!issue?.file || map.has(issue.file)) continue;
    map.set(issue.file, issueId(issue));
  }
  return map;
}

/**
 * Row navigation: a file with findings opens Findings deep-linked to its top
 * finding; every other file opens the Map with that file focused. `graphFocus`
 * is set through state so the map view can pick it up (unknown ids are ignored).
 */
function openFile(ctx, file, findingId) {
  if (findingId) {
    ctx.view('findings', findingId);
    return;
  }
  ctx.setState({ graphFocus: ctx.graph.nodeId(file) });
  ctx.view('map');
}

/** Compact summary: checked ratio bar plus checked/unsupported/excluded/skipped. */
function summary(scan, excludedCount, skippedCount) {
  const discovered = Number(scan.files_discovered) || 0;
  const checked = Number(scan.files_checked) || 0;
  const unsupported = Number(scan.not_checked_count) || 0;
  const ratio = discovered > 0 ? checked / discovered : 0;

  const box = el('div', { className: 'coverage-summary' });

  const head = el('div', { className: 'coverage-summary-head' });
  const ratioBlock = el('div', { className: 'coverage-ratio' });
  ratioBlock.append(
    el('strong', { text: percent(ratio * 100), className: 'coverage-ratio-value' }),
    el('span', { text: `of ${number(discovered)} discovered files checked`, className: 'coverage-ratio-label' }),
  );
  head.append(ratioBlock);
  if (scan.partial) head.append(el('span', { className: 'pill', text: 'Partial coverage' }));
  box.append(head);

  const bar = svg('svg', {
    class: 'coverage-bar',
    viewBox: '0 0 100 10',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `Coverage: ${number(checked)} of ${number(discovered)} discovered files checked (${percent(ratio * 100)})`,
  });
  bar.append(svg('title', {}, 'Coverage breakdown'));
  let offset = 0;
  for (const [className, value] of [
    ['checked', checked],
    ['unsupported', unsupported],
    ['excluded', excludedCount],
    ['skipped', skippedCount],
  ]) {
    if (value <= 0 || discovered <= 0) continue;
    const width = (value / discovered) * 100;
    bar.append(svg('rect', { x: offset, y: 0, width, height: 10, class: `coverage-bar-seg ${className}` }));
    offset += width;
  }
  const track = el('div', { className: 'coverage-bar-track' });
  track.append(bar);
  box.append(track);

  const legend = el('ul', { className: 'coverage-legend' });
  for (const [label, value, className] of [
    ['Checked', checked, 'checked'],
    ['Unsupported', unsupported, 'unsupported'],
    ['Excluded', excludedCount, 'excluded'],
    ['Skipped', skippedCount, 'skipped'],
  ]) {
    const item = el('li', { className: 'coverage-legend-item' });
    item.append(
      el('span', { className: `coverage-swatch ${className}`, attrs: { 'aria-hidden': 'true' } }),
      el('strong', { text: number(value) }),
      el('span', { text: label, className: 'coverage-legend-label' }),
    );
    legend.append(item);
  }
  const total = el('li', { className: 'coverage-legend-item coverage-legend-total' });
  total.append(el('strong', { text: number(discovered) }), el('span', { text: 'Discovered', className: 'coverage-legend-label' }));
  legend.append(total);
  box.append(legend);

  return box;
}

function group(title, subtitle, items, renderRow) {
  const block = el('div', { className: 'coverage-group' });
  block.append(el('h3', { text: `${title} (${number(items.length)})` }));
  if (subtitle) block.append(el('p', { className: 'note', text: subtitle }));
  if (!items.length) block.append(el('p', { text: 'None', className: 'note' }));
  for (const item of items.slice(0, PAGE)) block.append(renderRow(item));
  if (items.length > PAGE) {
    block.append(el('p', { text: `Showing ${PAGE} entries. Export JSON for the complete list.`, className: 'note' }));
  }
  return block;
}

/** A clickable file row: opens Findings when the file has one, else the Map. */
function fileRow(item, ctx, findings) {
  const info = fileInfo(item);
  const findingId = findings.get(info.file) ?? null;
  const reason = [info.reason, info.target ? `target ${info.target}` : '', info.line ? `line ${info.line}` : '']
    .filter(Boolean)
    .join(' · ');

  const meta = el('span', { className: 'coverage-side' });
  meta.append(
    el('span', { className: 'coverage-reason', text: reason }),
    el('span', { className: `coverage-hint${findingId ? ' has-findings' : ''}`, text: findingId ? 'Findings →' : 'Locate →' }),
  );

  return el('button', {
    className: 'coverage-row coverage-row-link',
    type: 'button',
    title: `${info.file} — open ${findingId ? 'findings' : 'in the dependency map'}`,
    attrs: { 'aria-label': `${info.file}: open ${findingId ? 'findings' : 'dependency map'}` },
    on: { click: () => openFile(ctx, info.file, findingId) },
  }, el('span', { className: 'coverage-file mono', text: info.file }), meta);
}

export function render(container, ctx) {
  const report = ctx.state.report;
  container.replaceChildren();

  const shell = el('section', { className: 'panel coverage-panel' });
  const heading = el('div', { className: 'panel-heading' });
  const copy = el('div');
  copy.append(el('h2', { text: 'Coverage' }), el('p', { text: 'A clear account of what was checked and what was not' }));
  heading.append(copy);
  shell.append(heading);

  const body = el('div', { className: 'section-content' });

  if (!report) {
    emptyState(body, 'Run a scan to inspect coverage', 'Coverage lists checked, unsupported, excluded and skipped files for the current scan.');
    shell.append(body);
    container.append(shell);
    return;
  }

  const scan = report.scan ?? {};
  const checked = (scan.checked_files ?? []).map(file => ({ file, reason: 'Checked' }));
  const unsupported = (scan.not_checked_files ?? []).map(file => ({ file, reason: 'No configured checker' }));
  const excluded = (scan.excluded_files ?? []).map(item => fileInfo(item, 'Excluded'));
  const skipped = (scan.skipped_files ?? []).map(item => fileInfo(item, 'Skipped'));
  const limitations = (scan.limitations ?? []).map(item => fileInfo(item, 'Unresolved'));
  const findings = firstFindingByFile(report);

  body.append(summary(scan, excluded.length, skipped.length));

  const types = Object.entries(scan.not_checked_by_type ?? {});
  if (types.length) {
    body.append(group(
      'Unsupported by type',
      'File types with no configured checker',
      types,
      ([suffix, count]) => {
        const row = el('div', { className: 'coverage-row' });
        row.append(el('span', { text: suffix, className: 'mono' }), el('span', { text: `${number(count)} files` }));
        return row;
      },
    ));
  }

  body.append(el('p', {
    className: 'note coverage-hint-line',
    text: 'Select any file to open its findings, or to locate it on the dependency map.',
  }));

  body.append(
    group('Unsupported files', 'Discovered but not checked', unsupported, item => fileRow(item, ctx, findings)),
    group('Excluded files', 'Ignored or out of scope for this mode', excluded, item => fileRow(item, ctx, findings)),
    group('Incomplete checks', 'Read or limit problems', skipped, item => fileRow(item, ctx, findings)),
    group('Resolution limitations', 'Imports the scanner could not fully resolve', limitations, item => fileRow(item, ctx, findings)),
    group('Checked files', 'Files that contributed to this report', checked, item => fileRow(item, ctx, findings)),
  );

  if (scan.coverage_notes?.length) {
    body.append(el('h3', { text: 'Notes' }));
    const notes = el('ul', { className: 'coverage-notes' });
    for (const note of scan.coverage_notes) notes.append(el('li', { text: note }));
    body.append(notes);
  }

  shell.append(body);
  container.append(shell);
}
