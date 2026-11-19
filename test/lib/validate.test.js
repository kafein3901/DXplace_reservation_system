// 管理者の入力の検証（rules.md 6.2）
import { describe, expect, test } from 'vitest';
import { toHalfWidthLower, validateLoginId, validateName, validatePassword } from '../../src/lib/validate.js';

describe('ADM-2 全角・大小のそろえ方（toHalfWidthLower）', () => {
  test('ADM-2 全角の英数字と記号を半角に、英字を小文字にする', () => {
    expect(toHalfWidthLower('ＴＡＮＡＫＡ＿０１－ａ')).toBe('tanaka_01-a');
    expect(toHalfWidthLower('Tanaka')).toBe('tanaka');
  });

  test('ADM-2 全角の空白・ひらがなは変えない', () => {
    expect(toHalfWidthLower('\u3000た')).toBe('\u3000た');
  });
});

describe('ADM-2 管理者の ID（validateLoginId）', () => {
  test.each([
    ['abc', 'abc'],
    ['a'.repeat(32), 'a'.repeat(32)],
    ['ＴＡＮＡＫＡ', 'tanaka'],
    ['Tanaka', 'tanaka'],
    ['a-_1', 'a-_1'],
  ])('ADM-2 %s を受け付けて %s にそろえる', (input, value) => {
    expect(validateLoginId(input)).toEqual({ ok: true, value });
  });

  test.each([
    ['2文字', 'ab'],
    ['33文字', 'a'.repeat(33)],
    ['先頭が数字', '1abc'],
    ['先頭が -', '-abc'],
    ['先頭が _', '_abc'],
    ['. を含む', 'ab.c'],
    ['@ を含む', 'ab@c'],
    ['前に空白', ' abc'],
    ['後ろに空白', 'abc '],
    ['全角の空白', 'ab\u3000c'],
    ['ひらがな', 'たなか'],
  ])('ADM-2 %s は INPUT_LOGIN_ID', (_, input) => {
    expect(validateLoginId(input)).toEqual({ ok: false, code: 'INPUT_LOGIN_ID' });
  });
});

describe('USR-5 名前（validateName）', () => {
  test.each([
    ['1文字', '田', '田'],
    ['30文字', 'あ'.repeat(30), 'あ'.repeat(30)],
    ['前後の空白を除いて30文字', `  ${'あ'.repeat(30)}\u3000`, 'あ'.repeat(30)],
    ['前後の空白・全角の空白を除く', '\u3000田中 太郎 ', '田中 太郎'],
    ['絵文字1つを1文字と数える', '\u{1F600}'.repeat(30), '\u{1F600}'.repeat(30)],
  ])('USR-5 %s を受け付ける', (_, input, value) => {
    expect(validateName(input)).toEqual({ ok: true, value });
  });

  test.each([
    ['空', ''],
    ['空白だけ', ' \u3000 '],
    ['31文字', 'あ'.repeat(31)],
    ['途中の改行', '田中\n太郎'],
    ['末尾の改行', '田中\n'],
    ['末尾の CR', '田中\r'],
    ['タブ', '田中\t太郎'],
    ['U+0000', '田中\u0000'],
    ['U+2028', '田中\u2028太郎'],
    ['U+2029', '田中\u2029太郎'],
  ])('USR-5 %s は INPUT_NAME', (_, input) => {
    expect(validateName(input)).toEqual({ ok: false, code: 'INPUT_NAME' });
  });
});

describe('SEC-3 パスワード（validatePassword）', () => {
  test.each([
    ['15文字', 'a'.repeat(15)],
    ['128文字', 'a'.repeat(128)],
    ['記号を含む', 'Abc!@#$%^&*()_+-=~'],
  ])('SEC-3 %s を受け付け、そろえない', (_, input) => {
    expect(validatePassword(input)).toEqual({ ok: true, value: input });
  });

  test.each([
    ['14文字', 'a'.repeat(14)],
    ['129文字', 'a'.repeat(129)],
    ['空白を含む', 'abcdefg hijklmnop'],
    ['全角の文字', 'ａbcdefghijklmnop'],
    ['ひらがな', 'あbcdefghijklmnop'],
  ])('SEC-3 %s は INPUT_PASSWORD', (_, input) => {
    expect(validatePassword(input)).toEqual({ ok: false, code: 'INPUT_PASSWORD' });
  });
});
