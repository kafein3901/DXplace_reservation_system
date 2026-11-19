// コード → 文（screens.md 2.2・5）。表は機能ごとの実装で足す
const GENERIC = 'うまくいきませんでした。時間をおいてもう一度試してください。';
const RELOAD = '画面が古い可能性があります。再読み込みしてください。';

// 共通の表（screens.md 5.1・5.3）
const COMMON = {
  NOT_FOUND_API: RELOAD,
  INPUT_BODY: RELOAD,
  INPUT_ROLE: '生徒か教員かを選んでください。',
  INPUT_STUDENT_ID: '学籍番号の形が正しくありません。生徒は8桁の数字、教員は英数字と「. _ -」で64文字以内です。',
  INPUT_NAME: '名前は1〜30文字で入れてください。改行は使えません。',
  INPUT_COHORT: '期生は1以上の整数で入れてください。',
  NOT_FOUND_USER: '登録されていません。初めて使うときは「初めて使う人は登録」から登録してください。',
  RULE_USER_DUPLICATE: 'この学籍番号はすでに登録されています。ログインしてください。',
  AUTH_REQUIRED: 'QR コードを読んでください。',
  AUTH_REVOKED: 'QR コードが新しくなりました。読み直してください。',
  AUTH_SHARED_INFO_UNSET: 'まだ利用を始められません。管理者に確かめてください。',
  AUTH_SHARED_INFO_WRONG: 'QR コードが古いか、正しくありません。掲示されている QR コードを読み直してください。',
  LIMIT_ATTEMPTS: '失敗が続いたため、しばらく受け付けません。10分ほどおいてから試してください。',
  AUTH_ADMIN_FAILED: 'ID かパスワードが違います。',
};

// 管理者の画面の置き換え（screens.md 5.3）
const ADMIN = {
  AUTH_REQUIRED: '認証してください。',
  AUTH_REVOKED: '認証が解けました。パスワードが設定し直されたか、アカウントが削除された可能性があります。',
};

// screen は 'user'（既定）か 'admin'。表にないコードと null には汎用の文を返す
export function messageFor(code, screen = 'user') {
  if (screen === 'admin' && Object.hasOwn(ADMIN, code)) return ADMIN[code];
  return Object.hasOwn(COMMON, code) ? COMMON[code] : GENERIC;
}
