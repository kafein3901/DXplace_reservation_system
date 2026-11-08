// 画面の小さな部品（要素の作成、ダイアログ、トースト）

// h("button", { class: "btn", onclick }, "文字") のように要素を作る
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const dialog = () => document.getElementById("dialog");

// ダイアログを開く。content は要素。閉じたら onClose を呼ぶ
export function openDialog(title, content, { onClose } = {}) {
  const d = dialog();
  const body = h("div", { class: "dialog-body" }, content);
  d.replaceChildren(
    h("div", { class: "dialog-head" },
      h("h2", {}, title),
      h("button", { class: "icon-btn", type: "button", "aria-label": "閉じる", onclick: () => closeDialog() }, "×")),
    body);
  d.onclose = () => onClose?.();
  if (!d.open) d.showModal();
  return body;
}

export function closeDialog() {
  const d = dialog();
  if (d.open) d.close();
}

// 開いているダイアログの上に重ねて選択肢を出し、選んだ値を返す（閉じたら null）
//   buttons: [{ label, value, kind: "primary" | "danger" | undefined }]
export function choose(title, content, buttons) {
  const d = document.getElementById("dialog2");
  return new Promise((resolve) => {
    let result = null;
    d.replaceChildren(
      h("div", { class: "dialog-head" }, h("h2", {}, title)),
      h("div", { class: "dialog-body" },
        content,
        h("div", { class: "actions" },
          buttons.map((b) =>
            h("button", {
              class: `btn ${b.kind ? `btn-${b.kind}` : ""}`,
              type: "button",
              onclick: () => {
                result = b.value;
                d.close();
              },
            }, b.label)))));
    d.onclose = () => resolve(result);
    d.showModal();
  });
}

// 確認だけのダイアログ
export async function confirmAction(title, message, okLabel, kind = "primary") {
  const v = await choose(title, h("p", {}, message), [
    { label: "やめる", value: false },
    { label: okLabel, value: true, kind },
  ]);
  return v === true;
}

// 画面の下に短いメッセージを出す
let toastTimer = null;
export function toast(message, kind = "error") {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = "toast"), kind === "error" ? 6000 : 3000);
}

// 送信中はボタンを押せないようにする
export async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } finally {
    if (button) button.disabled = false;
  }
}

// ダイアログ内の注意書き（重複・上限など、確定前に示すもの）
export function notice(text, kind = "warn") {
  return h("p", { class: `notice ${kind}`, role: kind === "error" ? "alert" : "status" }, text);
}
