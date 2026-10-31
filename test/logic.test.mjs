import assert from 'node:assert/strict';
import test from 'node:test';
import { readScore } from '../extension/lib/mexc.js';
import { applyReading, buildExport, emptyState, localDay, mergeImport, removeAccount, renameAccount } from '../extension/lib/store.js';
import { explainDrop, history, nextTier, tierOf } from '../extension/lib/analyze.js';

const TZ = 'Asia/Bangkok';
const dims = (a, b, c, d, e) => ({ trade_capability: a, security_authentication: b, account_seniority: c, platform_activity: d, asset_level: e });
const reading = (score, dimensions = dims(4, 96, 68, 74, 17)) => ({ status: 'ok', id: 'm1', score, percentile: 96.38, dimensions, lastUpdate: 1 });
const at = (day) => Date.parse(`${day}T05:00:00Z`);

function mexc(routes) {
  return async (url) => {
    const path = url.split('/credit/user/')[1], base = new URL(url).origin;
    const answer = routes[`${base}:${path}`] ?? routes[path];
    if (answer instanceof Error) throw answer;
    return { ok: true, status: 200, json: async () => answer };
  };
}
const INFO = { code: 0, data: { memberId: 'm1', totalScore: 721, hasScore: true, isRisk: false, lastUpdateTime: 5, userBenefitListResponses: ['secret stuff'] } };
const DETAIL = { code: 0, data: { dimensionProgressList: [{ dimensionCode: 'trade_capability', completionRate: 0.04 }, { dimensionCode: 'unknown', completionRate: 1 }] } };
const PCT = { code: 0, data: { displayPercentile: 96.38, totalProfit: 430 } };

test('readScore keeps only the fields it needs', async () => {
  const result = await readScore(mexc({ 'simple/info': INFO, 'dimension/detail': DETAIL, 'score/percentile': PCT }), ['https://a']);
  assert.deepEqual(result, { status: 'ok', id: 'm1', score: 721, percentile: 96.38, dimensions: { trade_capability: 4 }, lastUpdate: 5 });
});

test('readScore reports a risk flag even though dimension/detail has no data', async () => {
  const info = { code: 0, data: { memberId: 'm1', totalScore: null, hasScore: false, isRisk: true } };
  const result = await readScore(mexc({ 'simple/info': info, 'dimension/detail': { code: 0, data: null } }), ['https://a']);
  assert.deepEqual(result, { status: 'risk', id: 'm1' });
});

test('readScore tries the other domains and says login only when every domain is logged out', async () => {
  const out = { code: 401, msg: 'Please login first' };
  const routes = { 'https://a:simple/info': out, 'https://b:simple/info': INFO, 'dimension/detail': DETAIL, 'score/percentile': PCT };
  assert.equal((await readScore(mexc(routes), ['https://a', 'https://b'])).score, 721);
  assert.deepEqual(await readScore(mexc({ 'simple/info': out }), ['https://a', 'https://b']), { status: 'login' });
});

test('readScore turns a network failure into an error, not a login prompt', async () => {
  const result = await readScore(mexc({ 'simple/info': new Error('Failed to fetch') }), ['https://a']);
  assert.equal(result.status, 'error');
});

test('one row per local day, the later reading replaces it', () => {
  let { state } = applyReading(emptyState(), reading(829), at('2026-10-30'), TZ);
  ({ state } = applyReading(state, reading(830), at('2026-10-30') + 3600e3, TZ));
  assert.deepEqual(Object.keys(state.rows.m1), ['2026-10-30']);
  assert.equal(state.rows.m1['2026-10-30'].score, 830);
});

test('localDay follows the time zone', () => {
  assert.equal(localDay(Date.parse('2026-10-30T18:00:00Z'), TZ), '2026-10-31');
});

test('a big drop alerts; a small one does not', () => {
  let { state, alerts } = applyReading(emptyState(), reading(829), at('2026-10-30'), TZ);
  assert.equal(alerts.length, 0);
  ({ state, alerts } = applyReading(state, reading(821), at('2026-10-31'), TZ));
  assert.equal(alerts.length, 0);
  ({ alerts } = applyReading(state, reading(721), at('2026-11-01'), TZ));
  assert.deepEqual(alerts.map((a) => [a.kind, a.from, a.to]), [['drop', 821, 721]]);
});

test('a risk flag writes no score and alerts once per day', () => {
  let { state } = applyReading(emptyState(), reading(618), at('2026-10-28'), TZ);
  let alerts;
  ({ state, alerts } = applyReading(state, { status: 'risk', id: 'm1' }, at('2026-10-29'), TZ));
  assert.equal(alerts[0].kind, 'risk');
  assert.equal(state.rows.m1['2026-10-29'], undefined);
  assert.equal(state.accounts.m1.riskDays['2026-10-29'], true);
  ({ alerts } = applyReading(state, { status: 'risk', id: 'm1' }, at('2026-10-29') + 1000, TZ));
  assert.equal(alerts.length, 0);
});

