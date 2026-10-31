import { DIMENSIONS } from './lib/mexc.js';
import { APP_ID, buildExport, emptyState, mergeImport, renameAccount } from './lib/store.js';
import { SCALE, TIERS, explainDrop, history, nextTier, tierOf } from './lib/analyze.js';

const FACTOR_NAMES = {
  trade_capability: 'การเทรด (Trade)',
  security_authentication: 'ความปลอดภัย (Security)',
  account_seniority: 'อายุบัญชี (Seniority)',
  platform_activity: 'ความเคลื่อนไหว (Activity)',
  asset_level: 'สินทรัพย์ (Assets)',
};
const SHORT_NAMES = { trade_capability: 'Trade', security_authentication: 'Security', account_seniority: 'Seniority', platform_activity: 'Activity', asset_level: 'Assets' };
const RANGES = [{ label: '30 วัน', days: 30 }, { label: '90 วัน', days: 90 }, { label: 'ทั้งหมด', days: null }];
const SHOWN_DAYS = 14;
const AUTO_SYNC_AFTER_MS = 30 * 60_000;

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
};
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
};

const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0');
const moveClass = (n) => (n > 0 ? 'is-up' : n < 0 ? 'is-down' : 'is-flat');
const dayLabel = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('th-TH-u-ca-gregory', { day: 'numeric', month: 'short' });
const dayTimeLabel = (ms) => new Date(ms).toLocaleString('th-TH-u-ca-gregory', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const view = { state: emptyState(), accountId: null, range: 90, showAllDays: false, syncing: false };
const load = async () => ({ ...emptyState(), ...(await chrome.storage.local.get(null)) });
const items = () => history(view.state.rows[view.accountId]);

function requestSync() {
  view.syncing = true;
  renderSync();
  return chrome.runtime.sendMessage({ type: 'sync' }).finally(async () => {
    view.syncing = false;
    await refresh();
  });
}

function pickAccount() {
  const ids = Object.keys(view.state.accounts);
  if (!ids.includes(view.accountId)) {
    const signedIn = view.state.sync.accountId;
    view.accountId = ids.includes(signedIn) ? signedIn : ids[0] ?? null;
  }
}

function renderAccounts() {
  const accounts = Object.values(view.state.accounts);
  $('accounts').replaceChildren(...(accounts.length > 1 ? accounts : []).map((account) => el('button', {
    type: 'button', textContent: account.label, 'aria-current': String(account.id === view.accountId),
    onclick: () => { view.accountId = account.id; view.showAllDays = false; render(); },
  })));
}

function renderSync() {
  $('sync-now').disabled = view.syncing;
  $('sync-now').textContent = view.syncing ? 'กำลังอัปเดต' : 'อัปเดตตอนนี้';
  // The selected account's own last reading: another account may be the one signed in right now.
  const list = view.accountId ? items() : [];
  const last = list[list.length - 1]?.readAt;
  $('sync-status').textContent = last ? `อ่านคะแนนล่าสุด ${dayTimeLabel(last)}` : '';
}

function signedInLabel() {
  return view.state.accounts[view.state.sync.accountId]?.label ?? 'บัญชีนี้';
}

function renderNotice() {
  const { status, message } = view.state.sync;
  const node = $('notice'), hasData = Boolean(view.accountId);
  node.hidden = true;
  if (status === 'login' && hasData) {
    node.replaceChildren('session ของ MEXC หมดอายุ คะแนนหยุดเก็บจนกว่าจะเข้าสู่ระบบใหม่ ',
      el('a', { href: 'https://www.mexc.com/user/m-score', target: '_blank', rel: 'noreferrer', textContent: 'เข้าสู่ระบบ MEXC' }));
    node.hidden = false;
  } else if (status === 'risk') {
    node.textContent = `MEXC ระงับคะแนนของ ${signedInLabel()} (risk flag) จึงอ่านคะแนนใหม่ไม่ได้ ประวัติที่เก็บไว้ยังดูได้ตามปกติ`;
    node.hidden = false;
  } else if (status === 'no_score') {
    node.textContent = `MEXC ยังไม่มีคะแนนของ ${signedInLabel()}`;
    node.hidden = false;
  } else if (status === 'error') {
    node.textContent = `อ่านคะแนนไม่สำเร็จ: ${message || 'ติดต่อ MEXC ไม่ได้'} ระบบจะลองใหม่ในรอบถัดไป`;
    node.hidden = false;
  }
}

function renderHero(latest) {
  const tier = tierOf(latest.score);
  const position = Math.min(100, Math.max(0, ((latest.score - SCALE.min) / (SCALE.max - SCALE.min)) * 100));
  const wrap = document.querySelector('.rail-wrap');
  wrap.style.setProperty('--at', `${position}%`);
  document.documentElement.style.setProperty('--tier', `var(--${(tier?.name ?? 'Standard').toLowerCase()})`);
  $('score').textContent = latest.score.toLocaleString('en-US');
  $('tier').textContent = tier?.name ?? 'ต่ำกว่า Standard';
  const bands = TIERS.map((t, i) => {
    const to = TIERS[i + 1]?.min ?? SCALE.max;
    return el('div', { class: `band${t === tier ? ' is-current' : ''}`, style: `width:${((to - t.min) / (SCALE.max - SCALE.min)) * 100}%` }, el('span', { textContent: `${t.name} ${t.min}` }));
  });
  $('rail').replaceChildren(...bands, el('div', { class: 'marker' }));
  $('rail').setAttribute('aria-label', `คะแนน ${latest.score} ระดับ ${tier?.name ?? 'ต่ำกว่า Standard'}`);

  const next = nextTier(latest.score);
  const summary = $('summary');
  const parts = [];
  if (latest.change != null) parts.push(el('span', { class: moveClass(latest.change), textContent: `${signed(latest.change)} จากครั้งก่อน` }), ' ');
  parts.push(next ? `ขาดอีก ${Math.ceil(next.min - latest.score)} แต้มถึง ${next.name}` : 'อยู่ระดับสูงสุดแล้ว');
  if (latest.percentile != null) parts.push(` เปอร์เซ็นไทล์ ${latest.percentile}`);
  summary.replaceChildren(...parts);
}

function renderDrop(latest) {
  const reason = explainDrop(latest), node = $('drop');
  node.hidden = !reason;
  if (!reason) return;
  const title = el('strong', { textContent: `${dayLabel(latest.day)} คะแนนลด ${-latest.change} แต้ม` });
  const body = reason.kind === 'hidden'
    ? 'ทั้ง 5 ด้านไม่มีด้านไหนลดเลย ตัวเลขที่ MEXC แสดงจึงอธิบายการลดครั้งนี้ไม่ได้ ควรสอบถาม MEXC Support ว่ามีการหักหรือปรับคะแนนหรือไม่'
    : reason.kind === 'factors'
      ? `ด้านที่ลด: ${reason.fell.map((name) => `${SHORT_NAMES[name]} ${signed(latest.dimensionChange[name])}`).join(', ')} ถ้าส่วนที่ลดดูน้อยเกินไปเมื่อเทียบกับคะแนน ควรสอบถาม MEXC Support`
      : 'ไม่มีข้อมูลรายด้านของวันก่อนหน้าให้เทียบ';
  node.replaceChildren(title, el('p', { textContent: body }));
}

function renderChart(all) {
  const list = view.range ? all.slice(-view.range) : all;
  const box = $('chart'), caption = $('chart-caption');
  const width = Math.max(320, box.clientWidth), height = 260, pad = { l: 44, r: 12, t: 12, b: 26 };
  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'กราฟคะแนนย้อนหลัง ดูตัวเลขได้ในตารางรายวัน' });
  const scores = list.map((d) => d.score);
  let min = Math.min(...scores), max = Math.max(...scores);
  const margin = Math.max(15, (max - min) * 0.2);
  min -= margin; max += margin;
  const x = (i) => pad.l + (list.length > 1 ? (i / (list.length - 1)) * (width - pad.l - pad.r) : (width - pad.l - pad.r) / 2);
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (height - pad.t - pad.b);

  for (const tier of TIERS) {
    if (tier.min <= min || tier.min >= max) continue;
    root.append(svg('line', { x1: pad.l, x2: width - pad.r, y1: y(tier.min), y2: y(tier.min), stroke: `var(--${tier.name.toLowerCase()})`, 'stroke-dasharray': '4 4' }));
    const text = svg('text', { x: width - pad.r, y: y(tier.min) - 5, 'text-anchor': 'end', 'font-size': 12, fill: `var(--${tier.name.toLowerCase()})` });
    text.textContent = `${tier.name} ${tier.min}`;
    root.append(text);
  }
  for (const v of [min + margin, max - margin]) {
    const text = svg('text', { x: pad.l - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 12, fill: 'var(--muted)' });
    text.textContent = Math.round(v);
    root.append(text);
  }
  const ends = list.length > 1 ? [0, list.length - 1] : [0];
  for (const i of ends) {
    const text = svg('text', { x: x(i), y: height - 6, 'text-anchor': i === 0 && list.length > 1 ? 'start' : 'end', 'font-size': 12, fill: 'var(--muted)' });
    text.textContent = dayLabel(list[i].day);
    root.append(text);
  }
  // Steps, not a smooth curve: the score holds until MEXC's next daily update.
  const path = list.map((d, i) => (i === 0 ? `M${x(0)} ${y(d.score)}` : `H${x(i)} V${y(d.score)}`)).join(' ');
  root.append(svg('path', { d: path, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 2 }));
  list.forEach((d, i) => {
    if (explainDrop(d)) root.append(svg('circle', { cx: x(i), cy: y(d.score), r: 5, fill: 'var(--down)' }));
  });
  const guide = svg('line', { y1: pad.t, y2: height - pad.b, stroke: 'var(--muted)', visibility: 'hidden' });
  const dot = svg('circle', { r: 4, fill: 'var(--ink)', visibility: list.length === 1 ? 'visible' : 'hidden', cx: x(0), cy: y(list[0].score) });
  root.append(guide, dot);

  const describe = (d) => `${dayLabel(d.day)}: ${d.score}${d.change != null ? ` (${signed(d.change)})` : ''}`;
  const latestText = describe(list[list.length - 1]);
  caption.textContent = latestText;
  root.addEventListener('pointermove', (event) => {
    const rect = root.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * width;
    const i = list.length > 1 ? Math.min(list.length - 1, Math.max(0, Math.round(((px - pad.l) / (width - pad.l - pad.r)) * (list.length - 1)))) : 0;
    guide.setAttribute('x1', x(i)); guide.setAttribute('x2', x(i)); guide.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(list[i].score)); dot.setAttribute('visibility', 'visible');
    caption.textContent = describe(list[i]);
  });
  root.addEventListener('pointerleave', () => {
    guide.setAttribute('visibility', 'hidden');
    if (list.length > 1) dot.setAttribute('visibility', 'hidden');
    caption.textContent = latestText;
  });
  box.replaceChildren(root);

  $('ranges').replaceChildren(...RANGES.map((range) => el('button', {
    type: 'button', textContent: range.label, 'aria-pressed': String(view.range === range.days),
    onclick: () => { view.range = range.days; renderChart(all); },
  })));
}

