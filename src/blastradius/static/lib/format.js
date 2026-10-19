/** Presentation formatters shared by every view. */

export const SEVERITY_ORDER = Object.freeze({ high: 0, medium: 1, low: 2 });
export const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

export function number(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return numeric.toLocaleString();
}

export function percent(value, digits = 1) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '—';
  return `${numeric.toFixed(digits)}%`;
}

export function severityRank(severity) {
  return Object.hasOwn(SEVERITY_ORDER, severity) ? SEVERITY_ORDER[severity] : Number.MAX_SAFE_INTEGER;
}

export function severityLabel(severity) {
  if (!severity) return 'Unknown';
  return severity.charAt(0).toUpperCase() + severity.slice(1);
}

export function dateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return Number(count) === 1 ? singular : pluralForm;
}

export function shortId(id, length = 8) {
  const value = String(id ?? '');
  return value.length > length ? value.slice(0, length) : value;
}

export function modeLabel(mode) {
  return { all: 'Full scan', structure: 'Structure only', health: 'Health only' }[mode] ?? String(mode ?? '');
}

export function truncate(value, max = 64) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/**
 * Stable finding identity: `file:line:type:target`.
 *
 * Selection, deep links and filtering all use this string instead of object
 * identity, so a restored /api/report payload and a fresh scan agree.
 */
export function issueId(issue) {
  return [
    issue?.file ?? '',
    issue?.line ?? 0,
    issue?.type ?? '',
    issue?.target ?? '',
  ].join(':');
}

/** Look up a finding by stable id. */
export function findIssue(report, id) {
  if (!report || !id) return null;
  return (report.issues ?? []).find(issue => issueId(issue) === id) ?? null;
}
