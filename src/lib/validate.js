// 入力の検証（docs/design/detailed/rules.md 1.2・6.2）
// 正しい入力なら { ok: true, value }（value はそろえた値）、違えば { ok: false, code }。
// 引数が文字列であることは api/ が先に確かめる（INPUT_BODY。error-codes.md 3.1）

// 全角の英数字と記号（U+FF01〜U+FF5E）を半角に直し、A〜Z を小文字にする。
// ほかの文字（全角の空白 U+3000 を含む）は変えない。学籍番号の正規化（USR-4）にも使う
export function toHalfWidthLower(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    const half = code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : ch;
    out += half >= 'A' && half <= 'Z' ? half.toLowerCase() : half;
  }
  return out;
}

// 管理者の ID（ADM-2、auth.md 5）。3〜32文字、a-z・0-9・-・_、先頭は a-z。前後の空白は除かない
const LOGIN_ID_PATTERN = /^[a-z][a-z0-9_-]{2,31}$/;

export function validateLoginId(s) {
  const value = toHalfWidthLower(s);
  if (!LOGIN_ID_PATTERN.test(value)) return { ok: false, code: 'INPUT_LOGIN_ID' };
  return { ok: true, value };
}

// 名前（USR-5。管理者の表示用の名前も同じ条件。ADM-2）。
// 改行と制御文字（Cc、U+2028、U+2029）は、前後の空白を除く前の値で確かめる
const FORBIDDEN_IN_NAME = /[\p{Cc}\u2028\u2029]/u;
const MAX_NAME_LENGTH = 30;

export function validateName(s) {
  return validateDisplayText(s, MAX_NAME_LENGTH, 'INPUT_NAME');
}

// 機器の名前（MNG-1、rules.md 6.6）。手順は validateName と同じで、コードだけが違う。
// 全角と半角、大文字と小文字はそろえない
const MAX_DEVICE_NAME_LENGTH = 30;

export function validateDeviceName(s) {
  return validateDisplayText(s, MAX_DEVICE_NAME_LENGTH, 'INPUT_DEVICE_NAME');
}

// 名前と機器の名前に共通の手順
function validateDisplayText(s, maxLength, code) {
  if (FORBIDDEN_IN_NAME.test(s)) return { ok: false, code };
  const value = s.trim();
  // 長さはコードポイントで数える（サロゲートペアを2文字と数えない）
  const length = [...value].length;
  if (length < 1 || length > maxLength) return { ok: false, code };
  return { ok: true, value };
}

// 管理者のパスワード（SEC-3、auth.md 5）。15〜128文字、すべて U+0021〜U+007E。そろえない
const PASSWORD_PATTERN = /^[\x21-\x7e]{15,128}$/;

export function validatePassword(s) {
  if (!PASSWORD_PATTERN.test(s)) return { ok: false, code: 'INPUT_PASSWORD' };
  return { ok: true, value: s };
}

// 利用者の入力の検証（rules.md 6.4。USR-3〜USR-6）。
// 利用者の入力（api.md 8.15）と、利用者の操作の API の識別の組（api.md 8.16）で使う

// 生徒か教員か（USR-3）。大文字・小文字はそろえない（画面が決まった値を送る）
export function validateRole(s) {
  if (s !== 'student' && s !== 'teacher') return { ok: false, code: 'INPUT_ROLE' };
  return { ok: true, value: s };
}

// 学籍番号（USR-4）。全角・大小をそろえてから形式を確かめる。先頭の0は残す。前後の空白は除かない。
// role は validateRole を通った値
const STUDENT_ID_PATTERN = /^[0-9]{8}$/;
const TEACHER_ID_PATTERN = /^[a-z0-9._-]{1,64}$/;

export function validateStudentId(role, s) {
  const value = toHalfWidthLower(s);
  const pattern = role === 'student' ? STUDENT_ID_PATTERN : TEACHER_ID_PATTERN;
  if (!pattern.test(value)) return { ok: false, code: 'INPUT_STUDENT_ID' };
  return { ok: true, value };
}

// 期生（USR-6）。生徒は 1 以上の安全な整数。型の誤りもここで断る（error-codes.md 3.1）。
// 教員は期生を持たないので、送られても見ずに null にする
export function validateCohort(role, v) {
  if (role === 'teacher') return { ok: true, value: null };
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) return { ok: false, code: 'INPUT_COHORT' };
  return { ok: true, value: v };
}
