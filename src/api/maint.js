// 保守用の API（docs/design/detailed/api.md 8.1・8.2。ADM-2）
// 経路の表で「包む」（blockConcurrencyWhile）ので、判定から書き込みまで割り込まれない（RSV-23）。
// ここに来るまでに、共1〜共4（鍵の確かめ方を含む）は ledger.js が済ませている
import { applyAutoTransitions } from './auto.js';
import { ok, refuse } from './respond.js';
import { hasStringFields } from '../lib/body.js';
import { PBKDF2_ITERATIONS, newSalt } from '../lib/hash.js';
import { validateLoginId, validateName, validatePassword } from '../lib/validate.js';
import { checkAdminCreate, checkAdminPasswordReset } from '../rules/admins.js';
import { findAdminById, findAdminByLoginId, insertAdmin, updateAdminPassword } from '../store/admins.js';
import { insertEvent } from '../store/events.js';

// POST /api/maint/admins（api.md 8.1）。derivePassword は PBKDF2 の関数（テストが差し替える）
export async function createAdminByMaint({ storage, body, now, nowMin }, derivePassword) {
  if (!hasStringFields(body, ['login_id', 'display_name', 'password'])) return refuse('INPUT_BODY');

  // 段 1：入力の形式
  const loginId = validateLoginId(body.login_id);
  if (!loginId.ok) return refuse(loginId.code);
  const displayName = validateName(body.display_name);
  if (!displayName.ok) return refuse(displayName.code);
  const password = validatePassword(body.password);
  if (!password.ok) return refuse(password.code);

  // 段 8：同じ ID（削除した管理者を含む）
  const sql = storage.sql;
  const decision = checkAdminCreate(findAdminByLoginId(sql, loginId.value));
  if (!decision.ok) return refuse(decision.code);

  // すべて通ったときだけ計算する。断る要求には計算しない（auth.md 7）
  const salt = newSalt();
  const hash = await derivePassword(password.value, salt, PBKDF2_ITERATIONS);

  const id = storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    const id = insertAdmin(sql, {
      loginId: loginId.value,
      displayName: displayName.value,
      passwordHash: hash,
      passwordSalt: salt,
      passwordIterations: PBKDF2_ITERATIONS,
      createdAt: now,
    });
    // パスワード・ハッシュ・ソルト・鍵は入れない（SEC-4, LOG-4）
    insertEvent(sql, {
      at: now,
      actor_kind: 'maint',
      kind: 'admin_created',
      admin_id: id,
      detail: { login_id: loginId.value, display_name: displayName.value },
    });
    return id;
  });

  return ok({ id, login_id: loginId.value, display_name: displayName.value });
}

// POST /api/maint/admins/{id}/reset-password（api.md 8.2）
export async function resetAdminPasswordByMaint({ storage, params, body, now, nowMin }, derivePassword) {
  if (!hasStringFields(body, ['password'])) return refuse('INPUT_BODY');

  // 段 1：入力の形式
  const password = validatePassword(body.password);
  if (!password.ok) return refuse(password.code);

  // 段 2：対象の管理者。操作する管理者はいないので actorAdminId は null
  const sql = storage.sql;
  const admin = findAdminById(sql, params.id);
  const decision = checkAdminPasswordReset(admin, null);
  if (!decision.ok) return refuse(decision.code);

  const salt = newSalt();
  const hash = await derivePassword(password.value, salt, PBKDF2_ITERATIONS);

  storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    // 版が1増え、その管理者の認証した状態はすべての端末で止まる（ADM-2、auth.md 3）
    updateAdminPassword(sql, admin.id, {
      passwordHash: hash,
      passwordSalt: salt,
      passwordIterations: PBKDF2_ITERATIONS,
    });
    insertEvent(sql, {
      at: now,
      actor_kind: 'maint',
      kind: 'admin_password_reset',
      admin_id: admin.id,
      detail: { login_id: admin.login_id, display_name: admin.display_name },
    });
  });

  return ok({ id: admin.id, login_id: admin.login_id, display_name: admin.display_name });
}
