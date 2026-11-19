// 利用の開始（docs/design/detailed/api.md 8.11・8.13。USR-2, ADM-3, SEC-3, SEC-4）
import { checkUserCookie, prepareUserCookie } from './auth.js';
import { applyAutoTransitions } from './auto.js';
import { ok, refuse } from './respond.js';
import { hasStringFields } from '../lib/body.js';
import { clientKey } from '../lib/client.js';
import { isTokenFormat, userCookie } from '../lib/cookie.js';
import { equalBytes, newToken, sha256 } from '../lib/hash.js';
import { windowStart } from '../lib/time.js';
import { ATTEMPT_LIMITS, checkAttemptLimit, checkSharedInfo } from '../rules/auth.js';
import { findAuthFailure, recordAuthFailure } from '../store/auth-failures.js';
import { findCurrentSharedInfo } from '../store/shared-infos.js';
import { insertUserSession } from '../store/user-sessions.js';

const ENTRY = 'shared_info';

// POST /api/session の API ごとの準備（api.md 8.11 の 1）。利用者の Cookie のハッシュ、送られた k のハッシュ
// （文字列で isTokenFormat を通るときだけ）、新しい証明。新しい証明は成功するかどうかにかかわらず作る（auth.md 3）
export async function prepareSession({ request, body }) {
  const k = body.ok ? body.value.k : undefined;
  return {
    cookie: await prepareUserCookie(request),
    sentHash: isTokenFormat(k) ? await sha256(k) : null,
    token: await newToken(),
  };
}

// POST /api/session（api.md 8.11）。経路の表で「本文を自分で確かめる」。
// 確かめる順は 有効な証明 → 上限 → 本文 → 未設定 → 値（api.md 4 の例外）。Origin は ledger.js が先に確かめている
export function startSession({ storage, request, body, bodyOk, now, nowMin, routePrepared }) {
  const sql = storage.sql;
  const { cookie, sentHash, token } = routePrepared;

  // ii. 有効な証明があれば、値も本文も見ずに成功を返す。行は足さず、期限だけ延ばす
  if (checkUserCookie(sql, cookie).ok) {
    storage.transactionSync(() => applyAutoTransitions(sql, nowMin));
    return ok({}, [['Set-Cookie', userCookie(cookie.token)]]);
  }

  // iii. 試行の上限。上限の後は書かない（logging.md 4）
  const client = clientKey(request.headers.get('CF-Connecting-IP'));
  const window = windowStart(now);
  const limit = checkAttemptLimit(findAuthFailure(sql, ENTRY, client, window), ATTEMPT_LIMITS.shared_info);
  if (!limit.ok) return refuse(limit.code);

  // iv. 本文。値を試していないので数えない
  if (!bodyOk || !hasStringFields(body, ['k'])) return refuse('INPUT_BODY');

  // v. 値。形が違う k はハッシュがないので一致しない（AUTH_SHARED_INFO_WRONG として数える）
  const current = findCurrentSharedInfo(sql);
  const matches = current !== null && sentHash !== null && equalBytes(sentHash, current.hash);
  const decision = checkSharedInfo(current, matches);
  if (!decision.ok) {
    // 失敗のときは自動の変化を反映しない。未設定（failure なし）は数えない
    if (decision.failure) {
      storage.transactionSync(() => recordAuthFailure(sql, { entry: ENTRY, client, windowStart: window, at: now }));
    }
    return refuse(decision.code);
  }

  // 成功は記録しない（logging.md 2）。値もハッシュも events に入れない（SEC-4）
  storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    insertUserSession(sql, { tokenHash: token.hash, sharedInfoId: current.id, createdAt: now });
  });
  return ok({}, [['Set-Cookie', userCookie(token.value)]]);
}

// GET /api/session の API ごとの準備（api.md 8.13）
export async function prepareSessionStatus({ request }) {
  return { cookie: await prepareUserCookie(request) };
}

// GET /api/session（api.md 8.13）。断らず、有効かどうかを返す。有効なときだけ自動の変化を反映し、期限を延ばす
export function sessionStatus({ storage, nowMin, routePrepared }) {
  const sql = storage.sql;
  const { cookie } = routePrepared;
  const decision = checkUserCookie(sql, cookie);
  if (!decision.ok) return ok({ active: false, reason: decision.code });
  storage.transactionSync(() => applyAutoTransitions(sql, nowMin));
  return ok({ active: true }, [['Set-Cookie', userCookie(cookie.token)]]);
}
