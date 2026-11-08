// A3: 利用者の管理（検索、編集、利用停止と解除、削除と復元）
import { ApiError } from "../api.js";
import { h, openDialog, closeDialog, confirmAction, toast, busy } from "../ui.js";
import { personLabel } from "../grid.js";
import { renderPlainText } from "../markdown.js";
import { formatDateTime } from "../time.js";
import { call, showError, table, actionBtn } from "./common.js";

const state = { query: "", includeDeleted: false };
let root = null;
let ctx = null;

export async function render(panel, context) {
  root = panel;
  ctx = context;
  const q = h("input", { type: "search", value: state.query, placeholder: "氏名で検索", "aria-label": "氏名で検索" });
  const del = h("input", { type: "checkbox", checked: state.includeDeleted });
  const form = h("form", { class: "row filter" },
    q,
    h("label", { class: "check" }, del, "削除済みも表示"),
    h("button", { class: "btn btn-small", type: "submit" }, "検索"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    state.query = q.value;
    state.includeDeleted = del.checked;
    load();
  });
  const list = h("div", { id: "user-list" });
  root.replaceChildren(h("div", { class: "card" }, h("h2", {}, "利用者"), form, list));
  await load();
}

async function load() {
  const list = root.querySelector("#user-list");
  try {
    const users = await call("admin_list_users", { p_query: state.query || null, p_include_deleted: state.includeDeleted });
    list.replaceChildren(table(["氏名", "メモ", "状態", "登録", ""], users.map((u) => {
      const memo = h("span", { class: "memo" });
      renderPlainText(memo, u.memo);
      return [
        personLabel(u),
        memo,
        u.deleted_at ? h("span", { class: "badge" }, "削除済み") : u.suspended ? h("span", { class: "badge badge-new" }, "利用停止中") : "有効",
        formatDateTime(u.created_at),
        h("div", { class: "row" }, actions(u)),
      ];
    }), "該当する利用者はいません。"));
  } catch (err) {
    showError(err);
  }
}

function actions(u) {
  const logBtn = actionBtn("ログ", () => ctx.openTab("logs", { userId: u.id, userLabel: personLabel(u) }));
  if (u.deleted_at) {
    return [
      actionBtn("復元", (e) => run(e.currentTarget, "user", () => call("admin_restore_user", { p_user_id: u.id }), "復元しました。")),
      logBtn,
    ];
  }
  return [
    actionBtn("編集", () => openEdit(u)),
    u.suspended
      ? actionBtn("停止を解除", (e) => run(e.currentTarget, null, () => call("admin_unsuspend_user", { p_user_id: u.id }), "利用停止を解除しました。"))
      : actionBtn("利用停止", async (e) => {
        const b = e.currentTarget;
        if (await confirmAction("利用停止", `${personLabel(u)} を利用停止にしますか？ 未来の予約はキャンセルされます。`, "利用停止にする", "danger")) {
          run(b, null, () => call("admin_suspend_user", { p_user_id: u.id }), "利用停止にしました。");
        }
      }, "danger"),
    actionBtn("削除", async (e) => {
      const b = e.currentTarget;
      if (await confirmAction("アカウントの削除",
        `${personLabel(u)} を削除しますか？ メモは消え、未来の予約はキャンセル、利用中の予約は終了します。あとで復元できます（メモは戻りません）。`,
        "削除する", "danger")) {
        run(b, null, () => call("admin_delete_user", { p_user_id: u.id }), "削除しました。");
      }
    }, "danger"),
    logBtn,
  ];
}

async function run(button, _kind, fn, message) {
  await busy(button, async () => {
    try {
      await fn();
      closeDialog();
      toast(message, "ok");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "IDENTITY_CONFLICT") {
        toast(`同じ識別子の有効なアカウント（${personLabel(err.details)}）があるため、できません。`);
        return;
      }
      showError(err);
    }
  });
}

function openEdit(u) {
  const name = h("input", { type: "text", maxlength: "50", required: true, value: u.name });
  const teacher = h("input", { type: "checkbox", checked: u.cohort == null });
  const cohort = h("input", { type: "number", min: "1", value: u.cohort ?? "", disabled: u.cohort == null });
  teacher.addEventListener("change", () => {
    cohort.disabled = teacher.checked;
    if (teacher.checked) cohort.value = "";
  });
  const memo = h("textarea", { maxlength: "500", rows: "3" }, u.memo);
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "保存");
  const form = h("form", { class: "form" },
    h("label", {}, "氏名", name),
    h("div", { class: "row" }, h("label", { class: "grow" }, "期生", cohort), h("label", { class: "check" }, teacher, "教員")),
    h("label", {}, "メモ", memo),
    h("div", { class: "actions" }, submit));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(submit, null, () => call("admin_update_user", {
      p_user_id: u.id, p_name: name.value, p_cohort: teacher.checked ? null : Number(cohort.value), p_memo: memo.value,
    }), "保存しました。");
  });
  openDialog("利用者の編集", form);
}
