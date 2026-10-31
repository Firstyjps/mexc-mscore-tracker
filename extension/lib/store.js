// The data model, as pure functions. One row per account per local calendar day; a later reading replaces that day's row.
// state = { accounts: { id: { id, label, riskDays: { day: true } } }, rows: { id: { day: row } }, sync, settings }
import { DIMENSIONS } from './mexc.js';

export const APP_ID = 'mexc-mscore-tracker';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[\w-]{1,64}$/;
const LABEL_MAX = 24;
export const DROP_ALERT = 10; // a daily drop this big gets called out on the dashboard and in a notification

export const emptyState = () => ({ accounts: {}, rows: {}, sync: { status: 'idle', at: null, accountId: null, message: null }, settings: { notify: true } });

export function localDay(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
  return parts;
}

const ensureAccount = (state, id) => {
  if (!state.accounts[id]) {
    const taken = new Set(Object.values(state.accounts).map((account) => account.label));
    let n = Object.keys(state.accounts).length + 1;
    while (taken.has(`บัญชี ${n}`)) n += 1;
    state.accounts[id] = { id, label: `บัญชี ${n}`, riskDays: {} };
  }
  state.rows[id] ??= {};
  return state.accounts[id];
};

export const sortedDays = (rows) => Object.keys(rows || {}).sort();

/** Applies one reading from readScore. Returns the new state and what deserves a notification. */
export function applyReading(previous, reading, now, timeZone) {
  const state = structuredClone(previous);
  const day = localDay(now, timeZone);
  const alerts = [];
  state.sync = { status: reading.status, at: now, accountId: reading.id ?? state.sync?.accountId ?? null, message: reading.message ?? null };
  if (!reading.id) return { state, alerts };
  const account = ensureAccount(state, reading.id);
  if (reading.status === 'risk') {
    if (!account.riskDays[day]) alerts.push({ kind: 'risk', label: account.label });
    account.riskDays[day] = true;
  }
  if (reading.status !== 'ok') return { state, alerts };
  const rows = state.rows[reading.id], days = sortedDays(rows);
  const before = rows[days[days.length - 1]];
  rows[day] = { score: reading.score, percentile: reading.percentile, dimensions: reading.dimensions, lastUpdate: reading.lastUpdate, readAt: now };
  if (before && before.score - reading.score >= DROP_ALERT) {
    alerts.push({ kind: 'drop', label: account.label, from: before.score, to: reading.score });
  }
  return { state, alerts };
}

export function buildExport(state, now) {
  return { app: APP_ID, version: 1, exportedAt: now, accounts: Object.values(state.accounts), rows: state.rows };
}

function cleanRow(raw) {
  const score = Number(raw?.score), readAt = Number(raw?.readAt);
  if (raw?.score == null || !Number.isFinite(score) || score < 0 || score > 2000 || !Number.isFinite(readAt)) return null;
  const dimensions = {};
  for (const name of DIMENSIONS) {
    const value = raw.dimensions?.[name];
    if (value != null && Number.isFinite(Number(value))) dimensions[name] = Number(value);
  }
  const optional = (value) => (value != null && Number.isFinite(Number(value)) ? Number(value) : null);
  return { score, percentile: optional(raw.percentile), dimensions, lastUpdate: optional(raw.lastUpdate), readAt };
}

/**
 * Merges an exported file. The file is untrusted input: only known fields survive. On the same day of the same account
 * the later reading wins. A label stays as this browser named it, unless this browser only has the default one.
 */
export function mergeImport(previous, file) {
  if (file?.app !== APP_ID || file.version !== 1 || !file.rows || typeof file.rows !== 'object') throw new Error('ไฟล์นี้ไม่ใช่ไฟล์สำรองของ M-Score Tracker');
  const state = structuredClone(previous);
  const labels = new Map((Array.isArray(file.accounts) ? file.accounts : []).map((a) => [a?.id, a]));
  let added = 0;
  for (const [id, rows] of Object.entries(file.rows)) {
    if (!ID_RE.test(id) || !rows || typeof rows !== 'object') continue;
    const known = Boolean(state.accounts[id]);
    const account = ensureAccount(state, id);
    const incoming = labels.get(id);
    if (!known && typeof incoming?.label === 'string' && incoming.label.trim()) account.label = incoming.label.trim().slice(0, LABEL_MAX);
    for (const day of Object.keys(incoming?.riskDays || {})) if (DAY_RE.test(day)) account.riskDays[day] = true;
    for (const [day, raw] of Object.entries(rows)) {
      const row = DAY_RE.test(day) ? cleanRow(raw) : null;
      if (!row) continue;
      const current = state.rows[id][day];
      if (!current || row.readAt > current.readAt) { state.rows[id][day] = row; added += current ? 0 : 1; }
    }
  }
  return { state, added };
}

export function removeAccount(previous, id) {
  const state = structuredClone(previous);
  delete state.accounts[id];
  delete state.rows[id];
  return state;
}

export function renameAccount(previous, id, label) {
  const state = structuredClone(previous), name = String(label).trim().slice(0, LABEL_MAX);
  if (state.accounts[id] && name) state.accounts[id].label = name;
  return state;
}
