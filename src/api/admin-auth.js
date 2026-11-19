// 管理者の認証（docs/design/detailed/api.md 8.4〜8.7。ADM-2, SEC-3）
import { applyAutoTransitions } from './auto.js';
import { ok, refuse } from './respond.js';
import { hasStringFields } from '../lib/body.js';
import { clientKey } from '../lib/client.js';
import { adminCookie, clearAdminCookie } from '../lib/cookie.js';
import { PBKDF2_ITERATIONS, equalBytes, newSalt, newToken } from '../lib/hash.js';
import { windowStart } from '../lib/time.js';
import { validateLoginId } from '../lib/validate.js';
import { ATTEMPT_LIMITS, checkAdminLogin, checkAttemptLimit } from '../rules/auth.js';
import { endAdminSession, insertAdminSession } from '../store/admin-sessions.js';
import { findAdminByLoginId } from '../store/admins.js';
import { findAuthFailure, recordAuthFailure } from '../store/auth-failures.js';
import { insertEvent } from '../store/events.js';

const ENTRY = 'admin_login';

// 形式に合わない ID は値を残さずにこう書く（SEC-4。api.md 8.4）
const INVALID_LOGIN_ID = '(invalid)';

// 記録の ip は CF-Connecting-IP の値をそのまま入れる。IPv6 を /64 にまとめない（api.md 8.4）
function ipOf(request) {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}

function publicAdmin(admin) {
  return { id: admin.id, login_id: admin.login_id, display_name: admin.display_name };
}

// POST /api/admin/login の API ごとの準備（api.md 8.4 の 1）。新しい証明と、ID がないときに使うダミーのソルト
export async function prepareLogin() {
  return { token: await newToken(), dummySalt: newSalt() };
}

// POST /api/admin/login（api.md 8.4）。経路の表で「包む」「本文を自分で確かめる」。
// 確かめる順は 上限 → 本文 → ID とパスワード（api.md 4 の例外）。derivePassword は PBKDF2 の関数（テストが差し替える）
export async function login({ storage, request, body, bodyOk, now, nowMin, routePrepared }, derivePassword) {
  const sql = storage.sql;

  // 共3（上限）。上限を超えた相手には本文の誤りも教えず、計算もしない。上限の後は書かない（logging.md 4）
  const client = clientKey(request.headers.get('CF-Connecting-IP'));
  const window = windowStart(now);
  const limit = checkAttemptLimit(findAuthFailure(sql, ENTRY, client, window), ATTEMPT_LIMITS.admin_login);
  if (!limit.ok) return refuse(limit.code);

  // 共4。ID もパスワードも試していないので数えない
  if (!bodyOk || !hasStringFields(body, ['login_id', 'password'])) return refuse('INPUT_BODY');

  // 共3（ID とパスワード）。形式の誤りも AUTH_ADMIN_FAILED にする（INPUT_LOGIN_ID を返さない）
  const loginId = validateLoginId(body.login_id);
  const admin = loginId.ok ? findAdminByLoginId(sql, loginId.value) : null;
  const usable = admin !== null && admin.deleted_at === null;

  // ID がない・形式が合わない・削除したときも、ある ID と同じ1回の計算をする（auth.md 8）
  const derived = usable
    ? await derivePassword(body.password, new Uint8Array(admin.password_salt), admin.password_iterations)
    : await derivePassword(body.password, routePrepared.dummySalt, PBKDF2_ITERATIONS);
  const matches = usable && equalBytes(derived, admin.password_hash);

  const decision = checkAdminLogin(admin, matches);
  if (!decision.ok) {
    // 失敗のときは自動の変化を反映しない（api.md 8.4 の 6）
    storage.transactionSync(() =>
      recordAuthFailure(sql, {
        entry: ENTRY,
        client,
        windowStart: window,
        at: now,
        failure: decision.failure,
        loginId: loginId.ok ? loginId.value : INVALID_LOGIN_ID,
      }),
    );
    return refuse(decision.code);
  }

  const { token } = routePrepared;
  storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    insertAdminSession(sql, {
      tokenHash: token.hash,
      adminId: admin.id,
      passwordVersion: admin.password_version,
      createdAt: now,
    });
    // パスワード・ハッシュ・証明の値は入れない（SEC-4, LOG-4）
    insertEvent(sql, {
      at: now,
      actor_kind: 'admin',
      actor_admin_id: admin.id,
      kind: 'admin_login',
      admin_id: admin.id,
      detail: { ip: ipOf(request) },
    });
  });

  return ok(publicAdmin(admin), [['Set-Cookie', adminCookie(token.value)]]);
}

// GET /api/admin/me（api.md 8.6）。期限を延ばす Set-Cookie は ledger.js が付ける
export function me({ storage, auth, nowMin }) {
  storage.transactionSync(() => applyAutoTransitions(storage.sql, nowMin));
  return ok(publicAdmin(auth.admin));
}

// POST /api/admin/logout（api.md 8.7）。その端末の証明だけを止める。行は消さない（LOG-5）
export function logout({ storage, request, auth, now, nowMin }) {
  const sql = storage.sql;
  storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    endAdminSession(sql, auth.sessionId, now);
    insertEvent(sql, {
      at: now,
      actor_kind: 'admin',
      actor_admin_id: auth.admin.id,
      kind: 'admin_logout',
      admin_id: auth.admin.id,
      detail: { ip: ipOf(request) },
    });
  });
  // 延ばさずに端末の Cookie を消す（ledger.js は Set-Cookie が付いた応答に足さない）
  return ok({}, [['Set-Cookie', clearAdminCookie()]]);
}
