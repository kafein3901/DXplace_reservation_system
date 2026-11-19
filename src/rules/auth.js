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
