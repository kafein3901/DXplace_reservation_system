// 空き状況のグリッド（要件定義 5章「グリッド」）
//   列がリソース、縦方向が時間。15分刻みの目盛りの上に、実際の時間の分だけ帯を描く。
//   状態は色と模様の両方で区別する（空き・予約済み・利用中・自分の予約・封鎖）
import { h } from "./ui.js";
import { dayStartMs, formatTime, toMs, MINUTE } from "./time.js";

export const SLOT_MIN = 15;
const PX_PER_MIN = 1.2;
const DAY_MIN = 24 * 60;

// 予約の帯の種類（CSS のクラス）
function blockClass(r) {
  const cls = ["blk"];
  if (r.kind === "block") cls.push("blk-block");
  else if (r.status === "in_use") cls.push("blk-inuse");
  else if (r.status === "finished") cls.push("blk-finished");
  else cls.push("blk-reserved");
  if (r.is_mine) cls.push("blk-mine");
  return cls.join(" ");
}

export function personLabel(user) {
  if (!user) return "";
  return user.cohort == null ? `${user.name}（教員）` : `${user.name}（${user.cohort}期）`;
}

function blockLabel(r) {
  if (r.kind === "block") return `封鎖: ${r.block_reason ?? ""}`;
  return personLabel(r.user);
}

/**
 * グリッドを描く
 * @param {HTMLElement} root
 * @param {object} o
 *   day, resources, reservations, now（ミリ秒）, isToday
 *   canWalkIn(resource) … 「今すぐ使う」を押せるか
 *   onSelect({ resource, startMs, endMs }) … 空いている所をタップ／ドラッグした（endMs はドラッグのときだけ）
 *   onReservation(reservation, resource) … 予約の帯をタップした
 *   onWalkIn(resource), onMemo(resource)
 */
export function renderGrid(root, o) {
  const start = dayStartMs(o.day);
  const minToPx = (m) => `${m * PX_PER_MIN}px`;
  const msToMin = (ms) => (ms - start) / MINUTE;

  const cols = o.resources.map((res) => {
    const col = h("div", { class: "col", dataset: { resourceId: res.id }, style: { height: minToPx(DAY_MIN) } });
    if (res.paused) col.classList.add("col-paused");

    for (const r of o.reservations.filter((x) => x.resource_id === res.id)) {
      const top = Math.max(0, msToMin(toMs(r.start_at)));
      const bottom = Math.min(DAY_MIN, msToMin(toMs(r.effective_end)));
      if (bottom <= top) continue;
      const tip = r.kind === "block"
        ? `封鎖: ${r.block_reason ?? ""}`
        : `${personLabel(r.user)}${r.user?.memo ? `\n${r.user.memo}` : ""}`;
      const blk = h("button", {
        class: blockClass(r),
        type: "button",
        title: `${formatTime(r.start_at)}–${formatTime(r.effective_end)} ${tip}`,
        style: { top: minToPx(top), height: minToPx(bottom - top) },
        onclick: (e) => {
          e.stopPropagation();
          o.onReservation(r, res);
        },
      },
        h("span", { class: "blk-time" }, `${formatTime(r.start_at)}–${formatTime(r.effective_end)}`),
        h("span", { class: "blk-name" }, r.is_mine ? `自分 ${blockLabel(r)}` : blockLabel(r)));
      col.append(blk);
    }

    if (o.isToday) {
      col.append(h("div", { class: "now-line", style: { top: minToPx(msToMin(o.now)) }, "aria-hidden": "true" }));
    }
    attachSelection(col, res, o, start);
    return col;
  });

  const heads = o.resources.map((res) =>
    h("div", { class: "col-head" },
      h("button", { class: "col-name", type: "button", onclick: () => o.onMemo(res), title: "メモを見る" },
        res.name, res.paused ? h("span", { class: "badge" }, "停止中") : null),
      h("button", {
        class: "btn btn-small btn-primary",
        type: "button",
        disabled: !o.canWalkIn(res),
        onclick: () => o.onWalkIn(res),
      }, "今すぐ使う")));

  const axis = h("div", { class: "axis", style: { height: minToPx(DAY_MIN) } },
    Array.from({ length: 24 }, (_, i) =>
      h("span", { class: "axis-label", style: { top: minToPx(i * 60) } }, `${i}:00`)));

  const grid = h("div", {
    class: "grid",
    style: { gridTemplateColumns: `3rem repeat(${o.resources.length}, minmax(7.5rem, 1fr))` },
  },
    h("div", { class: "corner" }),
    heads,
    axis,
    cols);

  const scroller = h("div", { class: "grid-scroll" }, grid);
  root.replaceChildren(scroller);

  // 初期表示: 今日なら現在時刻の少し前、別の日なら 8:00
  const focusMin = o.isToday ? Math.max(0, msToMin(o.now) - 60) : 8 * 60;
  scroller.scrollTop = focusMin * PX_PER_MIN;
}

// 空いている所の選択: タップは開始時刻だけ、マウスのドラッグは開始と終了
function attachSelection(col, res, o, dayStart) {
  const minAt = (clientY) => {
    const rect = col.getBoundingClientRect();
    const m = (clientY - rect.top) / PX_PER_MIN;
    return Math.min(DAY_MIN, Math.max(0, m));
  };
  const floorSlot = (m) => Math.floor(m / SLOT_MIN) * SLOT_MIN;
  const ceilSlot = (m) => Math.ceil(m / SLOT_MIN) * SLOT_MIN;

  let drag = null; // { from, box }
  let suppressClick = false;

  col.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "mouse" || e.button !== 0 || e.target !== col) return;
    drag = { from: minAt(e.clientY), box: null };
    col.setPointerCapture(e.pointerId);
  });
  col.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const cur = minAt(e.clientY);
    const a = floorSlot(Math.min(drag.from, cur));
    const b = ceilSlot(Math.max(drag.from, cur));
    if (b - a <= SLOT_MIN && !drag.box) return; // 少し動いただけならタップ扱い
    if (!drag.box) {
      drag.box = h("div", { class: "drag-box" });
      col.append(drag.box);
    }
    drag.box.style.top = `${a * PX_PER_MIN}px`;
    drag.box.style.height = `${(b - a) * PX_PER_MIN}px`;
    drag.range = [a, b];
  });
  col.addEventListener("pointerup", () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.box) {
      d.box.remove();
      suppressClick = true;
      const [a, b] = d.range;
      o.onSelect({ resource: res, startMs: dayStart + a * MINUTE, endMs: dayStart + b * MINUTE });
    }
  });
  col.addEventListener("click", (e) => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    if (e.target !== col) return;
    const m = floorSlot(minAt(e.clientY));
    o.onSelect({ resource: res, startMs: dayStart + m * MINUTE, endMs: null });
  });
}
