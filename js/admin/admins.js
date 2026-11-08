// A8: 管理者（一覧と追加）。追加は Edge Function（admin-create-admin）で行う
import { getConfig } from "../config.js";
import { ApiError, errorMessage } from "../api.js";
import { h, openDialog, closeDialog, toast, busy } from "../ui.js";
import { formatDateTime } from "../time.js";
import { call, showError, table, actionBtn, accessToken } from "./common.js";

let root = null;

export async function render(panel) {
  root = panel;
  root.replaceChildren(h("div", { class: "card" },
    h("div", { class: "row space" }, h("h2", {}, "管理者"), actionBtn("追加", openAdd, "primary")),
    h("div", { id: "admin-list" })));
  await load();
}

async function load() {
  try {
    const admins = await call("admin_list_admins");
    root.querySelector("#admin-list").replaceChildren(
      table(["表示名", "メールアドレス", "追加"], admins.map((a) => [a.display_name, a.email, formatDateTime(a.created_at)])));
  } catch (err) {
    showError(err);
  }
}

// Edge Function を呼ぶ（呼び出した管理者の JWT を付ける）
async function createAdmin(params) {
  const { supabaseUrl, anonKey } = await getConfig();
  const res = await fetch(`${supabaseUrl}/functions/v1/admin-create-admin`, {
    method: "POST",
    headers: { apikey: anonKey, Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? "UNKNOWN", body.details ?? {});
  return body;
}

function openAdd() {
  const name = h("input", { type: "text", maxlength: "50", required: true, placeholder: "例: 担当教員" });
  const email = h("input", { type: "email", required: true, autocomplete: "off" });
  const password = h("input", { type: "password", minlength: "8", required: true, autocomplete: "new-password" });
  const error = h("p", { class: "field-error", role: "alert" });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "追加");
  const form = h("form", { class: "form" },
    h("label", {}, "表示名", name),
    h("label", {}, "メールアドレス", email),
    h("label", {}, "初期パスワード（8文字以上）", password),
    h("p", { class: "muted small" }, "初期パスワードは本人に直接伝えてください。機器を使うときは、管理者とは別に一般のアカウントを使います。"),
    error,
    h("div", { class: "actions" }, submit));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    error.textContent = "";
    busy(submit, async () => {
      try {
        await createAdmin({ email: email.value, password: password.value, display_name: name.value });
        closeDialog();
        toast("管理者を追加しました。", "ok");
        await load();
      } catch (err) {
        if (err instanceof ApiError) error.textContent = errorMessage(err);
        else showError(err);
      }
    });
  });
  openDialog("管理者の追加", form);
}
