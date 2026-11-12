// Reads an account this browser is not logged into from the owner's own server (the funding dashboard reads it with
// that account's session through its proxy). Configured in remotes.local.json, which stays out of git:
//   [{ "endpoint": "https://…/api/exec/mscore/feed", "token": "<64 hex>" }]
// Fields are picked one by one, as in mexc.js.
import { DIMENSIONS } from './mexc.js';

const TIMEOUT_MS = 15_000;
const STATUSES = ['ok', 'risk', 'no_score', 'login', 'error'];
const num = (value) => { const n = Number(value); return value != null && Number.isFinite(n) ? n : null; };

export function parseRemotes(list) {
  return (Array.isArray(list) ? list : []).filter((r) => typeof r?.endpoint === 'string' && /^https:\/\//.test(r.endpoint)
    && typeof r?.token === 'string' && /^[0-9a-f]{64}$/.test(r.token));
}

export async function readRemote(fetchImpl, { endpoint, token }) {
  let body;
  try {
    const response = await fetchImpl(endpoint, { cache: 'no-store', headers: { accept: 'application/json', 'x-sync-token': token }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return { status: 'error', message: `server HTTP ${response.status}` };
    body = await response.json();
  } catch (error) {
    return { status: 'error', message: error?.name === 'TimeoutError' ? 'server ไม่ตอบ' : 'ติดต่อ server ไม่ได้' };
  }
  const id = typeof body?.id === 'string' && /^[\w-]{1,64}$/.test(body.id) ? body.id : null;
  const status = STATUSES.includes(body?.status) ? body.status : 'error';
  const label = typeof body?.label === 'string' ? body.label : null;
  if (!id) return { status: 'error', label, message: 'server ไม่ได้ส่งรหัสบัญชีมา' };
  const score = num(body.score);
  if (status !== 'ok' || score == null) return { status: status === 'ok' ? 'error' : status, id, label, message: typeof body.message === 'string' ? body.message.slice(0, 120) : null };
  const dimensions = {};
  for (const d of DIMENSIONS) { const v = num(body.dimensions?.[d]); if (v != null) dimensions[d] = v; }
  return { status: 'ok', id, label, score, percentile: num(body.percentile), dimensions, lastUpdate: num(body.lastUpdate) };
}
