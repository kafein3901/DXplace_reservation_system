// A4: リソースの管理（追加、名前・メモ・並び順の変更、一時停止と再開、削除）
import { h, openDialog, closeDialog, confirmAction, toast, busy, notice } from "../ui.js";
import { renderMarkdown } from "../markdown.js";
import { formatDateTime } from "../time.js";
import { call, showError, table, actionBtn } from "./common.js";

let root = null;

export async function render(panel) {
  root = panel;
  root.replaceChildren(
    h("div", { class: "card" },
      h("div", { class: "row space" },
        h("h2", {}, "リソース"),
        actionBtn("追加", () => openEdit(null), "primary")),
      h("div", { id: "resource-list" })));
  await load();
}

async function load() {
  const list = root.querySelector("#resource-list");
  try {
    const resources = await call("admin_list_resources");
    list.replaceChildren(table(["並び順", "名前", "状態", ""], resources.map((r) => [
      String(r.sort_order),
      r.name,
      r.deleted_at
        ? h("span", { class: "badge" }, `削除済み（${formatDateTime(r.deleted_at)}）`)
        : r.paused ? h("span", { class: "badge badge-new" }, `一時停止中${r.pause_reason ? `: ${r.pause_reason}` : ""}`) : "使用可",
      r.deleted_at ? "" : h("div", { class: "row" },
        actionBtn("編集", () => openEdit(r)),
        r.paused
          ? actionBtn("再開", (e) => run(e.currentTarget, () => call("admin_resume_resource", { p_resource_id: r.id }), "再開しました。"))
          : actionBtn("一時停止", () => openPause(r)),
        actionBtn("削除", async (e) => {
          const b = e.currentTarget;
          if (await confirmAction("リソースの削除",
            `「${r.name}」を削除しますか？ 未来の予約と封鎖はキャンセルされ、利用中の予約は終了します。`, "削除する", "danger")) {
            run(b, () => call("admin_delete_resource", { p_resource_id: r.id }), "削除しました。");
          }
        }, "danger")),
    ]), "リソースはまだありません。"));
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

// 追加と編集（メモは Markdown。プレビューは DOMPurify で無害化して表示する）
function openEdit(r) {
  const name = h("input", { type: "text", maxlength: "50", required: true, value: r?.name ?? "" });
  const sort = h("input", { type: "number", value: r?.sort_order ?? 0 });
  const memo = h("textarea", { rows: "6", placeholder: "Markdown で書けます。画像は外部の URL で参照します。" }, r?.memo_md ?? "");
  const preview = h("div", { class: "md preview" });
  const refresh = () => renderMarkdown(preview, memo.value || "（プレビュー）");
  memo.addEventListener("input", refresh);
  refresh();
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, r ? "保存" : "追加");
  const form = h("form", { class: "form" },
    h("label", {}, "名前", name),
    h("label", {}, "並び順（小さいほど左）", sort),
    h("label", {}, "メモ", memo),
    h("div", {}, h("span", { class: "muted small" }, "プレビュー"), preview),
    h("div", { class: "actions" }, submit));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const params = { p_name: name.value, p_memo_md: memo.value, p_sort_order: Number(sort.value) || 0 };
    run(submit, () => r
      ? call("admin_update_resource", { p_resource_id: r.id, ...params })
      : call("admin_create_resource", params), r ? "保存しました。" : "追加しました。");
  });
  openDialog(r ? "リソースの編集" : "リソースの追加", form);
}

function openPause(r) {
  const reason = h("input", { type: "text", maxlength: "100", placeholder: "例: 故障のため" });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "一時停止する");
  const form = h("form", { class: "form" },
    notice("一時停止中は、新しい予約とチェックインができなくなります。既存の予約は残ります。", "warn"),
    h("label", {}, "理由（任意・利用者に表示されます）", reason),
    h("div", { class: "actions" }, submit));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(submit, () => call("admin_pause_resource", { p_resource_id: r.id, p_reason: reason.value }), "一時停止しました。");
  });
  openDialog(`「${r.name}」の一時停止`, form);
}
