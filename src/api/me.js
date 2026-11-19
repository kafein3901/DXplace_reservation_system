// 利用者の入力（docs/design/detailed/api.md 8.15。USR-3〜USR-7, LOG-1）
// 共2・共3 は ledger.js が確かめ、期限の延長も ledger.js が付ける（api.md 8.12）
import { applyAutoTransitions } from './auto.js';
import { ok, refuse } from './respond.js';
import { hasStringFields } from '../lib/body.js';
import { validateCohort, validateName, validateRole, validateStudentId } from '../lib/validate.js';
import { decideUserInput } from '../rules/users.js';
import { insertEvent } from '../store/events.js';
import { findUserByIdentity, insertUser, updateUserProfile } from '../store/users.js';

// POST /api/me。利用者を引き、いなければ作り、名前・期生がそれまでと違えば置き換える。
// 名前・期生を置き換えるのはこの API だけ（USR-7）。端末と利用者は結びつけない（USR-3）
export function postMe({ storage, body, now, nowMin }) {
  // 共4：cohort の型は段 1 で確かめる（rules.md 6.4）
  if (!hasStringFields(body, ['role', 'student_id', 'name'])) return refuse('INPUT_BODY');

  // 段 1：画面の入力欄の並びと同じ順。断るときは何も書かず、自動の変化も反映しない
  const role = validateRole(body.role);
  if (!role.ok) return refuse(role.code);
  const studentId = validateStudentId(role.value, body.student_id);
  if (!studentId.ok) return refuse(studentId.code);
  const name = validateName(body.name);
  if (!name.ok) return refuse(name.code);
  const cohort = validateCohort(role.value, body.cohort);
  if (!cohort.ok) return refuse(cohort.code);

  const sql = storage.sql;
  const input = { name: name.value, cohort: cohort.value };
  // 共3 からここまで await がないので、ほぼ同時の入力も1つずつ処理される（RSV-23）
  const user = storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    const existing = findUserByIdentity(sql, role.value, studentId.value);
    const { action } = decideUserInput(existing, input);

    if (action === 'create') {
      const created = insertUser(sql, { role: role.value, studentId: studentId.value, ...input, createdAt: now });
      insertEvent(sql, { at: now, actor_kind: 'user', user_id: created.id, kind: 'user_created', detail: input });
      return created;
    }
    if (action === 'rename') {
      updateUserProfile(sql, existing.id, input);
      // 片方だけ変わっても両方の前後を入れる。学籍番号は入れない（api.md 8.15）
      insertEvent(sql, {
        at: now,
        actor_kind: 'user',
        user_id: existing.id,
        kind: 'user_renamed',
        detail: { before: { name: existing.name, cohort: existing.cohort }, after: input },
      });
      return { ...existing, ...input };
    }
    return existing;
  });

  return ok({ id: user.id, role: user.role, student_id: user.student_id, name: user.name, cohort: user.cohort });
}
