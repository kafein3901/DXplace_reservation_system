// 要求の本文の読み取り（docs/design/detailed/api.md 2）

// 本文の上限。超えたら読むのをやめて INPUT_BODY（design-values.md）
export const MAX_BODY_BYTES = 16 * 1024;

// 本文を読み、JSON のオブジェクトなら { ok: true, value } を返す。
// 上限を超える、UTF-8 の JSON として読めない、オブジェクトでない（配列・null・数値など）ときは { ok: false }。
// ここでは断らず、断るのは共通の順の共4（api.md 4）。
export async function readJsonBody(request) {
  const bytes = await readLimited(request, MAX_BODY_BYTES);
  if (bytes === null) return { ok: false };

  // TextDecoder は先頭の BOM を除く（request.text() と同じ。api.md 6.2）
  const text = new TextDecoder().decode(bytes);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false };
  return { ok: true, value };
}

// 本文を上限まで読む。上限を超えたら、残りを読まずに null を返す
async function readLimited(request, limit) {
  if (request.body === null) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// 本文の項目がすべて文字列か。項目がない、文字列でないときは偽（INPUT_BODY。error-codes.md 3.1）
export function hasStringFields(body, names) {
  return names.every((name) => typeof body[name] === 'string');
}
