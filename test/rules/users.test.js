// 登録・ログイン・名前と期生の変更（rules.md 6.5）
import { describe, expect, test } from 'vitest';
import { checkUserLogin, checkUserRegister, decideUserChange } from '../../src/rules/users.js';

const student = { id: 1, role: 'student', student_id: '12345678', name: '山田', cohort: 12 };
const teacher = { id: 2, role: 'teacher', student_id: 'tanaka.t', name: '田中', cohort: null };

describe('USR-3 登録（checkUserRegister）', () => {
  test('USR-3 行がなければ受け付ける', () => {
    expect(checkUserRegister(null)).toEqual({ ok: true });
  });

  test('USR-3 行があれば RULE_USER_DUPLICATE', () => {
    expect(checkUserRegister(student)).toEqual({ ok: false, code: 'RULE_USER_DUPLICATE' });
  });
});

describe('USR-3 ログイン（checkUserLogin）', () => {
  test('USR-3 行があれば受け付ける', () => {
    expect(checkUserLogin(student)).toEqual({ ok: true });
  });

  test('USR-3 行がなければ NOT_FOUND_USER', () => {
    expect(checkUserLogin(null)).toEqual({ ok: false, code: 'NOT_FOUND_USER' });
  });
});

describe('USR-7 名前・期生の変更（decideUserChange）', () => {
  test('USR-7 行がなければ NOT_FOUND_USER', () => {
    expect(decideUserChange(null, { name: '山田', cohort: 12 })).toEqual({ ok: false, code: 'NOT_FOUND_USER' });
  });

  test('USR-7 名前も期生も同じなら unchanged（教員は名前だけで決まる）', () => {
    expect(decideUserChange(student, { name: '山田', cohort: 12 })).toEqual({ ok: true, action: 'unchanged' });
    expect(decideUserChange(teacher, { name: '田中', cohort: null })).toEqual({ ok: true, action: 'unchanged' });
  });

  test.each([
    ['名前だけ違う', { name: '山田花子', cohort: 12 }],
    ['期生だけ違う', { name: '山田', cohort: 13 }],
    ['大文字と小文字の違い', { name: 'yamada', cohort: 12 }, { ...student, name: 'Yamada' }],
    ['全角と半角の違い', { name: 'ＹＡＭＡＤＡ', cohort: 12 }, { ...student, name: 'YAMADA' }],
  ])('USR-7 %s なら rename', (_, input, existing = student) => {
    expect(decideUserChange(existing, input)).toEqual({ ok: true, action: 'rename' });
  });
});
