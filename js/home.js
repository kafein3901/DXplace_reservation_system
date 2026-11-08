// トップページ（基本設計 6章 U1〜U14）
// 重複・上限などの判定は表示のためだけに行う。最終的な判定はサーバー（RPC）で行う
import { rpc, ApiError, errorMessage, statusName } from "./api.js";
import { captureEntryToken, getToken } from "./token.js";
import { getUserId, setUserId, clearUserId, takeAnnouncementsSeenAt } from "./session.js";
import {
  syncClock, nowMs, toMs, formatTime, formatDate, formatDateTime, dateKey, dayStartMs,
  fromInputs, toTimeInput, addDays, ceilMinute, formatDuration, MINUTE,
} from "./time.js";
import { renderMarkdown, renderPlainText } from "./markdown.js";
import { renderGrid, personLabel } from "./grid.js";
import { h, openDialog, closeDialog, choose, confirmAction, toast, busy, notice } from "./ui.js";

const LIMIT = 3;
const OCCUPYING = ["reserved", "in_use", "blocked"];

const state = {
  token: null,
  me: null,
  today: null,
  day: null,
  resources: [],
  reservations: [],
  myReservations: [],
  announcements: [],
  seenAt: null,
};

const $ = (id) => document.getElementById(id);

// ============================================================
// 起動と読み込み
// ============================================================
async function init() {
  captureEntryToken();
  // 開いたままのページで入口URLを開き直したとき（# だけが変わり、読み込み直されない）
  window.addEventListener("hashchange", () => {
    if (captureEntryToken()) location.reload();
  });
  state.token = getToken();
  if (!state.token) return showScreen("no-cookie");

  $("reload").addEventListener("click", (e) => busy(e.currentTarget, () => load()));
  $("account").addEventListener("click", () => openAccount());
  await load();
}

function showScreen(name) {
  for (const s of document.querySelectorAll("[data-screen]")) s.hidden = s.dataset.screen !== name;
  $("header-actions").hidden = name !== "main";
}

async function load() {
  try {
    const data = await call("get_home", { p_user_id: getUserId(), p_day: state.day });
    syncClock(data.server_now);
    state.today = dateKey(nowMs());
    state.day ??= state.today;
    state.me = data.me;
    state.resources = data.resources;
    state.reservations = data.reservations;
    state.myReservations = data.my_reservations;
    state.announcements = data.announcements;
    if (state.seenAt === null) state.seenAt = takeAnnouncementsSeenAt(data.server_now) ?? "";
    $("updated").textContent = `${formatTime(nowMs())}更新`;
    showScreen("main");
    renderAll();
  } catch (err) {
    handleError(err);
  }
}

async function changeDay(day) {
  state.day = day;
  try {
    const data = await call("get_day", { p_user_id: state.me?.id ?? null, p_day: day });
    syncClock(data.server_now);
    state.today = dateKey(nowMs());
    state.reservations = data.reservations;
    renderGridArea();
  } catch (err) {
    handleError(err);
  }
}

// 利用者向けの RPC は、必ず入口トークンを付けて呼ぶ
function call(name, params = {}) {
  return rpc(name, { p_token: state.token, ...params });
}

// 「アカウントが見つからない」は、ログアウトして読み直す
async function handleError(err) {
  if (err instanceof ApiError && err.code === "INVALID_TOKEN") return showScreen("invalid-token");
  if (err instanceof ApiError && err.code === "USER_NOT_FOUND" && getUserId()) {
    clearUserId();
    state.me = null;
    toast("アカウントが見つからないため、ログアウトしました。");
    return load();
  }
  toast(errorMessage(err, formatDateTime));
}

// 操作を実行し、成功したら読み直す
async function act(button, fn, successMessage) {
  return busy(button, async () => {
    try {
      await fn();
      closeDialog();
      if (successMessage) toast(successMessage, "ok");
      await load();
      return true;
    } catch (err) {
      await handleError(err);
      return false;
    }
  });
}

// ============================================================
// 描画
// ============================================================
function renderAll() {
  $("account").textContent = state.me ? personLabel(state.me) : "ログイン / 登録";
  renderImportant();
  renderMine();
  renderGridArea();
  renderNews();
}

