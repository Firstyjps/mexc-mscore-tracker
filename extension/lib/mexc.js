// Reads the M-Score with this browser's own MEXC session. GET only. Fields are picked one by one, so nothing else from
// MEXC's answers (benefits, tasks) reaches storage. The cookie is never read by this code: the browser attaches it.
export const BASES = ['https://www.mexc.com', 'https://www.mexc.co', 'https://www.mexc.fm'];
export const DIMENSIONS = ['trade_capability', 'security_authentication', 'account_seniority', 'platform_activity', 'asset_level'];
const PATH = '/api/credit-score/api/v1/credit/user/';
const TIMEOUT_MS = 15_000;

const num = (value) => { const n = Number(value); return value != null && Number.isFinite(n) ? n : null; };

class LoggedOut extends Error {}

async function get(fetchImpl, base, path) {
  const response = await fetchImpl(`${base}${PATH}${path}`, {
    credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  if (body?.code === 401) throw new LoggedOut();
  if (body?.code !== 0 || !body.data) throw new Error('MEXC ตอบข้อมูลไม่ครบ');
  return body.data;
}

function parseDimensions(detail) {
  const out = {};
  for (const item of Array.isArray(detail?.dimensionProgressList) ? detail.dimensionProgressList : []) {
    const rate = num(item?.completionRate);
    if (DIMENSIONS.includes(item?.dimensionCode) && rate != null) out[item.dimensionCode] = Math.round(rate * 100);
  }
  return out;
}

async function readBase(fetchImpl, base) {
  const info = await get(fetchImpl, base, 'simple/info');
  const id = typeof info.memberId === 'string' && /^[\w-]{1,64}$/.test(info.memberId) ? info.memberId : null;
  if (!id) throw new Error('MEXC ไม่ได้ส่งรหัสบัญชีมา');
  const score = num(info.totalScore);
  // simple/info decides first: a risk-flagged account also answers dimension/detail with no data.
  if (info.hasScore === false || score == null) return { status: info.isRisk === true ? 'risk' : 'no_score', id };
  const [detail, percentile] = await Promise.all([get(fetchImpl, base, 'dimension/detail'), get(fetchImpl, base, 'score/percentile')]);
  return {
    status: 'ok', id, score, percentile: num(percentile.displayPercentile), dimensions: parseDimensions(detail),
    lastUpdate: num(info.lastUpdateTime),
  };
}

/** A session may live on any MEXC domain: logged out on all of them means logged out; otherwise the first answer wins. */
export async function readScore(fetchImpl = fetch, bases = BASES) {
  let failure = null, loggedOut = false;
  for (const base of bases) {
    try {
      return await readBase(fetchImpl, base);
    } catch (error) {
      if (error instanceof LoggedOut) loggedOut = true;
      else failure = error;
    }
  }
  if (loggedOut) return { status: 'login' };
  return { status: 'error', message: failure?.name === 'TimeoutError' ? 'MEXC ไม่ตอบภายในเวลาที่กำหนด' : (failure?.message || 'ติดต่อ MEXC ไม่ได้') };
}
