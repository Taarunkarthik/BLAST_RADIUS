/**
 * Coverage — explicit account of what was checked, excluded and skipped.
 *
 * Contract: export function render(container, ctx)
 * ctx = { state, api, node, notify, format, tree, graph, setState, view }
 *
 * Ported from the approved Swiss preview (preview.html): a bordered summary
 * block with the checked ratio, a monochrome stacked bar and per-category
 * count lines, then bordered-topped groups of cov-tables. File rows are
 * clickable: files with findings deep-link into Findings, every other file
 * opens the Map with `graphFocus` set so the tree can centre it.
 *
 * Presentation rules: DOM + textContent only (no innerHTML), no inline styles
 * (the harness CSP allows stylesheets only). Every value passes through
 * ctx.format so numbers and ids read consistently with the rest of the
 * harness.
 */

import { el, svg, emptyState } from '../lib/dom.js';
import { issueId, number, percent, plural, severityRank, shortId } from '../lib/format.js';

// Guard rail: never paint an unbounded table.
const PAGE = 200;

function pad2(value) {
  return String(value).padStart(2, '0');
}

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

/** Per-file finding counts, for the Checked group's analysis column. */
function findingsByFile(report) {
  const counts = new Map();
  for (const issue of report?.issues ?? []) {
    if (!issue?.file) continue;
    counts.set(issue.file, (counts.get(issue.file) ?? 0) + 1);
  }
  return counts;
}

/** Map every file to the stable id of its highest-severity finding. */
function firstFindingByFile(report) {
  const ordered = [...(report?.issues ?? [])]
    .filter(issue => issue?.file)
    .sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const map = new Map();
  for (const issue of ordered) {
    if (!map.has(issue.file)) map.set(issue.file, issueId(issue));
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

/** Monochrome stacked bar: black checked, three greys for the rest. */
function coverageBar(discovered, checked, unsupported, excluded, skipped) {
  const label = `Coverage: ${number(checked)} of ${number(discovered)} discovered files checked (${percent((checked / Math.max(1, discovered)) * 100)})`;
  const track = el('div', { className: 'coverage-bar-track' });
  const bar = svg('svg', {
    class: 'coverage-bar',
    viewBox: '0 0 100 10',
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': label,
  });
  bar.append(svg('title', {}, 'Coverage breakdown'));
  let offset = 0;
  for (const [className, value] of [
    ['checked', checked],
    ['unsupported', unsupported],
    ['excluded', excluded],
    ['skipped', skipped],
  ]) {
    if (value <= 0 || discovered <= 0) continue;
    const width = (value / discovered) * 100;
    bar.append(svg('rect', { x: offset, y: 0, width, height: 10, class: `coverage-bar-seg ${className}` }));
    offset += width;
  }
  track.append(bar);
  return track;
}

/** Summary block: ratio headline, stacked bar and the per-category count lines. */
function summary(scan, excludedCount, skippedCount) {
  const discovered = Number(scan.files_discovered) || 0;
  const checked = Number(scan.files_checked) || 0;
  const unsupported = Number(scan.not_checked_count) || 0;
  const ratio = discovered > 0 ? checked / discovered : 0;

  const box = el('section', { className: 'coverage-summary' });
  const top = el('div', { className: 'coverage-summary-top' });

  const left = el('div');
  left.append(el('h2', { text: `Coverage / scan ${shortId(scan.id)}` }));
  const big = el('div', { className: 'big' });
  big.append(document.createTextNode(percent(ratio * 100)), el('small', { text: '%' }));
  left.append(big);

  const right = el('div', { className: 'coverage-summary-right' });
  right.append(coverageBar(discovered, checked, unsupported, excludedCount, skippedCount));
  const rest = [
    unsupported ? `${number(unsupported)} unsupported` : '',
    excludedCount ? `${number(excludedCount)} excluded` : '',
    skippedCount ? `${number(skippedCount)} skipped` : '',
  ].filter(Boolean);
  const ratioLine = el('div', { className: 'cov-line' });
  ratioLine.append(
    el('span', { text: `${number(checked)} checked` }),
    el('span', { text: rest.join(' · ') || (scan.partial ? 'Partial scan' : 'Complete scan') }),
  );
  right.append(ratioLine);

  top.append(left, right);
  box.append(top);

  const foot = el('div', { className: 'cov-line' });
  foot.append(
    el('span', { text: `${number(discovered)} discovered` }),
    el('span', { text: scan.partial ? 'Partial coverage' : 'Coverage is explicit' }),
  );
  box.append(foot);
  return box;
}

/** A clickable file row: opens Findings when the file has one, else the Map. */
function fileRow(item, ctx, firstFindings, issueCounts, status, fallbackReason) {
  const info = fileInfo(item);
  const findingId = firstFindings.get(info.file) ?? null;
  const issueCount = issueCounts.get(info.file) ?? 0;
  const reason = info.reason || fallbackReason || `${number(issueCount)} ${plural(issueCount, 'finding')}`;

  const pathCell = el('td', { className: 'path' });
  pathCell.append(el('span', { className: 'mono', text: info.file }));

  return el('tr', {
    className: `cov-row${findingId ? ' has-findings' : ''}`,
    attrs: {
      tabindex: '0',
      role: 'button',
      'aria-label': `${info.file}: ${findingId ? 'open findings' : 'locate in the dependency map'}`,
    },
    on: {
      click: () => openFile(ctx, info.file, findingId),
      keydown: event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openFile(ctx, info.file, findingId);
        }
      },
    },
  }, pathCell, el('td', { className: 'reason', text: reason }), el('td', { className: 'status', text: status }));
}

