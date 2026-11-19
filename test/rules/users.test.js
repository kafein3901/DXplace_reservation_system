// 利用者の入力（rules.md 6.5）
import { describe, expect, test } from 'vitest';
import { decideUserInput } from '../../src/rules/users.js';

const student = { id: 1, role: 'student', student_id: '12345678', name: '山田', cohort: 12 };
const teacher = { id: 2, role: 'teacher', student_id: 'tanaka.t', name: '田中', cohort: null };

describe('USR-7 利用者の入力（decideUserInput）', () => {
  test('USR-7 行がなければ create', () => {
    expect(decideUserInput(null, { name: '山田', cohort: 12 })).toEqual({ ok: true, action: 'create' });
  });

  test('USR-7 名前も期生も同じなら unchanged（教員は名前だけで決まる）', () => {
    expect(decideUserInput(student, { name: '山田', cohort: 12 })).toEqual({ ok: true, action: 'unchanged' });
    expect(decideUserInput(teacher, { name: '田中', cohort: null })).toEqual({ ok: true, action: 'unchanged' });
  });

  test.each([
    ['名前だけ違う', { name: '山田花子', cohort: 12 }],
    ['期生だけ違う', { name: '山田', cohort: 13 }],
    ['大文字と小文字の違い', { name: 'yamada', cohort: 12 }, { ...student, name: 'Yamada' }],
    ['全角と半角の違い', { name: 'ＹＡＭＡＤＡ', cohort: 12 }, { ...student, name: 'YAMADA' }],
  ])('USR-7 %s なら rename', (_, input, existing = student) => {
    expect(decideUserInput(existing, input)).toEqual({ ok: true, action: 'rename' });
  });
});
