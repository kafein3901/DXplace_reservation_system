// ログイン状態（localStorage の利用者 ID）。要件定義 2章「アカウント」
// localStorage が使えない環境でも画面が動くよう、読み書きはすべて try/catch で包む
const KEY = "dx_user_id";
const SEEN_KEY = "dx_announcements_seen_at";

export function getUserId() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setUserId(id) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* 保存できなくても、この画面の間はログイン状態を保つ */
  }
}

export function clearUserId() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 何もしない */
  }
}

// お知らせを最後に見た時刻（「新着」の印に使う）
export function takeAnnouncementsSeenAt(nowIso) {
  let prev = null;
  try {
    prev = localStorage.getItem(SEEN_KEY);
    localStorage.setItem(SEEN_KEY, nowIso);
  } catch {
    /* 何もしない */
  }
  return prev;
}
