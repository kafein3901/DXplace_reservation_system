// A5: お知らせの管理（作成、編集、削除）。公開中かどうかはサーバーが時刻から導出する
import { h, openDialog, closeDialog, confirmAction, toast, busy } from "../ui.js";
import { renderMarkdown } from "../markdown.js";
import { formatDateTime, toMs } from "../time.js";
import { call, showError, table, actionBtn, dateTimeInput, iso } from "./common.js";

const STATE_NAMES = { published: "公開中", scheduled: "公開前", ended: "公開終了", deleted: "削除済み" };
const state = { includeDeleted: false };
let root = null;

export async function render(panel) {
  root = panel;
  const del = h("input", { type: "checkbox", checked: state.includeDeleted });
  del.addEventListener("change", () => {
    state.includeDeleted = del.checked;
    load();
  });
  root.replaceChildren(h("div", { class: "card" },
    h("div", { class: "row space" }, h("h2", {}, "お知らせ"), actionBtn("作成", () => openEdit(null), "primary")),
    h("label", { class: "check" }, del, "削除済みも表示"),
    h("div", { id: "ann-list" })));
  await load();
}

async function load() {
  const list = root.querySelector("#ann-list");
  try {
    const items = await call("admin_list_announcements", { p_include_deleted: state.includeDeleted });
    list.replaceChildren(table(["タイトル", "重要度", "公開期間", "状態", ""], items.map((a) => [
      a.title,
      a.importance === "important" ? h("span", { class: "badge badge-new" }, "重要") : "通常",
      `${formatDateTime(a.publish_start_at)} 〜 ${a.publish_end_at ? formatDateTime(a.publish_end_at) : "無期限"}`,
      STATE_NAMES[a.publish_state] ?? a.publish_state,
      a.deleted_at ? "" : h("div", { class: "row" },
        actionBtn("編集", () => openEdit(a)),
        actionBtn("削除", async (e) => {
          const b = e.currentTarget;
          if (await confirmAction("お知らせの削除", `「${a.title}」を削除しますか？`, "削除する", "danger")) {
            run(b, () => call("admin_delete_announcement", { p_id: a.id }), "削除しました。");
          }
        }, "danger")),
    ]), "お知らせはありません。"));
  } catch (err) {
    showError(err);
  }
}

async function run(button, fn, message) {
  await busy(button, async () => {
    try {
      await fn();
      closeDialog();
      toast(message, "ok");
      await load();
    } catch (err) {
      showError(err);
    }
  });
}

function openEdit(a) {
  const title = h("input", { type: "text", maxlength: "100", required: true, value: a?.title ?? "" });
  const importance = h("select", {},
    h("option", { value: "normal", selected: a?.importance !== "important" }, "通常（一覧に表示）"),
    h("option", { value: "important", selected: a?.importance === "important" }, "重要（トップページの上部に常に表示）"));
  // 新しいお知らせは、既定ですぐに公開する（今の分から）
  const start = dateTimeInput(a ? toMs(a.publish_start_at) : Math.floor(Date.now() / 60000) * 60000, { label: "公開の開始" });
  const end = dateTimeInput(a?.publish_end_at ? toMs(a.publish_end_at) : null, { optional: true, label: "公開の終了" });
  const body = h("textarea", { rows: "8", placeholder: "Markdown で書けます。" }, a?.body_md ?? "");
  const preview = h("div", { class: "md preview" });
  const refresh = () => renderMarkdown(preview, body.value || "（プレビュー）");
  body.addEventListener("input", refresh);
  refresh();
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, a ? "保存" : "作成");
  const form = h("form", { class: "form" },
    h("label", {}, "タイトル", title),
    h("label", {}, "重要度", importance),
    h("label", {}, "公開の開始", start.el),
    h("label", {}, "公開の終了（空欄なら無期限）", end.el),
    h("label", {}, "本文", body),
    h("div", {}, h("span", { class: "muted small" }, "プレビュー"), preview),
    h("div", { class: "actions" }, submit));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const params = {
      p_title: title.value, p_body_md: body.value, p_importance: importance.value,
      p_publish_start_at: iso(start.value()), p_publish_end_at: iso(end.value()),
    };
    run(submit, () => a
      ? call("admin_update_announcement", { p_id: a.id, ...params })
      : call("admin_create_announcement", params), a ? "保存しました。" : "作成しました。");
  });
  openDialog(a ? "お知らせの編集" : "お知らせの作成", form);
}