function renderFactors(latest) {
  $('factors').replaceChildren(...DIMENSIONS.map((name) => {
    const value = latest.dimensions?.[name], change = latest.dimensionChange[name];
    const b = el('b', { textContent: value != null ? `${value}%` : 'ไม่มีข้อมูล' });
    if (change) b.append(el('small', { class: moveClass(change), textContent: signed(change) }));
    const fill = el('i');
    fill.style.width = `${Math.min(100, value ?? 0)}%`;
    return el('li', {}, el('div', { class: 'factor-top' }, el('span', { textContent: FACTOR_NAMES[name] }), b), el('div', { class: 'meter' }, fill));
  }));
}

function renderDays(all) {
  const riskDays = view.state.accounts[view.accountId]?.riskDays ?? {};
  const ordered = [...all].reverse();
  const shown = view.showAllDays ? ordered : ordered.slice(0, SHOWN_DAYS);
  const head = el('tr', {}, ...['วันที่', 'คะแนน', 'เปลี่ยน', 'ด้านที่เปลี่ยน'].map((text) => el('th', { scope: 'col', textContent: text })));
  const rows = shown.map((d) => {
    const moved = Object.entries(d.dimensionChange).filter(([, change]) => change).map(([name, change]) => `${SHORT_NAMES[name]} ${signed(change)}`);
    const note = [riskDays[d.day] ? 'ถูกระงับคะแนน' : '', explainDrop(d)?.kind === 'hidden' ? 'คะแนนลดแต่ไม่มีด้านไหนลด' : '', moved.join(', ')].filter(Boolean).join(' / ');
    return el('tr', { class: explainDrop(d) ? 'is-alert' : '' },
      el('td', { textContent: dayLabel(d.day), title: dayTimeLabel(d.readAt) }),
      el('td', { textContent: d.score }),
      el('td', { class: d.change == null ? '' : moveClass(d.change), textContent: d.change == null ? '' : signed(d.change) }),
      el('td', { textContent: note }));
  });
  $('days').replaceChildren(el('thead', {}, head), el('tbody', {}, ...rows));
  $('more-days').hidden = view.showAllDays || ordered.length <= SHOWN_DAYS;
}

