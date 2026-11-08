// A7: ログの閲覧（期間・利用者・リソースで絞り込み、ページ送り）
import { h } from "../ui.js";
import { personLabel } from "../grid.js";
import { formatDateTime, fromInputs, addDays } from "../time.js";
import { call, showError, table, ACTION_NAMES, iso } from "./common.js";

const PAGE = 50;
const state = { from: "", to: "", userId: "", resourceId: "", offset: 0 };
let root = null;

export async function render(panel, ctx) {
  root = panel;
  // 利用者の一覧の「ログ」から来たときは、その人で絞り込む
  if (ctx.userId) {
    Object.assign(state, { userId: ctx.userId, resourceId: "", from: "", to: "", offset: 0 });
  }

  let users = [];
  let resources = [];
  try {
    [users, resources] = await Promise.all([
      call("admin_list_users", { p_query: null, p_include_deleted: true }),
      call("admin_list_resources"),
    ]);
  } catch (err) {
    showError(err);
  }

  const from = h("input", { type: "date", value: state.from, "aria-label": "開始日" });
  const to = h("input", { type: "date", value: state.to, "aria-label": "終了日" });
  const user = h("select", { "aria-label": "利用者" },
    h("option", { value: "" }, "すべての利用者"),
    users.map((u) => h("option", { value: u.id, selected: u.id === state.userId },
      `${personLabel(u)}${u.deleted_at ? "（削除済み）" : ""}`)));
  const resource = h("select", { "aria-label": "リソース" },
    h("option", { value: "" }, "すべてのリソース"),
    resources.map((r) => h("option", { value: r.id, selected: r.id === state.resourceId },
      `${r.name}${r.deleted_at ? "（削除済み）" : ""}`)));

  const form = h("form", { class: "row filter" },
    h("label", {}, "期間 ", from, " 〜 ", to), user, resource,
    h("button", { class: "btn btn-small", type: "submit" }, "絞り込む"));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    Object.assign(state, { from: from.value, to: to.value, userId: user.value, resourceId: resource.value, offset: 0 });
    load();
  });

  root.replaceChildren(h("div", { class: "card" }, h("h2", {}, "操作ログ"), form, h("div", { id: "log-list" })));
  await load();
}

async function load() {
  const list = root.querySelector("#log-list");
  try {
    const res = await call("admin_list_logs", {
      p_from: state.from ? iso(fromInputs(state.from, "00:00")) : null,
      // 終了日はその日を含める
      p_to: state.to ? iso(fromInputs(addDays(state.to, 1), "00:00")) : null,
      p_user_id: state.userId || null,
      p_resource_id: state.resourceId || null,
      p_limit: PAGE,
      p_offset: state.offset,
    });
    const rows = res.rows.map((l) => [
      formatDateTime(l.created_at),
      h("span", {}, l.actor_type === "admin" ? h("span", { class: "badge" }, "管理者") : null, ` ${l.actor_name ?? ""}`),
      ACTION_NAMES[l.action] ?? l.action,
      l.target_label ?? "",
      Object.keys(l.detail ?? {}).length
        ? h("details", {}, h("summary", {}, "詳細"), h("pre", { class: "json" }, JSON.stringify(l.detail, null, 2)))
        : "",
    ]);
    const page = Math.floor(state.offset / PAGE) + 1;
    const pages = Math.max(1, Math.ceil(res.total / PAGE));
    list.replaceChildren(
      h("p", { class: "muted small" }, `${res.total}件`),
      table(["日時", "操作者", "操作", "対象", ""], rows, "該当するログはありません。"),
      h("div", { class: "row pager" },
        h("button", { class: "btn btn-small", type: "button", disabled: state.offset === 0, onclick: () => move(-PAGE) }, "← 新しい"),
        h("span", { class: "muted small" }, `${page} / ${pages}`),
        h("button", { class: "btn btn-small", type: "button", disabled: state.offset + PAGE >= res.total, onclick: () => move(PAGE) }, "古い →")));
  } catch (err) {
    showError(err);
  }
}

function move(delta) {
  state.offset = Math.max(0, state.offset + delta);
  load();
}
