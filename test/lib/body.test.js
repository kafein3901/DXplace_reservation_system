import { describe, expect, test } from 'vitest';
import { MAX_BODY_BYTES, readJsonBody } from '../../src/lib/body.js';

function post(body) {
  return new Request('https://example.test/api/x', { method: 'POST', body });
}

describe('API 本文は 16 KiB までの JSON のオブジェクトだけを読む（readJsonBody）', () => {
  test('API 受け付ける：JSON のオブジェクト', async () => {
    expect(await readJsonBody(post('{"a":1,"b":"い"}'))).toEqual({ ok: true, value: { a: 1, b: 'い' } });
  });

  test('API 受け付ける：先頭に BOM がある（PowerShell 5.1 の Set-Content。api.md 6.2）', async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('{"a":1}')]);
    expect(await readJsonBody(post(bytes))).toEqual({ ok: true, value: { a: 1 } });
  });

  test('API 受け付ける：ちょうど 16 KiB', async () => {
    const text = `{"a":"${'x'.repeat(MAX_BODY_BYTES - 8)}"}`;
    expect(new TextEncoder().encode(text).byteLength).toBe(MAX_BODY_BYTES);
    expect((await readJsonBody(post(text))).ok).toBe(true);
  });

  test('API 断る：16 KiB を 1 バイト超える', async () => {
    const text = `{"a":"${'x'.repeat(MAX_BODY_BYTES - 7)}"}`;
    expect(await readJsonBody(post(text))).toEqual({ ok: false });
  });

  test.each([
    ['空', ''],
    ['JSON でない', 'a=1'],
    ['途中で切れた JSON', '{"a":'],
    ['配列', '[1]'],
    ['null', 'null'],
    ['数値', '1'],
    ['文字列', '"a"'],
  ])('API 断る：%s', async (_, text) => {
    expect(await readJsonBody(post(text))).toEqual({ ok: false });
  });

  test('API 断る：本文がない', async () => {
    expect(await readJsonBody(new Request('https://example.test/api/x', { method: 'POST' }))).toEqual({ ok: false });
  });
});
