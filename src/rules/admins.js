// 管理者の作成・パスワードの設定し直し（docs/design/detailed/rules.md 6.1。ADM-2）
// 段 1（入力の形式）は api/ が lib/validate.js で先に確かめる

// 段 8：そろえた後の ID で引いた行（削除した行も含む）があれば断る。
// 削除したアカウントの ID は再び使えない（ADM-2）
export function checkAdminCreate(sameIdAdmin) {
  if (sameIdAdmin !== null) return { ok: false, code: 'RULE_ADMIN_ID_DUPLICATE' };
  return { ok: true };
}

// admin：番号で引いた行（削除した行も含む）。なければ null。
// actorAdminId：操作した管理者の番号。保守用の API は null を渡す
export function checkAdminPasswordReset(admin, actorAdminId) {
  // 段 2：いない、または削除されている
  if (admin === null || admin.deleted_at !== null) return { ok: false, code: 'NOT_FOUND_ADMIN' };
  // 段 8：自分自身の設定し直し
  if (actorAdminId !== null && actorAdminId === admin.id) return { ok: false, code: 'RULE_ADMIN_SELF_RESET' };
  return { ok: true };
}
