// A2: 予約の管理（任意の予約の変更・削除・強制終了、枠の封鎖）
import { statusName } from "../api.js";
import { h, openDialog, closeDialog, confirmAction, toast, busy, notice } from "../ui.js";
import { renderGrid, personLabel } from "../grid.js";
import { renderMarkdown, renderPlainText } from "../markdown.js";
import { dateKey, dayStartMs, addDays, formatDate, formatTime, formatDateTime, toMs, MINUTE } from "../time.js";
import { call, showError, dateTimeInput, iso, table, actionBtn } from "./common.js";

const OCCUPYING = ["reserved", "in_use", "blocked"];
const state = { day: dateKey(Date.now()), resources: [], reservations: [] };
let root = null;

export async function render(panel) {
  root = panel;
  await load();
}

async function load() {
  try {
    const start = dayStartMs(state.day);
    const [resources, reservations] = await Promise.all([
      call("admin_list_resources"),
      call("admin_list_reservations", {
        p_from: iso(start), p_to: iso(start + 86400000), p_resource_id: null, p_user_id: null,
      }),
    ]);
    state.resources = resources.filter((r) => !r.deleted_at);
    state.reservations = reservations;
    draw();
  } catch (err) {
    showError(err);
  }
}

function draw() {
  const today = dateKey(Date.now());
  const nav = h("div", { class: "grid-nav" },
    h("button", { class: "icon-btn", type: "button", "aria-label": "前の日", onclick: () => go(addDays(state.day, -1)) }, "‹"),
    h("strong", { class: "grid-date" }, formatDate(dayStartMs(state.day) + 12 * 3600000)),
    h("button", { class: "icon-btn", type: "button", "aria-label": "次の日", onclick: () => go(addDays(state.day, 1)) }, "›"),
    h("button", { class: "btn btn-small", type: "button", disabled: state.day === today, onclick: () => go(today) }, "今日"),
    h("input", { type: "date", value: state.day, "aria-label": "日付を選ぶ", onchange: (e) => e.target.value && go(e.target.value) }),
    h("button", { class: "btn btn-small", type: "button", onclick: () => load() }, "↻ 再読み込み"));

  const gridBox = h("div");
  // グリッドには利用者の画面と同じく、占有中と実際に使われたものを描く
  const drawn = state.reservations.filter((r) =>
    OCCUPYING.includes(r.status) || (r.status === "finished" && (r.checked_in_at || r.kind === "block")));

  root.replaceChildren(
    h("div", { class: "card" },
      h("h2", {}, "予約と枠の封鎖"),
      h("p", { class: "muted small" }, "空いている所をタップ（PCではドラッグ）すると、枠を封鎖できます。予約をタップすると変更・削除・強制終了ができます。"),
      nav,
      gridBox),
    h("div", { class: "card" },
      h("h2", {}, "この日の予約の一覧（キャンセル・無断不参加を含む）"),
      table(["時間", "リソース", "予約者", "状態", ""],
        state.reservations.map((r) => [
          `${formatTime(r.start_at)}–${formatTime(r.effective_end)}`,
          r.resource_name,
          r.kind === "block" ? `封鎖: ${r.block_reason}` : personLabel(r.user),
          h("span", {}, statusName(r.status), r.kind === "walk_in" ? h("span", { class: "badge" }, "予約なし") : null),
          actionBtn("詳細", () => openDetail(r)),
        ]),
        "この日の予約はありません。")));

  if (state.resources.length === 0) {
    gridBox.append(h("p", { class: "muted" }, "リソースがありません。「リソース」タブで追加してください。"));
    return;
  }
  renderGrid(gridBox, {
    day: state.day,
    resources: state.resources,
    reservations: drawn,
    now: Date.now(),
    isToday: state.day === today,
    canWalkIn: () => false,
    onWalkIn: null,
    onSelect: (sel) => openBlock(sel),
    onReservation: (r) => openDetail(r),
    onMemo: (res) => openMemo(res),
  });
}