function renderSettings() {
  const account = view.state.accounts[view.accountId];
  $('rename-row').hidden = !account;
  if (account && document.activeElement !== $('rename')) $('rename').value = account.label;
  $('notify').checked = view.state.settings.notify !== false;
}

function render() {
  pickAccount();
  renderAccounts(); renderSync(); renderNotice(); renderSettings();
  const all = view.accountId ? items() : [];
  const hasData = all.length > 0;
  $('content').hidden = !hasData;
  $('empty').hidden = hasData || Boolean(view.accountId) || ['risk', 'no_score'].includes(view.state.sync.status);
  if (!hasData) return;
  const latest = all[all.length - 1];
  renderHero(latest); renderDrop(latest); renderFactors(latest); renderDays(all);
  renderChart(all);
}

async function refresh() {
  view.state = await load();
  render();
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  el('a', { href: url, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('sync-now').addEventListener('click', requestSync);
$('more-days').addEventListener('click', () => { view.showAllDays = true; render(); });
$('rename').addEventListener('change', async (event) => {
  await chrome.storage.local.set(renameAccount(view.state, view.accountId, event.target.value));
});
$('notify').addEventListener('change', async (event) => {
  await chrome.storage.local.set({ settings: { ...view.state.settings, notify: event.target.checked } });
});
$('export').addEventListener('click', () => {
  const now = Date.now();
  download(`${APP_ID}-${new Date(now).toISOString().slice(0, 10)}.json`, JSON.stringify(buildExport(view.state, now), null, 2));
});
$('import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file) return;
  try {
    const { state, added } = mergeImport(await load(), JSON.parse(await file.text()));
    await chrome.storage.local.set(state);
    alert(`นำเข้าแล้ว เพิ่มข้อมูลใหม่ ${added} วัน`);
  } catch (error) {
    alert(error instanceof SyntaxError ? 'อ่านไฟล์นี้ไม่ได้ ต้องเป็นไฟล์สำรองของ M-Score Tracker' : error.message);
  }
});
$('wipe').addEventListener('click', async () => {
  if (!confirm('ลบประวัติคะแนนทุกบัญชีในเบราว์เซอร์นี้? ถ้าไม่ได้สำรองไฟล์ไว้จะกู้คืนไม่ได้')) return;
  await chrome.storage.local.clear();
  view.accountId = null;
});

chrome.storage.onChanged.addListener(() => refresh());
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });

await refresh();
if (!view.state.sync.at || Date.now() - view.state.sync.at > AUTO_SYNC_AFTER_MS) requestSync();
