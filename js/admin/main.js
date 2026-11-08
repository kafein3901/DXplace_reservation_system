// 管理画面（基本設計 6章 A1〜A8）
import { rpc, ApiError } from "../api.js";
import { h, toast } from "../ui.js";
import { auth, accessToken, setSignedOutHandler } from "./common.js";
import * as reservations from "./reservations.js";
import * as users from "./users.js";
import * as resources from "./resources.js";
import * as announcements from "./announcements.js";
import * as entry from "./entry.js";
import * as logs from "./logs.js";
import * as admins from "./admins.js";

const TABS = [
  { id: "reservations", label: "予約", mod: reservations },
  { id: "users", label: "利用者", mod: users },
  { id: "resources", label: "リソース", mod: resources },
  { id: "announcements", label: "お知らせ", mod: announcements },
  { id: "entry", label: "入口URL", mod: entry },
  { id: "logs", label: "ログ", mod: logs },
  { id: "admins", label: "管理者", mod: admins },
];
const TAB_KEY = "dx_admin_tab";

const $ = (id) => document.getElementById(id);

function showScreen(name) {
  for (const s of document.querySelectorAll("[data-screen]")) s.hidden = s.dataset.screen !== name;
  $("header-actions").hidden = name !== "app";
}

async function init() {
  setSignedOutHandler(() => showScreen("login"));
  $("login-form").addEventListener("submit", login);
  $("logout").addEventListener("click", logout);

  const token = await accessToken();
  if (token && (await checkAdmin(token)) === "admin") return startApp();
  showScreen("login");
}

// 管理者表にいるかを確かめる
//   戻り値: "admin"（管理者）/ "not_admin"（管理者表にいない）/ ApiError（確かめられなかった）
async function checkAdmin(token) {
  try {
    const who = await rpc("admin_whoami", {}, token);
    if (!who.is_admin) return "not_admin";
    $("admin-name").textContent = `${who.display_name} さん`;
    return "admin";
  } catch (err) {
    console.error("admin_whoami の呼び出しに失敗しました", err);
    return err;
  }
}

// 確かめられなかったときの説明（原因を探しやすいよう、状況とコードを出す）
function checkFailedMessage(err) {
  const d = err instanceof ApiError ? err.details ?? {} : {};
  if (d.status === 404) {
    return "管理者かどうかを確かめる関数（admin_whoami）が見つかりません。マイグレーションが適用されているか確かめてください（HTTP 404）。";
  }
  const code = err instanceof ApiError ? err.code : "UNKNOWN";
  const status = d.status ? ` / HTTP ${d.status}` : "";
  const detail = d.message ? ` / ${d.message}` : "";
  return `管理者かどうかを確かめられませんでした（${code}${status}${detail}）。`;
}

async function login(e) {
  e.preventDefault();
  const error = $("login-error");
  error.textContent = "";
  const button = e.submitter;
  button.disabled = true;
  try {
    const sb = await auth();
    const { data, error: authError } = await sb.auth.signInWithPassword({
      email: $("login-email").value.trim(),
      password: $("login-password").value,
    });
    if (authError) {
      error.textContent = "メールアドレスまたはパスワードが違います。";
      return;
    }
    const result = await checkAdmin(data.session.access_token);
    if (result !== "admin") {
      await sb.auth.signOut();
      error.textContent = result === "not_admin"
        ? "このアカウントは管理者として登録されていません（ログインはできましたが、管理者表にいません）。"
        : checkFailedMessage(result);
      return;
    }
    $("login-password").value = "";
    startApp();
  } finally {
    button.disabled = false;
  }
}

async function logout() {
  const sb = await auth();
  await sb.auth.signOut();
  showScreen("login");
}

function startApp() {
  showScreen("app");
  let initial = "reservations";
  try {
    initial = localStorage.getItem(TAB_KEY) ?? initial;
  } catch {
    /* 何もしない */
  }
  openTab(TABS.some((t) => t.id === initial) ? initial : "reservations");
}

// タブを開く。options は他のタブから絞り込み条件を渡すときに使う（例: ログを利用者で絞る）
export function openTab(id, options = {}) {
  const tab = TABS.find((t) => t.id === id);
  try {
    localStorage.setItem(TAB_KEY, id);
  } catch {
    /* 何もしない */
  }
  $("tabs").replaceChildren(...TABS.map((t) =>
    h("button", {
      class: `tab ${t.id === id ? "active" : ""}`,
      type: "button",
      "aria-current": t.id === id ? "page" : null,
      onclick: () => openTab(t.id),
    }, t.label)));
  const panel = $("panel");
  panel.replaceChildren(h("p", { class: "muted" }, "読み込み中…"));
  tab.mod.render(panel, { openTab, ...options }).catch((err) => {
    console.error(err);
    toast("画面を表示できませんでした。再読み込みしてください。");
  });
}

init();
