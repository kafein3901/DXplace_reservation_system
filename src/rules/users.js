// 利用者の入力（docs/design/detailed/rules.md 6.5。USR-7）
// 断る場合はない。置き換えるかどうかを決めるのは判定なので、api/ に書かずここに置く（architecture.md 4）

// existing：(role, そろえた学籍番号) で引いた users の行（なければ null）。
// input：検証を通った後の { name, cohort }（name は前後の空白を除いた値、教員の cohort は null）。
// 名前は正規化せずにそのまま比べる
export function decideUserInput(existing, input) {
  if (existing === null) return { ok: true, action: 'create' };
  if (existing.name !== input.name || existing.cohort !== input.cohort) return { ok: true, action: 'rename' };
  return { ok: true, action: 'unchanged' };
}