const resourceOf = (id) => state.resources.find((r) => r.id === id);
const resourceName = (id) => resourceOf(id)?.name ?? "（削除されたリソース）";

// 1. 重要なお知らせ
function renderImportant() {
  const list = state.announcements.filter((a) => a.importance === "important");
  const box = $("important");
  box.hidden = list.length === 0;
  box.replaceChildren(...list.map((a) => {
    const body = h("div", { class: "md" });
    renderMarkdown(body, a.body_md);
    return h("article", { class: "important-item" }, h("h2", {}, a.title), body);
  }));
}

// 2. 自分の予約
function renderMine() {
  const box = $("mine");
  if (!state.me) {
    box.replaceChildren(
      h("h2", {}, "自分の予約"),
      h("p", { class: "muted" }, "グリッドの空いている所をタップすると、その場で予約できます（事前の登録は不要です）。"),
      h("button", { class: "btn", type: "button", onclick: () => openAccount() }, "ログイン / 登録"));
    return;
  }
  const items = state.myReservations.map((r) => myReservationCard(r));
  box.replaceChildren(
    h("h2", {}, "自分の予約"),
    items.length ? h("ul", { class: "mine-list" }, items) : h("p", { class: "muted" }, "予約はありません。"));
  if (state.me.suspended) box.prepend(notice("このアカウントは利用停止中です。予約とチェックインはできません。", "error"));
}

function myReservationCard(r) {
  const now = nowMs();
  const start = toMs(r.start_at);
  const end = toMs(r.end_at);
  let message;
  let kind = "";
  const buttons = [];

  if (r.status === "in_use") {
    message = `利用中: あと${formatDuration(end - now)}（${formatTime(end)}まで）`;
    kind = "inuse";
    buttons.push(btn("チェックアウト", (e) => checkOut(e.currentTarget, r), "primary"));
    buttons.push(btn("延長", () => openChange(r)));
  } else if (now >= start) {
    message = `${formatTime(start + 15 * MINUTE)}までにチェックインしてください`;
    kind = "urgent";
    buttons.push(btn("チェックイン", (e) => checkIn(e.currentTarget, r), "primary"));
    buttons.push(btn("変更", () => openChange(r)));
    buttons.push(btn("削除", (e) => cancel(e.currentTarget, r), "danger"));
  } else {
    message = `${formatDateTime(start)}–${formatTime(end)}`;
    buttons.push(btn("チェックイン", (e) => checkIn(e.currentTarget, r)));
    buttons.push(btn("変更", () => openChange(r)));
    buttons.push(btn("削除", (e) => cancel(e.currentTarget, r), "danger"));
  }
  return h("li", { class: `mine-item ${kind}` },
    h("div", { class: "mine-title" }, resourceName(r.resource_id), r.kind === "walk_in" ? h("span", { class: "badge" }, "予約なし") : null),
    h("div", { class: "mine-msg" }, message),
    h("div", { class: "actions" }, buttons));
}

function btn(label, onclick, kind) {
  return h("button", { class: `btn btn-small ${kind ? `btn-${kind}` : ""}`, type: "button", onclick }, label);
}

// 3. グリッド
function renderGridArea() {
  const isToday = state.day === state.today;
  const dateInput = h("input", {
    type: "date", value: state.day, "aria-label": "日付を選ぶ",
    onchange: (e) => e.target.value && changeDay(e.target.value),
  });
  $("grid-nav").replaceChildren(
    h("button", { class: "icon-btn", type: "button", "aria-label": "前の日", onclick: () => changeDay(addDays(state.day, -1)) }, "‹"),
    h("strong", { class: "grid-date" }, formatDate(dayStartMs(state.day) + 12 * 3600000)),
    h("button", { class: "icon-btn", type: "button", "aria-label": "次の日", onclick: () => changeDay(addDays(state.day, 1)) }, "›"),
    h("button", { class: "btn btn-small", type: "button", disabled: isToday, onclick: () => changeDay(state.today) }, "今日"),
    dateInput);

  if (state.resources.length === 0) {
    $("grid").replaceChildren(h("p", { class: "muted" }, "リソースがまだ登録されていません。"));
    return;
  }
  renderGrid($("grid"), {
    day: state.day,
    resources: state.resources,
    reservations: state.reservations,
    now: nowMs(),
    isToday,
    canWalkIn: (res) => isToday && !res.paused && !occupantAt(res.id, nowMs()),
    onSelect: (sel) => openReserve(sel),
    onReservation: (r, res) => openReservationDetail(r, res),
    onWalkIn: (res) => openWalkIn(res),
    onMemo: (res) => openMemo(res),
  });
}

