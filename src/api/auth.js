// 共3：認証（docs/design/detailed/api.md 4・6.1、docs/design/basic/auth.md 1）
// 準備（await が要る）と、同期の区間での確かめ方を分ける。認証の種類ごとの確かめ方は、それぞれの機能の実装で足す
import { clientKey } from '../lib/client.js';
import { ADMIN_COOKIE, isTokenFormat, readCookie } from '../lib/cookie.js';
import { equalBytes, sha256 } from '../lib/hash.js';
import { windowStart } from '../lib/time.js';
import { ATTEMPT_LIMITS, checkAdminSession, checkAttemptLimit } from '../rules/auth.js';
import { findAdminSessionByHash } from '../store/admin-sessions.js';
import { findAdminById } from '../store/admins.js';
import { findAuthFailure, recordAuthFailure } from '../store/auth-failures.js';

// 保守用の鍵の最短の長さ。32バイトを base64url にした長さ。短ければ未設定とみなす（design-values.md）
export const MIN_MAINT_KEY_LENGTH = 43;

const BEARER = 'Bearer ';

// 準備（api.md 3.3 の 2）。保守用の API では、鍵とヘッダの値の SHA-256 を求める（api.md 6.1）。
// 管理者の API では、Cookie の値とその SHA-256 を求める。形が違う値は Cookie がないものとする（api.md 8.5 の 1）
export async function prepareAuth(kind, request, env) {
  if (kind === 'admin') {
    const token = readCookie(request.headers.get('Cookie'), ADMIN_COOKIE);
    if (!isTokenFormat(token)) return { token: null, tokenHash: null };
    return { token, tokenHash: await sha256(token) };
  }
  if (kind !== 'maint') return {};
  const key = env.MAINT_KEY;
  const enabled = typeof key === 'string' && key.length >= MIN_MAINT_KEY_LENGTH;
  if (!enabled) return { enabled };

  // ヘッダがない、または「Bearer」と空白1つで始まらない（大文字・小文字も区別する）ときは、値がないものとする
  const header = request.headers.get('Authorization');
  const sent = header !== null && header.startsWith(BEARER) ? header.slice(BEARER.length) : null;
  return {
    enabled,
    keyHash: await sha256(key),
    sentHash: sent === null ? null : await sha256(sent),
  };
}

// 同期の区間で確かめる。通れば { ok: true }（管理者の API では admin と sessionId も）、断るなら { ok: false, code }
export function checkAuth(kind, { storage, request, prepared, now }) {
  switch (kind) {
    case 'public':
      return { ok: true };
    case 'admin':
      return checkAdmin(storage.sql, prepared);
    case 'maint':
      return checkMaint(storage, request, prepared, now);
    default:
      throw new Error(`認証の種類がまだ実装されていない：${kind}`);
  }
}

// 保守用の鍵（api.md 6.1。ADM-2, SEC-3）。未設定 → 試行の上限 → 鍵の順
function checkMaint(storage, request, prepared, now) {
  // 1. 未設定は試行にならないので数えない
  if (!prepared.enabled) return { ok: false, code: 'AUTH_MAINT_DISABLED' };

  // 2. 試行の上限。上限の後は書かない（logging.md 4）
  const sql = storage.sql;
  const entry = 'maint';
  const client = clientKey(request.headers.get('CF-Connecting-IP'));
  const window = windowStart(now);
  const limit = checkAttemptLimit(findAuthFailure(sql, entry, client, window), ATTEMPT_LIMITS.maint);
  if (!limit.ok) return limit;

  // 3. 両方の SHA-256 を比べる（長さがそろい、鍵の長さもわからない）
  if (prepared.sentHash === null || !equalBytes(prepared.sentHash, prepared.keyHash)) {
    storage.transactionSync(() => recordAuthFailure(sql, { entry, client, windowStart: window, at: now }));
    return { ok: false, code: 'AUTH_MAINT_KEY_INVALID' };
  }
  return { ok: true };
}

// 管理者の証明（api.md 8.5 の 2。ADM-2）。失敗として数えない
function checkAdmin(sql, prepared) {
  const session = prepared.tokenHash === null ? null : findAdminSessionByHash(sql, prepared.tokenHash);
  const admin = session === null ? null : findAdminById(sql, session.admin_id);
  const decision = checkAdminSession(session, admin);
  if (!decision.ok) return decision;
  return { ok: true, admin, sessionId: session.id };
}
