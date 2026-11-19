// 登録・ログイン・名前と期生の変更（docs/design/detailed/rules.md 6.5。USR-3, USR-7）
// いるかいないかで断るのも判定なので、api/ に書かずここに置く（architecture.md 4）
//
// existing：(role, そろえた学籍番号) で引いた users の行（なければ null）

// 登録。すでにいれば名前・期生を比べずに断る（USR-3「すでにいる利用者は登録できない」）
export function checkUserRegister(existing) {
  if (existing !== null) return { ok: false, code: 'RULE_USER_DUPLICATE' };
  return { ok: true };
}

// ログイン。いなければ断る（USR-3「登録していない利用者はログインできない」）
export function checkUserLogin(existing) {
  if (existing === null) return { ok: false, code: 'NOT_FOUND_USER' };
  return { ok: true };
}

// 名前・期生の変更。input：検証を通った後の { name, cohort }（name は前後の空白を除いた値、教員の cohort は null）。
// 名前は正規化せずにそのまま比べる（USR-7「それまでと異なれば」）
export function decideUserChange(existing, input) {
  if (existing === null) return { ok: false, code: 'NOT_FOUND_USER' };
  if (existing.name !== input.name || existing.cohort !== input.cohort) return { ok: true, action: 'rename' };
  return { ok: true, action: 'unchanged' };
}