// 4. お知らせの一覧
function renderNews() {
  const list = state.announcements.filter((a) => a.importance !== "important");
  const box = $("news");
  box.hidden = list.length === 0;
  box.replaceChildren(
    h("h2", {}, "お知らせ"),
    h("ul", { class: "news-list" }, list.map((a) =>
      h("li", {},
        h("button", { class: "link-btn", type: "button", onclick: () => openAnnouncement(a) },
          state.seenAt && a.publish_start_at > state.seenAt
            ? h("span", { class: "badge badge-new" }, "新着") : null,
          a.title),
        h("span", { class: "muted small" }, formatDate(a.publish_start_at))))));
}

// ============================================================
// 表示用の判定（最終的な判定はサーバー）
// ============================================================
const occupying = (r) => OCCUPYING.includes(r.status);

function occupantAt(resourceId, ms) {
  return state.reservations.find((r) =>
    r.resource_id === resourceId && occupying(r) && toMs(r.start_at) <= ms && ms < toMs(r.effective_end));
}

function overlapping(resourceId, startMs, endMs, excludeId = null) {
  return state.reservations.find((r) =>
    r.resource_id === resourceId && r.id !== excludeId && occupying(r)
    && toMs(r.start_at) < endMs && toMs(r.effective_end) > startMs);
}

// 読み込んだ範囲で、ms 以降に始まる次の予約の開始時刻
function nextStart(resourceId, ms, excludeId = null) {
  const starts = state.reservations
    .filter((r) => r.resource_id === resourceId && r.id !== excludeId && occupying(r) && toMs(r.start_at) >= ms)
    .map((r) => toMs(r.start_at));
  return starts.length ? Math.min(...starts) : null;
}

const holdingCount = () => state.myReservations.filter((r) => ["reserved", "in_use"].includes(r.status)).length;

// ============================================================
// アカウント（U6〜U8）
// ============================================================

// 氏名・期生・メモの入力欄
function profileFields(initial = {}) {
  const name = h("input", { type: "text", required: true, maxlength: "50", autocomplete: "name", value: initial.name ?? "" });
  const teacher = h("input", { type: "checkbox" });
  const cohort = h("input", { type: "number", min: "1", inputmode: "numeric", value: initial.cohort ?? "" });
  const memo = h("textarea", { maxlength: "500", rows: "2", placeholder: "所属やメールアドレスなど（任意・全員に公開されます）" }, initial.memo ?? "");
  if (initial.name && initial.cohort == null) {
    teacher.checked = true;
    cohort.disabled = true;
  }
  teacher.addEventListener("change", () => {
    cohort.disabled = teacher.checked;
    if (teacher.checked) cohort.value = "";
  });
  const error = h("p", { class: "field-error", role: "alert" });

  const el = h("fieldset", { class: "profile" },
    h("legend", {}, "あなたの情報"),
    h("label", {}, "氏名", name),
    h("div", { class: "row" },
      h("label", { class: "grow" }, "期生", cohort),
      h("label", { class: "check" }, teacher, "教員")),
    h("label", {}, "メモ", memo),
    h("p", { class: "muted small" }, "氏名・期生・メモは、予約をタップした人に表示されます。"),
    error);

  return {
    el,
    focusName() {
      name.focus();
      name.select();
    },
    showError(msg) {
      error.textContent = msg;
    },
    // 入力を読む。不足があれば null
    read() {
      error.textContent = "";
      const n = name.value.trim();
      if (!n) {
        error.textContent = "氏名を入力してください。";
        name.focus();
        return null;
      }
      let c = null;
      if (!teacher.checked) {
        c = Number(cohort.value);
        if (!Number.isInteger(c) || c <= 0) {
          error.textContent = "期生を入力してください（教員の方は「教員」にチェック）。";
          cohort.focus();
          return null;
        }
      }
      return { name: n, cohort: c, memo: memo.value };
    },
  };
}