test('two accounts in one browser stay apart', () => {
  let { state } = applyReading(emptyState(), reading(829), at('2026-10-30'), TZ);
  ({ state } = applyReading(state, { ...reading(605), id: 'm2' }, at('2026-10-30'), TZ));
  assert.equal(state.rows.m1['2026-10-30'].score, 829);
  assert.equal(state.rows.m2['2026-10-30'].score, 605);
  assert.equal(state.accounts.m2.label, 'บัญชี 2');
});

test('removing an account leaves the others, and new default labels do not collide', () => {
  let { state } = applyReading(emptyState(), reading(829), at('2026-10-30'), TZ);
  ({ state } = applyReading(state, { ...reading(605), id: 'm2' }, at('2026-10-30'), TZ));
  state = removeAccount(state, 'm1');
  assert.deepEqual(Object.keys(state.rows), ['m2']);
  ({ state } = applyReading(state, { ...reading(700), id: 'm3' }, at('2026-10-30'), TZ));
  assert.equal(state.accounts.m3.label, 'บัญชี 3');
});

test('tiers follow MEXC thresholds', () => {
  assert.equal(tierOf(721).name, 'Premier');
  assert.equal(tierOf(800).name, 'Elite');
  assert.equal(tierOf(100), null);
  assert.equal(nextTier(721).min, 800);
  assert.equal(nextTier(900), null);
});

test('the 31 Oct case: score down 108, no factor down, is flagged as hidden', () => {
  const rows = {
    '2026-10-30': { score: 829, dimensions: dims(4, 96, 68, 74, 17), readAt: 1 },
    '2026-10-31': { score: 721, dimensions: dims(4, 96, 68, 76, 17), readAt: 2 },
  };
  const [first, latest] = history(rows);
  assert.equal(first.change, null);
  assert.equal(latest.change, -108);
  assert.deepEqual(explainDrop(latest), { kind: 'hidden', fell: [] });
});

test('a drop with a factor down names it; a small drop is not flagged', () => {
  const rows = {
    a: { score: 830, dimensions: dims(4, 92, 70, 76, 22), readAt: 1 },
    b: { score: 815, dimensions: dims(4, 92, 70, 74, 22), readAt: 2 },
    c: { score: 813, dimensions: dims(4, 92, 70, 72, 22), readAt: 3 },
  };
  const [, big, small] = history(rows);
  assert.deepEqual(explainDrop(big), { kind: 'factors', fell: ['platform_activity'] });
  assert.equal(explainDrop(small), null);
});

test('export then import restores everything, newer reading wins', () => {
  const { state } = applyReading(emptyState(), reading(829), at('2026-10-30'), TZ);
  const named = renameAccount(state, 'm1', 'Main');
  const file = JSON.parse(JSON.stringify(buildExport(named, 9)));
  const fresh = mergeImport(emptyState(), file);
  assert.equal(fresh.added, 1);
  assert.equal(fresh.state.accounts.m1.label, 'Main');
  assert.deepEqual(fresh.state.rows.m1, named.rows.m1);

  const { state: newer } = applyReading(state, reading(900), at('2026-10-30') + 1000, TZ);
  assert.equal(mergeImport(newer, file).state.rows.m1['2026-10-30'].score, 900);
});

test('import rejects foreign files and drops bad or unknown fields', () => {
  assert.throws(() => mergeImport(emptyState(), { app: 'other', version: 1, rows: {} }));
  const file = {
    app: 'mexc-mscore-tracker', version: 1,
    accounts: [{ id: 'm1', label: '<img src=x>', evil: true }],
    rows: {
      m1: { '2026-10-30': { score: 700, readAt: 1, dimensions: { trade_capability: 'x', asset_level: 3, extra: 9 }, html: '<b>' }, 'not-a-day': { score: 1, readAt: 1 }, '2026-10-31': { score: 'NaN', readAt: 1 } },
      '../bad id': { '2026-10-30': { score: 1, readAt: 1 } },
    },
  };
  const { state, added } = mergeImport(emptyState(), file);
  assert.equal(added, 1);
  assert.deepEqual(Object.keys(state.rows), ['m1']);
  assert.deepEqual(state.rows.m1['2026-10-30'], { score: 700, percentile: null, dimensions: { asset_level: 3 }, lastUpdate: null, readAt: 1 });
});
