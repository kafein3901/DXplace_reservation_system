// 管理者の画面からの管理者のアカウント（docs/design/detailed/api.md 8.44〜8.47。ADM-2, LOG-2, LOG-4）
// 共2・共3・共4（本文を読めたか）は ledger.js が確かめ、期限の延長も ledger.js が付ける（api.md 8.5）。
// 作成・設定し直しは経路の表で「包む」。判定と書き込みは保守用の API と共通（admin-accounts.js）
import { adminData, createAdminAccount, resetAdminAccountPassword } from './admin-accounts.js';
import { adminEvent } from './admin-event.js';
import { applyAutoTransitions } from './auto.js';
import { ok, refuse } from './respond.js';
import { clearAdminCookie } from '../lib/cookie.js';
import { checkAdminDelete } from '../rules/admins.js';
import { findAdminById, listActiveAdmins, markAdminDeleted } from '../store/admins.js';
import { insertEvent } from '../store/events.js';

const actorOf = (auth) => ({ actor_kind: 'admin', actor_admin_id: auth.admin.id });

// GET /api/admin/admins（api.md 8.44）。削除していない管理者を番号の順に。自分の行の印は入れない
export function listAdmins({ storage, nowMin }) {
  const sql = storage.sql;
  const admins = storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    return listActiveAdmins(sql);
  });
  return ok({ admins: admins.map(adminData) });
}

// POST /api/admin/admins（api.md 8.45）。作った管理者の証明は作らない
export function createAdminByAdmin(context, derivePassword) {
  return createAdminAccount(context, derivePassword, actorOf(context.auth));
}

// POST /api/admin/admins/{id}/reset-password（api.md 8.46）。自分自身は RULE_ADMIN_SELF_RESET
export function resetAdminPasswordByAdmin(context, derivePassword) {
  return resetAdminAccountPassword(context, derivePassword, actorOf(context.auth), context.auth.admin.id);
}

// POST /api/admin/admins/{id}/delete（api.md 8.47）。行は消さず deleted_at を入れる（LOG-2）。
// 共3 から書き込みの終わりまで await がないので、ほぼ同時の削除も1つずつ処理される（RSV-23）
export function deleteAdmin({ storage, params, auth, now, nowMin }) {
  const sql = storage.sql;
  // 段 2・段 8 で断っても、反映した自動の変化は残す（戻り値で断るので取り消されない）
  const result = storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    const admin = findAdminById(sql, params.id);
    const checked = checkAdminDelete(admin, listActiveAdmins(sql));
    if (!checked.ok) return { code: checked.code };
    markAdminDeleted(sql, admin.id, now);
    insertEvent(
      sql,
      adminEvent(now, auth, {
        kind: 'admin_deleted',
        admin_id: admin.id,
        detail: { login_id: admin.login_id, display_name: admin.display_name },
      }),
    );
    return { admin };
  });
  if (result.code !== undefined) return refuse(result.code);

  // 自分自身なら Cookie を消す（logout と同じ）。Set-Cookie を付けた応答は ledger.js が延ばさない
  const self = result.admin.id === auth.admin.id;
  return ok(adminData(result.admin), self ? [['Set-Cookie', clearAdminCookie()]] : undefined);
}