// 識別子が衝突したときの確認（U7）。同一人物なら既存のアカウントを返す。別人なら null
async function confirmIdentity(existing) {
  const memo = h("p", { class: "memo" });
  renderPlainText(memo, existing.memo || "（メモなし）");
  const choice = await choose("同じ人が登録されています",
    h("div", {},
      h("p", {}, "次の人がすでに登録されています。あなたですか？"),
      h("div", { class: "person" }, h("strong", {}, personLabel(existing)), memo)),
    [
      { label: "別人です（表記を変える）", value: "other" },
      { label: "自分です（ログイン）", value: "me", kind: "primary" },
    ]);
  if (choice !== "me") return null;
  return call("login_user", { p_name: existing.name, p_cohort: existing.cohort });
}

// ログインしていなければ、入力欄の内容でアカウントを作る（衝突したら U7）。キャンセルされたら null
async function ensureUser(fields) {
  if (state.me) return state.me;
  const p = fields.read();
  if (!p) return null;
  try {
    const user = await call("create_user", { p_name: p.name, p_cohort: p.cohort, p_memo: p.memo });
    return loggedIn(user);
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== "IDENTITY_CONFLICT") throw err;
    const user = await confirmIdentity(err.details);
    if (user) return loggedIn(user);
    fields.showError("別人の場合は、氏名の表記を変えて登録してください（例: 山田太郎A）。");
    fields.focusName();
    return null;
  }
}

function loggedIn(user) {
  setUserId(user.id);
  state.me = user;
  return user;
}

function openAccount() {
  const fields = profileFields(state.me ?? {});
  const save = h("button", { class: "btn btn-primary", type: "submit" }, state.me ? "保存" : "はじめる");
  const form = h("form", { class: "form" }, fields.el, h("div", { class: "actions" },
    state.me ? h("button", { class: "btn", type: "button", onclick: logout }, "ログアウト") : null,
    save));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await busy(save, async () => {
      try {
        if (!state.me) {
          if (!(await ensureUser(fields))) return;
        } else {
          const p = fields.read();
          if (!p) return;
          try {
            loggedIn(await call("update_profile", { p_user_id: state.me.id, p_name: p.name, p_cohort: p.cohort, p_memo: p.memo }));
          } catch (err) {
            if (!(err instanceof ApiError) || err.code !== "IDENTITY_CONFLICT") throw err;
            const user = await confirmIdentity(err.details);
            if (!user) {
              fields.showError("別人の場合は、氏名の表記を変えてください（例: 山田太郎A）。");
              return;
            }
            loggedIn(user); // 同一人物なら、そのアカウントに切り替える
          }
        }
        closeDialog();
        toast(`${personLabel(state.me)}としてログインしています。`, "ok");
        await load();
      } catch (err) {
        await handleError(err);
      }
    });
  });

  openDialog(state.me ? "アカウント" : "ログイン / 登録", h("div", {},
    state.me ? null : h("p", { class: "muted" }, "はじめての人も、使ったことがある人も、氏名と期生を入力してください。"),
    form));
}

function logout() {
  clearUserId();
  state.me = null;
  closeDialog();
  load();
}