/** A cov-group: bordered-topped section, group head, then a cov-table or empty note. */
function group(id, label, status, reasonLabel, items, emptyNote, renderRow, unit = 'FILES') {
  const section = el('section', { className: 'cov-group', attrs: { id: `cov-${id}` } });
  const head = el('div', { className: 'cov-group-head' });
  head.append(
    el('h2', { text: label }),
    el('span', { className: 'count', text: `${pad2(items.length)} ${unit}` }),
  );
  section.append(head);

  if (!items.length) {
    section.append(el('div', { className: 'cov-empty', text: emptyNote }));
    return section;
  }

  const wrap = el('div', { className: 'table-scroll' });
  const table = el('table', { className: 'cov-table' });
  const headRow = el('tr');
  for (const heading of [reasonLabel === 'Analysis' ? 'File' : 'Path', reasonLabel, 'Status']) {
    headRow.append(el('th', { text: heading, attrs: { scope: 'col' } }));
  }
  table.append(el('thead', {}, headRow));

  const tbody = el('tbody');
  for (const item of items.slice(0, PAGE)) tbody.append(renderRow(item));
  table.append(tbody);
  wrap.append(table);
  section.append(wrap);

  if (items.length > PAGE) {
    section.append(el('p', {
      className: 'note cov-cap-note',
      text: `Showing the first ${number(PAGE)} of ${number(items.length)} entries. Export JSON for the complete list.`,
    }));
  }
  return section;
}

/** Aggregate rows: unsupported file types with no configured checker. */
function typeGroup(types) {
  const section = el('section', { className: 'cov-group', attrs: { id: 'cov-unsupported-by-type' } });
  const head = el('div', { className: 'cov-group-head' });
  head.append(
    el('h2', { text: 'Unsupported by type' }),
    el('span', { className: 'count', text: `${pad2(types.length)} TYPES` }),
  );
  section.append(head);

  if (!types.length) {
    section.append(el('div', { className: 'cov-empty', text: 'No discovered file type lacks a configured checker.' }));
    return section;
  }

  const wrap = el('div', { className: 'table-scroll' });
  const table = el('table', { className: 'cov-table' });
  const headRow = el('tr');
  for (const heading of ['Suffix', 'Files']) {
    headRow.append(el('th', { text: heading, attrs: { scope: 'col' } }));
  }
  table.append(el('thead', {}, headRow));

  const tbody = el('tbody');
  for (const [suffix, count] of types) {
    const pathCell = el('td', { className: 'path' });
    pathCell.append(el('span', { className: 'mono', text: suffix }));
    tbody.append(el('tr', {}, pathCell, el('td', { className: 'reason', text: `${number(count)} files` })));
  }
  table.append(tbody);
  wrap.append(table);
  section.append(wrap);
  return section;
}

export function render(container, ctx) {
  const report = ctx.state.report;
  container.replaceChildren();

  if (!report) {
    emptyState(container, 'Run a scan to inspect coverage', 'Coverage lists checked, unsupported, excluded and skipped files for the current scan.', '▦');
    return;
  }

  const scan = report.scan ?? {};
  const firstFindings = firstFindingByFile(report);
  const issueCounts = findingsByFile(report);

  const checked = (scan.checked_files ?? []).map(file => fileInfo(file, ''));
  const unsupported = (scan.not_checked_files ?? []).map(file => fileInfo(file, 'No configured checker'));
  const excluded = (scan.excluded_files ?? []).map(item => fileInfo(item, 'Excluded'));
  const skipped = (scan.skipped_files ?? []).map(item => fileInfo(item, 'Skipped'));
  const limitations = (scan.limitations ?? []).map(item => fileInfo(item, 'Unresolved'));

  container.append(summary(scan, excluded.length, skipped.length));

  const types = Object.entries(scan.not_checked_by_type ?? {});
  container.append(typeGroup(types));

  const fileRowFor = status => item =>
    fileRow(item, ctx, firstFindings, issueCounts, status, null);

  container.append(
    group('unsupported', 'Unsupported files', 'Unsupported', 'Reason', unsupported,
      'No discovered file type lacks a configured checker.', fileRowFor('Unsupported')),
    group('excluded', 'Excluded', 'Excluded', 'Reason', excluded,
      'No exclusion rules matched any discovered file.', fileRowFor('Excluded')),
    group('incomplete', 'Incomplete', 'Skipped', 'Reason', skipped,
      'No files were skipped.', fileRowFor('Skipped')),
    group('limitations', 'Limitations', 'Limitation', 'Reason', limitations,
      'Every reference resolved inside the checked file set.', fileRowFor('Limitation')),
    group('checked', 'Checked', 'Checked', 'Analysis', checked,
      'No files were checked.', item => {
        const issueCount = issueCounts.get(item.file) ?? 0;
        const status = issueCount ? `${number(issueCount)} ISSUE${issueCount === 1 ? '' : 'S'}` : 'OK';
        return fileRow({ ...item, reason: `${number(issueCount)} ${plural(issueCount, 'finding')}` }, ctx, firstFindings, issueCounts, status, '');
      }),
  );

  if (scan.coverage_notes?.length) {
    const notes = el('section', { className: 'cov-group', attrs: { id: 'cov-notes' } });
    const head = el('div', { className: 'cov-group-head' });
    head.append(el('h2', { text: 'Scan notes' }), el('span', { className: 'count', text: pad2(scan.coverage_notes.length) }));
    const list = el('ul', { className: 'coverage-notes' });
    for (const note of scan.coverage_notes) list.append(el('li', { text: note }));
    notes.append(head, list);
    container.append(notes);
  }
}
