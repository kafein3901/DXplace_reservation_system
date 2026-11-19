// 登録・ログイン・名前と期生の変更（docs/design/detailed/api.md 8.15。USR-3〜USR-7, LOG-1）
// 共2・共3 は ledger.js が確かめ、期限の延長も ledger.js が付ける（api.md 8.12）。
// 3つとも、共3 から書き込みの終わりまで await がないので、ほぼ同時の要求も1つずつ処理される（RSV-23）。
// 端末と利用者は結びつけない（USR-3）
import { applyAutoTransitions } from './auto.js';
import { ok, refuse } from './respond.js';
import { hasStringFields } from '../lib/body.js';
import { validateCohort, validateName, validateRole, validateStudentId } from '../lib/validate.js';
import { checkUserLogin, checkUserRegister, decideUserChange } from '../rules/users.js';
import { insertEvent } from '../store/events.js';
import { findUserByIdentity, insertUser, updateUserProfile } from '../store/users.js';

// 段 1 の検証。画面の入力欄の並びと同じ順（role → student_id → name → cohort）。
// withProfile が偽（ログイン）なら名前・期生は読まない。
// 断るなら { ok: false, code }、通れば { ok: true, role, studentId, profile }（profile はログインでは null）
function validateInput(body, withProfile) {
  const role = validateRole(body.role);
  if (!role.ok) return role;
  const studentId = validateStudentId(role.value, body.student_id);
  if (!studentId.ok) return studentId;
  if (!withProfile) return { ok: true, role: role.value, studentId: studentId.value, profile: null };
  const name = validateName(body.name);
  if (!name.ok) return name;
  const cohort = validateCohort(role.value, body.cohort);
  if (!cohort.ok) return cohort;
  return { ok: true, role: role.value, studentId: studentId.value, profile: { name: name.value, cohort: cohort.value } };
}

// 3つの処理に共通の流れ（api.md 8.15.1）：共4 → 段 1 → transactionSync の中で自動の変化を反映し、行を引いて decide に渡す。
// 段 1 で断るときは何も書かず、自動の変化も反映しない。
// decide は { code }（断る。自動の変化は反映済み）か { user }（応答にする行）を返す
function handleUserInput({ storage, body, nowMin }, { withProfile, decide }) {
  const fields = withProfile ? ['role', 'student_id', 'name'] : ['role', 'student_id'];
  // 共4：cohort の型は段 1 で確かめる（rules.md 6.4）
  if (!hasStringFields(body, fields)) return refuse('INPUT_BODY');

  const input = validateInput(body, withProfile);
  if (!input.ok) return refuse(input.code);

  const sql = storage.sql;
  const result = storage.transactionSync(() => {
    applyAutoTransitions(sql, nowMin);
    const existing = findUserByIdentity(sql, input.role, input.studentId);
    return decide(sql, existing, input);
  });
  if (result.code !== undefined) return refuse(result.code);

  const { user } = result;
  return ok({ id: user.id, role: user.role, student_id: user.student_id, name: user.name, cohort: user.cohort });
}

// POST /api/me/register（api.md 8.15.2）。いなければ作る。いれば名前・期生が同じでも断る
export function registerUser(context) {
  const { now } = context;
  return handleUserInput(context, {
    withProfile: true,
    decide: (sql, existing, { role, studentId, profile }) => {
      const checked = checkUserRegister(existing);
      if (!checked.ok) return { code: checked.code };
      const user = insertUser(sql, { role, studentId, ...profile, createdAt: now });
      insertEvent(sql, { at: now, actor_kind: 'user', user_id: user.id, kind: 'user_created', detail: profile });
      return { user };
    },
  });
}

// POST /api/me/login（api.md 8.15.3）。引いて返すだけ。利用者の表には書かず、記録もしない
export function loginUser(context) {
  return handleUserInput(context, {
    withProfile: false,
    decide: (sql, existing) => {
      const checked = checkUserLogin(existing);
      if (!checked.ok) return { code: checked.code };
      return { user: existing };
    },
  });
}

// POST /api/me/change（api.md 8.15.4）。名前・期生がそれまでと違えば置き換える。
// 名前・期生を置き換えるのはこの API だけ（USR-7）
export function changeUser(context) {
  const { now } = context;
  return handleUserInput(context, {
    withProfile: true,
    decide: (sql, existing, { profile }) => {
      const decided = decideUserChange(existing, profile);
      if (!decided.ok) return { code: decided.code };
      if (decided.action === 'unchanged') return { user: existing };
      updateUserProfile(sql, existing.id, profile);
      // 片方だけ変わっても両方の前後を入れる。学籍番号は入れない（api.md 8.15.1）
      insertEvent(sql, {
        at: now,
        actor_kind: 'user',
        user_id: existing.id,
        kind: 'user_renamed',
        detail: { before: { name: existing.name, cohort: existing.cohort }, after: profile },
      });
      return { user: { ...existing, ...profile } };
    },
  });
}