// ============================================================
// 予約の作成（U5）
// ============================================================
function openReserve({ resource, startMs, endMs }) {
  if (resource.paused) return toast("このリソースは一時停止中です。");
  if (state.me?.suspended) return toast(errorMessage(new ApiError("USER_SUSPENDED")));

  const now = nowMs();
  if (startMs < now) startMs = ceilMinute(now); // 今の枠をタップしたら、開始は現在時刻
  endMs ??= startMs + 60 * MINUTE;
  if (endMs <= startMs) endMs = startMs + 30 * MINUTE;

  const range = timeRangeInputs(startMs, endMs);
  const warn = h("div", { class: "warnings" });
  const fields = state.me ? null : profileFields();
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "予約する");

  const refresh = () => {
    const { start, end } = range.value();
    warn.replaceChildren();
    if (!(end > start)) warn.append(notice("終了は開始より後にしてください。", "error"));
    else if (start < floorNow()) warn.append(notice("過去の時刻からは予約できません。", "error"));
    else if (overlapping(resource.id, start, end)) warn.append(notice("他の予約と重なっています。", "error"));
    if (state.me && holdingCount() >= LIMIT) warn.append(notice(`同時に持てる予約は${LIMIT}件までです（今${holdingCount()}件）。`, "error"));
    submit.disabled = warn.querySelector(".error") !== null;
  };
  range.onChange(refresh);

  const form = h("form", { class: "form" },
    h("p", { class: "lead" }, h("strong", {}, resource.name)),
    range.el,
    warn,
    fields?.el,
    h("div", { class: "actions" }, submit));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await busy(submit, async () => {
      try {
        const user = await ensureUser(fields);
        if (!user) return;
        const { start, end } = range.value();
        await call("create_reservation", {
          p_user_id: user.id, p_resource_id: resource.id,
          p_start_at: new Date(start).toISOString(), p_end_at: new Date(end).toISOString(),
        });
        closeDialog();
        toast("予約しました。", "ok");
        await load();
      } catch (err) {
        await handleError(err);
        if (state.me) refresh();
      }
    });
  });

  openDialog("予約する", form);
  refresh();
}

const floorNow = () => Math.floor(nowMs() / MINUTE) * MINUTE;

// 開始と終了の入力欄（終了は「+30分」などのボタンでも選べる）
function timeRangeInputs(startMs, endMs, { startEditable = true, maxEndMs = null } = {}) {
  const sDate = h("input", { type: "date", value: dateKey(startMs), disabled: !startEditable, "aria-label": "開始日" });
  const sTime = h("input", { type: "time", value: toTimeInput(startMs), disabled: !startEditable, "aria-label": "開始時刻" });
  const eDate = h("input", { type: "date", value: dateKey(endMs), "aria-label": "終了日" });
  const eTime = h("input", { type: "time", value: toTimeInput(endMs), "aria-label": "終了時刻" });
  const summary = h("p", { class: "summary" });
  const listeners = [];

  const value = () => ({
    start: sDate.value && sTime.value ? fromInputs(sDate.value, sTime.value) : NaN,
    end: eDate.value && eTime.value ? fromInputs(eDate.value, eTime.value) : NaN,
  });
  const setEnd = (ms) => {
    eDate.value = dateKey(ms);
    eTime.value = toTimeInput(ms);
    changed();
  };
  const changed = () => {
    const { start, end } = value();
    summary.textContent = end > start ? `${formatDateTime(start)}–${formatTime(end)}（${formatDuration(end - start)}）` : "";
    listeners.forEach((f) => f());
  };
  for (const i of [sDate, sTime, eDate, eTime]) i.addEventListener("input", changed);

  const durations = [[30, "+30分"], [60, "+1時間"], [120, "+2時間"], [180, "+3時間"]];
  const quick = h("div", { class: "quick" },
    durations.map(([m, label]) =>
      h("button", {
        class: "btn btn-small", type: "button",
        disabled: maxEndMs != null && value().start + m * MINUTE > maxEndMs,
        onclick: () => setEnd(value().start + m * MINUTE),
      }, label)),
    maxEndMs != null
      ? h("button", { class: "btn btn-small", type: "button", onclick: () => setEnd(maxEndMs) }, `${formatTime(maxEndMs)}まで`)
      : null);

  const el = h("div", { class: "time-range" },
    h("div", { class: "row" }, h("span", { class: "label" }, "開始"), sDate, sTime),
    h("div", { class: "row" }, h("span", { class: "label" }, "終了"), eDate, eTime),
    h("div", { class: "row" }, h("span", { class: "label" }, ""), quick),
    summary);
  queueMicrotask(changed);
  return { el, value, onChange: (f) => listeners.push(f) };
}

