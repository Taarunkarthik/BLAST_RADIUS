const $ = id => document.getElementById(id);
const token = document.querySelector('meta[name="blastradius-token"]').content;
const PAGE_SIZE = 30;
let report = null;
let page = 0;
let selected = null;
let session = null;

function node(tag, text = '', className = '') {
  const result = document.createElement(tag);
  result.textContent = text;
  if (className) result.className = className;
  return result;
}

function notify(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-BlastRadius-Token': token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : 'Please check the request fields and try again.';
    throw new Error(detail);
  }
  return data;
}

function view(name) {
  document.querySelectorAll('[data-view]').forEach(button => {
    const active = button.dataset.view === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  $('scan-view').hidden = !['overview', 'findings'].includes(name);
  $('coverage-view').hidden = name !== 'coverage';
  $('history-view').hidden = name !== 'history';
  if (name === 'history') loadHistory();
  if (name === 'findings') $('search').focus();
}

function empty(container, title, message) {
  const block = node('div', '', 'empty-state');
  block.append(node('span', '◎'), node('h3', title), node('p', message));
  container.replaceChildren(block);
}

function renderSummary() {
  const scan = report.scan;
  $('metric-files').textContent = scan.files_checked.toLocaleString();
  $('metric-coverage').textContent = `${scan.files_discovered.toLocaleString()} discovered · ${scan.not_checked_count} unsupported`;
  $('metric-issues').textContent = report.summary.issues.toLocaleString();
  $('metric-high').textContent = report.summary.high.toLocaleString();
  $('metric-breakdown').textContent = `${report.summary.medium} medium · ${report.summary.low} low`;
  const affected = new Set(report.issues.flatMap(issue => issue.impact.has_tree_impact ? [...issue.impact.direct_dependents, ...issue.impact.transitive_dependents] : []));
  $('metric-affected').textContent = scan.mode === 'health' ? '—' : affected.size.toLocaleString();
  $('nav-count').textContent = report.summary.issues;
  $('report-id').textContent = `SCAN ${scan.id}`;
  $('report-actions').hidden = false;
  $('save-button').hidden = !session?.persistence;
  $('footer-status').textContent = `${scan.mode.toUpperCase()} · ${scan.partial ? 'PARTIAL COVERAGE' : 'SCAN COMPLETE'}`;
  $('scan-state').textContent = scan.partial ? 'Partial coverage' : 'Scan complete';
  if (scan.partial || scan.graph_partial) notify('This report has incomplete coverage or graph information. Open Coverage for the details.');
}

function renderFindings() {
  if (!report) return;
  const query = $('search').value.toLowerCase();
  const severity = $('severity').value;
  const filtered = report.issues.filter(issue => (severity === 'all' || issue.severity === severity) && `${issue.file} ${issue.type} ${issue.target}`.toLowerCase().includes(query));
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const visible = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  if (!visible.includes(selected)) {
    selected = visible[0] || null;
    renderDetail();
  }
  $('finding-count').textContent = filtered.length;
  $('finding-list').replaceChildren();
  if (!filtered.length) {
    empty($('finding-list'), report.issues.length ? 'No matching findings' : 'No issues detected', report.issues.length ? 'Try a different search or severity.' : 'The configured checks found no issues. Review Coverage to see their limits.');
  }
  for (const issue of visible) {
    const button = node('button', '', `finding${selected === issue ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', selected === issue ? 'true' : 'false');
    const row = node('div', '', 'finding-row');
    row.append(node('span', `${issue.file}:${issue.line}`, 'finding-file'), node('span', issue.severity, `badge ${issue.severity}`));
    button.append(row, node('div', issue.type, 'finding-type'));
    button.addEventListener('click', () => { selected = issue; renderFindings(); renderDetail(); });
    $('finding-list').append(button);
  }
  $('pagination').hidden = pages <= 1;
  $('previous').disabled = page === 0;
  $('next').disabled = page === pages - 1;
  $('page-label').textContent = `${page + 1} / ${pages}`;
}

function renderDetail() {
  if (!selected) {
    empty($('detail'), 'No finding selected', 'Select a diagnostic to inspect its dependency impact.');
    return;
  }
  const issue = selected;
  const impact = issue.impact;
  const body = node('div', '', 'detail-body');
  body.append(node('span', issue.severity, `badge ${issue.severity}`), node('h3', `${issue.file}:${issue.line}`, 'detail-file'), node('div', issue.type, 'finding-type'));
  body.append(node('p', issue.message || issue.target, 'detail-message'));
  if (issue.target) body.append(node('p', `Target: ${issue.target}`, 'note mono'));
  if (!impact.has_tree_impact) {
    body.append(node('div', 'No Tree Impact', 'impact-banner local'), node('p', impact.note, 'note'));
  } else {
    body.append(node('div', impact.is_root ? 'CRITICAL · root node — no dependents in the scanned graph' : `${impact.affected_count} affected / ${impact.eligible_count} eligible files (${impact.impact_percentage}%)`, 'impact-banner'));
    const numbers = node('div', '', 'impact-numbers');
    for (const [label, value] of [['Direct dependents', impact.direct_dependents.length], ['Transitive dependents', impact.transitive_dependents.length]]) {
      const item = node('div'); item.append(node('strong', String(value)), node('span', label)); numbers.append(item);
    }
    body.append(numbers);
    const tree = node('div', '', 'tree');
    tree.append(node('div', issue.file));
    const branches = new Map([[JSON.stringify([issue.file]), tree]]);
    for (const path of impact.paths.slice(0, 200)) {
      for (let index = 1; index < path.length; index++) {
        const key = JSON.stringify(path.slice(0, index + 1));
        if (branches.has(key)) continue;
        const parent = branches.get(JSON.stringify(path.slice(0, index)));
        let list = [...parent.children].find(child => child.tagName === 'UL');
        if (!list) { list = node('ul'); parent.append(list); }
        const entry = node('li', path[index]);
        entry.append(node('small', index === 1 ? 'direct' : `distance ${index}`));
        list.append(entry); branches.set(key, entry);
      }
    }
    body.append(tree);
    if (impact.paths.length > 200) body.append(node('p', 'Showing the first 200 dependency paths. Export JSON for every path.', 'note'));
    if (impact.partial) body.append(node('p', 'This impact calculation covers a partial graph.', 'note'));
    body.append(node('p', impact.note, 'note'));
  }
  $('detail').replaceChildren(body);
}

function renderCoverage() {
  const scan = report.scan;
  $('coverage').replaceChildren();
  const groups = [
    ['Unsupported files', scan.not_checked_files.map(file => ({ file, reason: 'No configured checker' }))],
    ['Excluded files', scan.excluded_files], ['Incomplete checks', scan.skipped_files],
    ['Resolution limitations', scan.limitations], ['Checked files', scan.checked_files.map(file => ({ file, reason: 'Checked' }))],
  ];
  for (const [title, items] of groups) {
    const group = node('div', '', 'coverage-group');
    group.append(node('h3', `${title} (${items.length})`));
    if (!items.length) group.append(node('p', 'None', 'note'));
    for (const item of items.slice(0, 200)) {
      const row = node('div', '', 'coverage-row');
      row.append(node('span', item.file, 'mono'), node('span', item.reason)); group.append(row);
    }
    if (items.length > 200) group.append(node('p', 'Showing 200 entries. Export JSON for the complete list.', 'note'));
    $('coverage').append(group);
  }
  const notes = node('ul', '', 'coverage-notes');
  scan.coverage_notes.forEach(note => notes.append(node('li', note)));
  $('coverage').append(notes);
}

$('scan-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('scan-button');
  button.disabled = true; button.textContent = 'Scanning…'; button.classList.add('busy');
  $('scan-state').textContent = 'Checking files and dependencies…';
  $('save-button').disabled = true;
  notify();
  try {
    report = await api('/api/scan', { path: $('scan-path').value || '.', mode: $('scan-mode').value });
    selected = report.issues[0] || null; page = 0;
    renderSummary(); renderFindings(); renderDetail(); renderCoverage(); view('overview');
  } catch (error) { notify(error.message); $('scan-state').textContent = 'Scan did not complete'; }
  finally { button.disabled = false; button.textContent = 'Run scan ↗'; button.classList.remove('busy'); $('save-button').disabled = false; }
});

$('search').addEventListener('input', () => { page = 0; renderFindings(); });
$('severity').addEventListener('change', () => { page = 0; renderFindings(); });
$('previous').addEventListener('click', () => { page--; renderFindings(); });
$('next').addEventListener('click', () => { page++; renderFindings(); });
document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => view(button.dataset.view)));
$('export-button').addEventListener('click', () => {
  if (!report) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
  const link = node('a'); link.href = url; link.download = `blastradius-${report.scan.id}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('save-button').addEventListener('click', async () => {
  if (!report) return;
  $('save-button').disabled = true;
  try {
    const saved = await api('/api/save', { report_id: report.scan.id });
    notify(`Scan saved. ID: ${saved.id}`);
  } catch (error) { notify(error.message); }
  finally { $('save-button').disabled = false; }
});

async function loadHistory() {
  $('history-list').replaceChildren(); $('comparison').replaceChildren();
  $('base-scan').replaceChildren(); $('head-scan').replaceChildren(); $('compare-button').disabled = true;
  if (!session?.persistence) {
    $('history-note').textContent = 'Saved history is optional. Configure PostgreSQL and register this workspace with the CLI to enable it. Scanning and JSON export work without a database.';
    return;
  }
  $('history-note').textContent = 'Loading this workspace’s saved scans…';
  try {
    const history = await api('/api/history');
    $('history-note').textContent = history.scans.length ? `${history.scans.length} saved scans for ${history.project.name}. Select a base and head to compare.` : 'No saved scans yet. Run a scan, then choose Save scan.';
    for (const scan of history.scans) {
      const label = `${new Date(scan.saved_at).toLocaleString()} · ${scan.mode} · ${scan.id.slice(0, 8)}`;
      for (const id of ['base-scan', 'head-scan']) {
        const option = node('option', label); option.value = scan.id; $(id).append(option);
      }
      const row = node('div', '', 'history-row');
      row.append(node('span', label), node('span', scan.partial ? 'Partial' : 'Complete', 'muted'));
      $('history-list').append(row);
    }
    if (history.scans.length > 1) $('base-scan').selectedIndex = 1;
    $('compare-button').disabled = history.scans.length < 2;
  } catch (error) { $('history-note').textContent = error.message; }
}
$('refresh-history').addEventListener('click', loadHistory);
$('compare-button').addEventListener('click', async () => {
  $('compare-button').disabled = true;
  try {
    const result = await api('/api/compare', { base: $('base-scan').value, head: $('head-scan').value });
    const summary = node('div', '', 'compare-summary');
    for (const [key, value] of Object.entries(result.summary)) {
      const item = node('div'); item.append(node('strong', String(value)), node('span', key)); summary.append(item);
    }
    $('comparison').replaceChildren(summary);
    result.warnings.forEach(warning => $('comparison').append(node('p', warning, 'note')));
    for (const category of ['added', 'resolved', 'changed', 'unverified']) {
      for (const record of result[category].slice(0, 100)) {
        const issue = category === 'changed' ? record.head : record;
        $('comparison').append(node('p', `${category.toUpperCase()} · ${issue.file}:${issue.line} · ${issue.type}`, 'note mono'));
      }
      if (result[category].length > 100) $('comparison').append(node('p', `Showing 100 ${category} findings. Use CLI JSON comparison for the full result.`, 'note'));
    }
  } catch (error) { notify(error.message); }
  finally { $('compare-button').disabled = false; }
});

try {
  session = await api('/api/session');
  $('project-name').textContent = session.name;
  $('root-path').textContent = session.root;
  $('history-note').textContent = session.persistence ? 'Saved history is connected.' : 'Saved history is not configured.';
} catch (error) { notify(error.message); $('scan-button').disabled = true; }
