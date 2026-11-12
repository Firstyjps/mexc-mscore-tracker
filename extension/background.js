// Reads the score when the browser starts, every few hours, and on request. Nothing leaves this browser except the reads
// to MEXC itself, and to the owner's own server when remotes.local.json names one (lib/remote.js).
import { readScore } from './lib/mexc.js';
import { parseRemotes, readRemote } from './lib/remote.js';
import { applyReading, emptyState, sortedDays } from './lib/store.js';
import { tierOf } from './lib/analyze.js';

const EVERY_MIN = 180;
const DASHBOARD = 'dashboard.html';
const TIER_COLOR = { Standard: '#66728a', Premier: '#2b50d8', Elite: '#a8740a' };

const load = async () => ({ ...emptyState(), ...(await chrome.storage.local.get(null)) });

async function showBadge(state) {
  const { status, accountId } = state.sync;
  if (status === 'login' || status === 'risk' || status === 'error') {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#c4372c' });
    return;
  }
  const rows = state.rows[accountId], days = sortedDays(rows), latest = rows?.[days[days.length - 1]];
  await chrome.action.setBadgeText({ text: latest ? String(Math.round(latest.score)) : '' });
  if (latest) await chrome.action.setBadgeBackgroundColor({ color: TIER_COLOR[tierOf(latest.score)?.name] ?? '#66728a' });
}

function notify(alert) {
  const message = alert.kind === 'risk'
    ? 'MEXC ระงับคะแนนของบัญชีนี้ (risk flag)'
    : `คะแนนลดจาก ${alert.from} เหลือ ${alert.to}`;
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon-128.png', title: `M-Score: ${alert.label}`, message });
}

async function loadRemotes() {
  try {
    const response = await fetch(chrome.runtime.getURL('remotes.local.json'), { cache: 'no-store' });
    return response.ok ? parseRemotes(await response.json()) : [];
  } catch { return []; } // no file = no remote account
}

async function syncOnce() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [reading, remotes] = await Promise.all([readScore(), loadRemotes()]);
  let { state, alerts } = applyReading(await load(), reading, Date.now(), timeZone);
  for (const remote of remotes) {
    const next = applyReading(state, await readRemote(fetch, remote), Date.now(), timeZone, { remote: true });
    state = next.state; alerts = alerts.concat(next.alerts);
  }
  await chrome.storage.local.set(state);
  await showBadge(state);
  if (state.settings.notify) alerts.forEach(notify);
}

let running = null;
const sync = () => (running ||= syncOnce().catch(async (error) => {
  const state = await load();
  await chrome.storage.local.set({ sync: { ...state.sync, status: 'error', at: Date.now(), message: String(error?.message || error) } });
}).finally(() => { running = null; }));

async function openDashboard() {
  const url = chrome.runtime.getURL(DASHBOARD);
  const [open] = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
  if (open) {
    await chrome.tabs.update(open.tabId, { active: true });
    await chrome.windows.update(open.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === 'sync') sync(); });
chrome.action.onClicked.addListener(openDashboard);
chrome.runtime.onStartup.addListener(sync);
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  chrome.alarms.create('sync', { delayInMinutes: EVERY_MIN, periodInMinutes: EVERY_MIN });
  await sync();
  if (reason === 'install') await openDashboard();
});
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'sync') return false;
  sync().then(() => reply({ ok: true }));
  return true;
});