// ============================================================
// 予約なしで使い始める（U9）
// ============================================================
function openWalkIn(resource, { maxEndMs = null } = {}) {
  if (state.me?.suspended) return toast(errorMessage(new ApiError("USER_SUSPENDED")));
  const now = nowMs();
  const next = nextStart(resource.id, now);
  const limit = [maxEndMs, next].filter((x) => x != null);
  const maxEnd = limit.length ? Math.min(...limit) : null;
  let end = now + 60 * MINUTE;
  if (maxEnd != null && end > maxEnd) end = maxEnd;
  end = Math.floor(end / MINUTE) * MINUTE;

  const range = timeRangeInputs(now, end, { startEditable: false, maxEndMs: maxEnd });
  const warn = h("div", { class: "warnings" });
  const fields = state.me ? null : profileFields();
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "使い始める");

  range.onChange(() => {
    const { end: e } = range.value();
    warn.replaceChildren();
    if (!(e > nowMs())) warn.append(notice("終了は今より後にしてください。", "error"));
    else if (maxEnd != null && e > maxEnd) warn.append(notice(`次の予約があるので、${formatTime(maxEnd)}までです。`, "error"));
    submit.disabled = warn.querySelector(".error") !== null;
  });

  const form = h("form", { class: "form" },
    h("p", { class: "lead" }, h("strong", {}, resource.name), " を今から使います。"),
    maxEnd != null ? h("p", { class: "muted" }, `次の予約は ${formatDateTime(maxEnd)} からです。`) : null,
    range.el, warn, fields?.el,
    h("div", { class: "actions" }, submit));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    await busy(submit, async () => {
      try {
        const user = await ensureUser(fields);
        if (!user) return;
        await call("start_walk_in", {
          p_user_id: user.id, p_resource_id: resource.id,
          p_end_at: new Date(range.value().end).toISOString(),
        });
        closeDialog();
        toast("利用を記録しました。終わったらチェックアウトしてください。", "ok");
        await load();
      } catch (err) {
        await handleError(err);
      }
    });
  });

  openDialog("今すぐ使う", form);
}

// ============================================================
// チェックイン・チェックアウト・削除・変更（U10・U12）
// ============================================================
async function checkIn(button, r) {
  if (nowMs() < toMs(r.start_at)) return openEarlyCheckIn(r);
  await busy(button, async () => {
    try {
      await call("check_in", { p_user_id: state.me.id, p_reservation_id: r.id, p_advance: false });
      toast("チェックインしました。", "ok");
      closeDialog();
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "ADVANCE_REQUIRED") return openEarlyCheckIn(r);
      await handleError(err);
    }
  });
}

// 開始前のチェックイン: 前倒しするか、予約は残して予約なしで使うか
function openEarlyCheckIn(r) {
  const res = resourceOf(r.resource_id);
  const start = toMs(r.start_at);
  const canAdvance = !overlapping(r.resource_id, nowMs(), start, r.id);
  const advance = h("button", { class: "btn btn-primary", type: "button", disabled: !canAdvance }, "予約を前倒しして今から使う");
  advance.addEventListener("click", () =>
    act(advance, () => call("check_in", { p_user_id: state.me.id, p_reservation_id: r.id, p_advance: true }), "チェックインしました。"));

  openDialog("開始前のチェックイン", h("div", { class: "form" },
    h("p", {}, `予約の開始は ${formatDateTime(start)} です。`),
    h("div", { class: "choice" },
      advance,
      h("p", { class: "muted small" }, canAdvance
        ? `開始時刻を今に変えます（終了は ${formatTime(r.end_at)} のまま）。`
        : "直前の時間帯が埋まっているため、前倒しできません。")),
    h("div", { class: "choice" },
      h("button", { class: "btn", type: "button", disabled: !res, onclick: () => openWalkIn(res, { maxEndMs: start }) },
        "予約は残して、予約なしで使う"),
      h("p", { class: "muted small" }, `元の予約は残ります。使えるのは ${formatDateTime(start)} までです。`))));
}

async function checkOut(button, r) {
  await act(button, () => call("check_out", { p_user_id: state.me.id, p_reservation_id: r.id }), "チェックアウトしました。");
}

async function cancel(button, r) {
  const ok = await confirmAction("予約の削除",
    `${resourceName(r.resource_id)} ${formatDateTime(r.start_at)}–${formatTime(r.end_at)} の予約を削除しますか？`,
    "削除する", "danger");
  if (!ok) return;
  await act(button, () => call("cancel_reservation", { p_user_id: state.me.id, p_reservation_id: r.id }), "予約を削除しました。");
}

