// 管理画面の共通処理
// 業務ルールの判定はすべて RPC（サーバー）で行う。ここでの判定は表示のためだけ
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";
import { getConfig } from "../config.js";
import { rpc, ApiError, errorMessage } from "../api.js";
import { h, toast } from "../ui.js";
import { dateKey, formatTime, formatDateTime, fromInputs } from "../time.js";

let client = null;
let onSignedOut = () => {};

// Supabase Auth のクライアント（管理者のログインにだけ使う）
export async function auth() {
  if (client) return client;
  const { supabaseUrl, anonKey } = await getConfig();
  client = createClient(supabaseUrl, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "dx_admin_auth" },
  });
  return client;
}

export function setSignedOutHandler(fn) {
  onSignedOut = fn;
}

export async function accessToken() {
  const sb = await auth();
  const { data } = await sb.auth.getSession();
  return data.session?.access_token ?? null;
}

// 管理者として RPC を呼ぶ。ログインが切れていればログイン画面に戻す
export async function call(name, params = {}) {
  const token = await accessToken();
  if (!token) {
    onSignedOut();
    throw new ApiError("NOT_ADMIN");
  }
  try {
    return await rpc(name, params, token);
  } catch (err) {
    if (err instanceof ApiError && err.code === "NOT_ADMIN") onSignedOut();
    throw err;
  }
}

// エラーをトーストで知らせる
export function showError(err) {
  toast(errorMessage(err, formatDateTime));
}

// 日付と時刻の入力欄（東京時間）。optional なら空欄を許す
export function dateTimeInput(ms, { optional = false, label = "" } = {}) {
  const d = h("input", { type: "date", value: ms != null ? dateKey(ms) : "", "aria-label": `${label}日付`, required: !optional });
  const t = h("input", { type: "time", value: ms != null ? formatTime(ms) : "", "aria-label": `${label}時刻`, required: !optional });
  const el = h("span", { class: "dt" }, d, t);
  return {
    el,
    // 空欄なら null、片方だけなら NaN
    value() {
      if (!d.value && !t.value) return optional ? null : NaN;
      if (!d.value || !t.value) return NaN;
      return fromInputs(d.value, t.value);
    },
    onInput(fn) {
      d.addEventListener("input", fn);
      t.addEventListener("input", fn);
    },
  };
}

export const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

// 表
export function table(headers, rows, empty = "ありません。") {
  if (rows.length === 0) return h("p", { class: "muted" }, empty);
  return h("div", { class: "table-wrap" },
    h("table", { class: "table" },
      h("thead", {}, h("tr", {}, headers.map((x) => h("th", { scope: "col" }, x)))),
      h("tbody", {}, rows.map((cells) => h("tr", {}, cells.map((c) => h("td", {}, c)))))));
}

// 操作ボタン
export function actionBtn(label, onclick, kind) {
  return h("button", { class: `btn btn-small ${kind ? `btn-${kind}` : ""}`, type: "button", onclick }, label);
}

// 操作ログの表示名
export const ACTION_NAMES = {
  "user.create": "アカウント作成",
  "user.login": "ログイン",
  "user.update": "利用者の情報の変更",
  "user.suspend": "利用停止",
  "user.unsuspend": "利用停止の解除",
  "user.delete": "アカウント削除",
  "user.restore": "アカウント復元",
  "reservation.create": "予約",
  "reservation.change": "予約の変更",
  "reservation.cancel": "予約の削除",
  "reservation.check_in": "チェックイン",
  "reservation.walk_in": "予約なしの利用",
  "reservation.check_out": "チェックアウト",
  "reservation.force_checkout": "強制終了",
  "reservation.block": "枠の封鎖",
  "resource.create": "リソースの追加",
  "resource.update": "リソースの変更",
  "resource.pause": "リソースの一時停止",
  "resource.resume": "一時停止の解除",
  "resource.delete": "リソースの削除",
  "token.issue": "入口URLの再発行",
  "announcement.create": "お知らせの作成",
  "announcement.update": "お知らせの編集",
  "announcement.delete": "お知らせの削除",
  "admin.create": "管理者の追加",
};
