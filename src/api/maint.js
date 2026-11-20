// 保守用の API（docs/design/detailed/api.md 8.1・8.2。ADM-2）
// 経路の表で「包む」（blockConcurrencyWhile）ので、判定から書き込みまで割り込まれない（RSV-23）。
// ここに来るまでに、共1〜共4（鍵の確かめ方を含む）は ledger.js が済ませている。
// 判定と書き込みは管理者の画面の API（api.md 8.45・8.46）と共通（admin-accounts.js）
import { createAdminAccount, resetAdminAccountPassword } from './admin-accounts.js';

const MAINT = { actor_kind: 'maint' };

// POST /api/maint/admins（api.md 8.1）。derivePassword は PBKDF2 の関数（テストが差し替える）
export function createAdminByMaint(context, derivePassword) {
  return createAdminAccount(context, derivePassword, MAINT);
}

// POST /api/maint/admins/{id}/reset-password（api.md 8.2）。操作する管理者はいないので actorAdminId は null
export function resetAdminPasswordByMaint(context, derivePassword) {
  return resetAdminAccountPassword(context, derivePassword, MAINT, null);
}
