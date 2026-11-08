// Markdown とプレーンテキストの表示（要件定義 6章「Markdownの表示」、2章「利用者」）
import { marked } from "https://cdn.jsdelivr.net/npm/marked@12.0.2/+esm";
import DOMPurify from "https://cdn.jsdelivr.net/npm/dompurify@3.1.6/+esm";

// リンクは別のタブで開き、遷移元を渡さない
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

// リソースのメモ・お知らせの本文: marked で HTML にした後、DOMPurify で無害化する
export function renderMarkdown(el, markdown) {
  const html = marked.parse(markdown ?? "", { gfm: true, breaks: true });
  el.innerHTML = DOMPurify.sanitize(html);
}

// 利用者のメモ: プレーンテキストとして表示し、URL だけをリンクにする（innerHTML は使わない）
const URL_RE = /https?:\/\/[^\s<>"'）」]+/g;
export function renderPlainText(el, text) {
  el.replaceChildren();
  const s = text ?? "";
  let last = 0;
  for (const m of s.matchAll(URL_RE)) {
    if (m.index > last) el.append(document.createTextNode(s.slice(last, m.index)));
    const a = document.createElement("a");
    a.href = m[0];
    a.textContent = m[0];
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    el.append(a);
    last = m.index + m[0].length;
  }
  if (last < s.length) el.append(document.createTextNode(s.slice(last)));
}
