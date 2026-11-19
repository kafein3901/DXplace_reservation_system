// 認証の判定（docs/design/detailed/rules.md 6.3。SEC-3）

// 入口ごとの試行の上限（10分の区切りごとの失敗の数。design-values.md、auth.md 7）
export const ATTEMPT_LIMITS = {
  shared_info: 200,
  admin_login: 10,
  maint: 5,
};

// row：auth_failures から入口・相手・区切りで引いた行。なければ null
export function checkAttemptLimit(row, limit) {
  if (row !== null && row.failures >= limit) return { ok: false, code: 'LIMIT_ATTEMPTS' };
  return { ok: true };
}

// 管理者の認証（ADM-2）。admin：そろえた ID で引いた行（削除した行も含む。形式が合わない、ないときは null）、
// passwordMatches：PBKDF2 の結果が保存してあるハッシュと等しかったか。
// failure は記録のためだけの印で、応答には code だけを入れる（auth.md 8）
export function checkAdminLogin(admin, passwordMatches) {
  // 削除した管理者は「ID がない」に数える。パスワードより先に確かめる
  if (admin === null || admin.deleted_at !== null) {
    return { ok: false, code: 'AUTH_ADMIN_FAILED', failure: 'unknown_id' };
  }
  if (!passwordMatches) return { ok: false, code: 'AUTH_ADMIN_FAILED', failure: 'wrong_password' };
  return { ok: true };
}

// 管理者の証明（ADM-2）。session：Cookie の値のハッシュで引いた admin_sessions の行（なければ null）、
// admin：その行の admin_id の管理者の行（session が null なら null）
export function checkAdminSession(session, admin) {
  if (session === null) return { ok: false, code: 'AUTH_REQUIRED' };
  // 管理者の行は消さないので、ここで null になるのはバグ（rules.md 1.1）
  if (admin === null) throw new Error('証明の行に当たる管理者の行がない');
  if (session.ended_at !== null || admin.deleted_at !== null || session.password_version !== admin.password_version) {
    return { ok: false, code: 'AUTH_REVOKED' };
  }
  return { ok: true };
}