function openChange(r) {
  const start = toMs(r.start_at);
  const startEditable = r.status === "reserved" && nowMs() < start;
  const next = nextStart(r.resource_id, toMs(r.end_at), r.id);
  const range = timeRangeInputs(start, toMs(r.end_at), { startEditable });
  const warn = h("div", { class: "warnings" });
  const submit = h("button", { class: "btn btn-primary", type: "submit" }, "変更する");

  range.onChange(() => {
    const v = range.value();
    warn.replaceChildren();
    if (!(v.end > v.start)) warn.append(notice("終了は開始より後にしてください。", "error"));
    else if (!(v.end > nowMs())) warn.append(notice("終了は今より後にしてください。", "error"));
    else if (overlapping(r.resource_id, v.start, v.end, r.id)) warn.append(notice("他の予約と重なっています。", "error"));
    submit.disabled = warn.querySelector(".error") !== null;
  });

  const form = h("form", { class: "form" },
    h("p", { class: "lead" }, h("strong", {}, resourceName(r.resource_id))),
    startEditable ? null : h("p", { class: "muted small" }, "開始時刻を過ぎたので、終了時刻だけ変更できます。"),
    next != null ? h("p", { class: "muted small" }, `次の予約は ${formatDateTime(next)} からです。`) : null,
    range.el, warn,
    h("div", { class: "actions" }, submit));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const v = range.value();
    act(submit, () => call("change_reservation", {
      p_user_id: state.me.id, p_reservation_id: r.id,
      p_start_at: startEditable && v.start !== start ? new Date(v.start).toISOString() : null,
      p_end_at: v.end !== toMs(r.end_at) ? new Date(v.end).toISOString() : null,
    }), "予約を変更しました。");
  });

  openDialog(r.status === "in_use" ? "終了時刻の変更・延長" : "予約の変更", form);
}

// ============================================================
// 予約の詳細（U11）・リソースのメモ（U13）・お知らせ（U14）
// ============================================================
function openReservationDetail(r, res) {
  const rows = [
    h("p", { class: "lead" }, h("strong", {}, res.name), ` ${formatDateTime(r.start_at)}–${formatTime(r.effective_end)}`),
    h("p", {}, h("span", { class: `status status-${r.status}` }, statusName(r.status)),
      r.kind === "walk_in" ? h("span", { class: "badge" }, "予約なし") : null),
  ];
  if (r.kind === "block") {
    rows.push(h("p", {}, `理由: ${r.block_reason ?? ""}`));
  } else if (r.user) {
    const memo = h("p", { class: "memo" });
    renderPlainText(memo, r.user.memo || "（メモなし）");
    rows.push(h("div", { class: "person" }, h("strong", {}, personLabel(r.user)), memo));
  }

  const mine = state.myReservations.find((m) => m.id === r.id);
  if (mine) {
    const buttons = [];
    if (mine.status === "in_use") {
      buttons.push(btn("チェックアウト", (e) => checkOut(e.currentTarget, mine), "primary"), btn("延長", () => openChange(mine)));
    } else if (mine.status === "reserved") {
      buttons.push(btn("チェックイン", (e) => checkIn(e.currentTarget, mine), "primary"),
        btn("変更", () => openChange(mine)), btn("削除", (e) => cancel(e.currentTarget, mine), "danger"));
    }
    rows.push(h("div", { class: "actions" }, buttons));
  }
  openDialog(r.kind === "block" ? "封鎖" : "予約", h("div", {}, rows));
}

function openMemo(res) {
  const body = h("div", { class: "md" });
  renderMarkdown(body, res.memo_md || "（メモはありません）");
  openDialog(res.name, h("div", {},
    res.paused ? notice(`一時停止中です${res.pause_reason ? `（${res.pause_reason}）` : ""}。予約とチェックインはできません。`, "error") : null,
    body));
}

function openAnnouncement(a) {
  const body = h("div", { class: "md" });
  renderMarkdown(body, a.body_md);
  openDialog(a.title, h("div", {}, h("p", { class: "muted small" }, formatDate(a.publish_start_at)), body));
}

init();
