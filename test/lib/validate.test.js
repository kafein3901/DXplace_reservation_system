// 管理者の入力の検証（rules.md 6.2）
import { describe, expect, test } from 'vitest';
import {
  toHalfWidthLower,
  validateCohort,
  validateDeviceName,
  validateLoginId,
  validateName,
  validatePassword,
  validateRole,
  validateSettingValue,
  validateStudentId,
} from '../../src/lib/validate.js';

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

describe('MNG-1 機器の名前（validateDeviceName）', () => {
  test.each([
    ['1文字', 'P', 'P'],
    ['30文字', 'あ'.repeat(30), 'あ'.repeat(30)],
    ['前後の空白を除いて30文字', ` ${'あ'.repeat(30)}　`, 'あ'.repeat(30)],
    ['前後の空白・全角の空白を除く', '　PC 1 ', 'PC 1'],
    ['全角の英数字をそのまま返す', 'ＰＣ１', 'ＰＣ１'],
  ])('MNG-1 %s を受け付ける', (_, input, value) => {
    expect(validateDeviceName(input)).toEqual({ ok: true, value });
  });

  test.each([
    ['空', ''],
    ['空白だけ', ' 　 '],
    ['31文字', 'あ'.repeat(31)],
    ['途中の改行', 'PC\n1'],
    ['末尾の改行', 'PC1\n'],
    ['タブ', 'PC\t1'],
    ['U+0000', 'PC1\u0000'],
  ])('MNG-1 %s は INPUT_DEVICE_NAME', (_, input) => {
    expect(validateDeviceName(input)).toEqual({ ok: false, code: 'INPUT_DEVICE_NAME' });
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

// 利用者の入力の検証（rules.md 6.4）
describe('USR-3 生徒か教員か（validateRole）', () => {
  test.each(['student', 'teacher'])('USR-3 %s を受け付ける', (input) => {
    expect(validateRole(input)).toEqual({ ok: true, value: input });
  });

  test.each(['Student', 'admin', ''])('USR-3 %j は INPUT_ROLE', (input) => {
    expect(validateRole(input)).toEqual({ ok: false, code: 'INPUT_ROLE' });
  });
});

describe('USR-4 学籍番号（validateStudentId、生徒）', () => {
  test.each([
    ['12345678', '12345678'],
    ['00000001', '00000001'],
    ['１２３４５６７８', '12345678'],
  ])('USR-4 %s を受け付けて %s にそろえる（先頭の0は残す）', (input, value) => {
    expect(validateStudentId('student', input)).toEqual({ ok: true, value });
  });

  test.each([
    ['7桁', '1234567'],
    ['先頭の0を省いた7桁', '0000001'],
    ['9桁', '123456789'],
    ['英字を含む', '1234567a'],
    ['前に空白', ' 12345678'],
    ['後ろに空白', '12345678 '],
    ['空', ''],
  ])('USR-4 %s は INPUT_STUDENT_ID', (_, input) => {
    expect(validateStudentId('student', input)).toEqual({ ok: false, code: 'INPUT_STUDENT_ID' });
  });
});

describe('USR-4 学籍番号（validateStudentId、教員）', () => {
  test.each([
    ['a', 'a'],
    ['a'.repeat(64), 'a'.repeat(64)],
    ['12345678', '12345678'],
    ['Tanaka.T', 'tanaka.t'],
    ['ａ－ｂ．ｃ＿ｄ', 'a-b.c_d'],
  ])('USR-4 %s を受け付けて %s にそろえる', (input, value) => {
    expect(validateStudentId('teacher', input)).toEqual({ ok: true, value });
  });

  test.each([
    ['空', ''],
    ['65文字', 'a'.repeat(65)],
    ['空白を含む', 'tanaka t'],
    ['@ を含む', 'tanaka@t'],
    ['ひらがな', 'たなか'],
    ['長音符', 'tanakaー'],
  ])('USR-4 %s は INPUT_STUDENT_ID', (_, input) => {
    expect(validateStudentId('teacher', input)).toEqual({ ok: false, code: 'INPUT_STUDENT_ID' });
  });
});

describe('USR-6 期生（validateCohort）', () => {
  test.each([1, Number.MAX_SAFE_INTEGER])('USR-6 生徒の %d を受け付ける', (input) => {
    expect(validateCohort('student', input)).toEqual({ ok: true, value: input });
  });

  test.each([
    ['ない', undefined],
    ['null', null],
    ['0', 0],
    ['負の数', -1],
    ['小数', 1.5],
    ['文字列', '1'],
    ['安全な整数を超える', Number.MAX_SAFE_INTEGER + 1],
  ])('USR-6 生徒で %s は INPUT_COHORT', (_, input) => {
    expect(validateCohort('student', input)).toEqual({ ok: false, code: 'INPUT_COHORT' });
  });

  test.each([
    ['ない', undefined],
    ['文字列', 'abc'],
    ['0', 0],
    ['数', 5],
  ])('USR-6 教員は %s でも受け付けて null にする', (_, input) => {
    expect(validateCohort('teacher', input)).toEqual({ ok: true, value: null });
  });
});

describe('RSV-25 数値の変更の値（validateSettingValue）', () => {
  const MINUTE_MAX = Math.floor(Number.MAX_SAFE_INTEGER / 60000);
  const minuteKeys = ['grace_minutes', 'max_length_minutes'];

  test.each([1, 3, Number.MAX_SAFE_INTEGER])('RSV-25 max_count の %d を受け付ける', (input) => {
    expect(validateSettingValue('max_count', input)).toEqual({ ok: true, value: input });
  });

  test.each(minuteKeys.flatMap((key) => [1, 15, MINUTE_MAX].map((v) => [key, v])))(
    'RSV-25 %s の %d を受け付ける',
    (key, input) => {
      expect(validateSettingValue(key, input)).toEqual({ ok: true, value: input });
    },
  );

  test.each([
    ['0', 0],
    ['負の数', -1],
    ['小数', 1.5],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['安全な整数を超える', Number.MAX_SAFE_INTEGER + 1],
  ])('RSV-25 max_count で %s は INPUT_SETTING_VALUE', (_, input) => {
    expect(validateSettingValue('max_count', input)).toEqual({ ok: false, code: 'INPUT_SETTING_VALUE' });
  });

  test.each(minuteKeys.flatMap((key) => [[key, 0], [key, 1.5], [key, MINUTE_MAX + 1], [key, Number.MAX_SAFE_INTEGER]]))(
    'RSV-25 %s で %d は INPUT_SETTING_VALUE（ミリ秒に直すと安全な整数を超えるものを含む）',
    (key, input) => {
      expect(validateSettingValue(key, input)).toEqual({ ok: false, code: 'INPUT_SETTING_VALUE' });
    },
  );
});
