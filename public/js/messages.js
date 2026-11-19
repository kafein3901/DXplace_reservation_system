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
  INPUT_TIME: '時刻の形が正しくありません。',
  INPUT_DATE: '日付の形が正しくありません。',
  NOT_FOUND_DEVICE: 'この機器は見つかりません。削除された可能性があります。',
  RULE_PAST: '開始時刻は今以降、終了時刻は今より後にしてください。',
  RULE_TIME_ORDER: '終了時刻は開始時刻より後にしてください。',
  RULE_LENGTH: '1回の予約の長さの上限を超えています。',
  RULE_COUNT: '予約できる件数の上限に達しています。今の予約を使い終えるか取り消してから予約してください。',
  RULE_OVERLAP: 'ほかの予約と時間帯が重なっています。時刻を変えてください。',
  RULE_DEVICE_BUSY: 'この機器は今使えません。自分の予約なら「自分の予約」から利用開始してください。',
  INPUT_DEVICE_NAME: '機器の名前は1〜30文字で入れてください。改行は使えません。',
  RULE_DEVICE_NAME_DUPLICATE: '同じ名前の機器があります。',
  RULE_DEVICE_IN_USE: '利用中の予約があるため削除できません。予約の管理で利用を終了させてから削除してください。',
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
