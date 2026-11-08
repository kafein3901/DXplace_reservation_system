// A6: 入口URL（現在の URL と QR コードの表示、再発行）
import qrcode from "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/+esm";
import { h, confirmAction, toast, busy } from "../ui.js";
import { formatDateTime } from "../time.js";
import { call, showError } from "./common.js";

let root = null;

export async function render(panel) {
  root = panel;
  try {
    draw(await call("admin_get_token"));
  } catch (err) {
    showError(err);
  }
}

// 利用者のページ（このページと同じ場所の index.html）にトークンを付けた URL
function entryUrl(token) {
  const url = new URL("index.html", location.href);
  url.hash = `t=${token}`;
  return url.toString();
}

function draw(current) {
  const reissue = h("button", { class: "btn btn-danger", type: "button" }, current ? "再発行する" : "発行する");
  reissue.addEventListener("click", async () => {
    if (current && !(await confirmAction("入口URLの再発行",
      "再発行すると、今の入口URLとQRコードはすぐに使えなくなり、全員が新しいQRコードから開き直す必要があります。再発行しますか？",
      "再発行する", "danger"))) return;
    await busy(reissue, async () => {
      try {
        draw(await call("admin_issue_token"));
        toast("入口URLを発行しました。掲示しているQRコードを差し替えてください。", "ok");
      } catch (err) {
        showError(err);
      }
    });
  });

  const content = [h("h2", {}, "入口URL")];
  if (current) {
    const url = entryUrl(current.token);
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const copy = h("button", { class: "btn btn-small", type: "button" }, "URLをコピー");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(url);
        toast("コピーしました。", "ok");
      } catch {
        toast("コピーできませんでした。URLを選択してコピーしてください。");
      }
    });
    content.push(
      h("p", { class: "muted small" }, `発行: ${formatDateTime(current.issued_at)}`),
      h("img", { class: "qr", src: qr.createDataURL(8, 16), alt: "入口URLのQRコード", width: qr.getModuleCount() * 8 + 32 }),
      h("div", { class: "row" }, h("input", { type: "text", readonly: true, value: url, class: "url-box", "aria-label": "入口URL" }), copy),
      h("p", { class: "muted small" }, "このQRコードを印刷してDXプレイスに掲示します。開いた人のブラウザにだけ保存されます。"));
  } else {
    content.push(h("p", {}, "入口URLはまだ発行されていません。"));
  }
  content.push(h("div", { class: "actions" }, reissue));
  root.replaceChildren(h("div", { class: "card form" }, content));
}