function go(day) {
  state.day = day;
  load();
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

// 枠の封鎖（理由が必要。上限の対象外）
function openBlock({ resource, startMs, endMs }) {
  const start = dateTimeInput(startMs, { label: "開始" });
  const end = dateTimeInput(endMs ?? startMs + 60 * MINUTE, { label: "終了" });
  const reason = h("input", { type: "text", maxlength: "100", required: true, placeholder: "例: メンテナンス" });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "封鎖する");
  const form = h("form", { class: "form" },
    h("p", { class: "lead" }, h("strong", {}, resource.name)),
    h("label", {}, "開始", start.el),
    h("label", {}, "終了", end.el),
    h("label", {}, "理由", reason),
    h("div", { class: "actions" }, submit));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(submit, () => call("admin_create_block", {
      p_resource_id: resource.id, p_start_at: iso(start.value()), p_end_at: iso(end.value()), p_reason: reason.value,
    }), "枠を封鎖しました。");
  });
  openDialog("枠の封鎖", form);
}

// 予約の詳細と操作
function openDetail(r) {
  const rows = [
    h("p", { class: "lead" }, h("strong", {}, r.resource_name), ` ${formatDateTime(r.start_at)}–${formatTime(r.effective_end)}`),
    h("p", {}, h("span", { class: `status status-${r.status}` }, statusName(r.status)),
      r.kind === "walk_in" ? h("span", { class: "badge" }, "予約なし") : null),
  ];
  if (r.kind === "block") {
    rows.push(h("p", {}, `理由: ${r.block_reason}`));
  } else if (r.user) {
    const memo = h("p", { class: "memo" });
    renderPlainText(memo, r.user.memo || "（メモなし）");
    rows.push(h("div", { class: "person" }, h("strong", {}, personLabel(r.user)), memo));
  }
  if (r.checked_in_at) rows.push(h("p", { class: "muted small" }, `チェックイン: ${formatDateTime(r.checked_in_at)}`));
  if (r.checked_out_at) rows.push(h("p", { class: "muted small" }, `チェックアウト: ${formatDateTime(r.checked_out_at)}`));
  if (r.cancelled_at) rows.push(h("p", { class: "muted small" }, `キャンセル: ${formatDateTime(r.cancelled_at)}`));

  const buttons = [];
  if (OCCUPYING.includes(r.status)) buttons.push(actionBtn("時刻を変更", () => openChange(r)));
  if (r.status === "in_use") {
    buttons.push(actionBtn("強制終了", async (e) => {
      const button = e.currentTarget;
      if (await confirmAction("強制終了", "この利用を今の時刻で終了させますか？", "強制終了する", "danger")) {
        run(button, () => call("admin_force_checkout", { p_reservation_id: r.id }), "強制終了しました。");
      }
    }, "danger"));
  }
  if (r.status === "reserved" || r.status === "blocked") {
    buttons.push(actionBtn(r.kind === "block" ? "封鎖を解除" : "予約を削除", async (e) => {
      const button = e.currentTarget;
      if (await confirmAction("削除", "この予約（封鎖）を削除しますか？", "削除する", "danger")) {
        run(button, () => call("admin_cancel_reservation", { p_reservation_id: r.id }), "削除しました。");
      }
    }, "danger"));
  }
  if (buttons.length) rows.push(h("div", { class: "actions" }, buttons));
  openDialog(r.kind === "block" ? "封鎖" : "予約", h("div", {}, rows));
}

// 任意の予約の時刻の変更（期限の制限なし。重複だけはサーバーで判定する）
function openChange(r) {
  const start = dateTimeInput(toMs(r.start_at), { label: "開始" });
  const end = dateTimeInput(toMs(r.end_at), { label: "終了" });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "変更する");
  const form = h("form", { class: "form" },
    h("p", { class: "lead" }, h("strong", {}, r.resource_name), ` ${r.kind === "block" ? "封鎖" : personLabel(r.user)}`),
    notice("管理者の変更には期限の制限がありません。終了を過去にすると、その時点で終了した扱いになります。", "warn"),
    h("label", {}, "開始", start.el),
    h("label", {}, "終了", end.el),
    h("div", { class: "actions" }, submit));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    run(submit, () => call("admin_update_reservation", {
      p_reservation_id: r.id, p_start_at: iso(start.value()), p_end_at: iso(end.value()),
    }), "変更しました。");
  });
  openDialog("時刻の変更", form);
}

function openMemo(res) {
  const body = h("div", { class: "md" });
  renderMarkdown(body, res.memo_md || "（メモはありません）");
  openDialog(res.name, body);
}
