// 試行を数える相手（rules.md 6.2）
import { describe, expect, test } from 'vitest';
import { clientKey } from '../../src/lib/client.js';

describe('SEC-3 試行を数える相手（clientKey）', () => {
  test('SEC-3 IPv4 はそのまま', () => {
    expect(clientKey('192.0.2.1')).toBe('192.0.2.1');
  });

  test('SEC-3 IPv6 は先頭64ビットを省略せずに書き /64 を付ける', () => {
    expect(clientKey('2001:db8:1:2::abcd')).toBe('2001:0db8:0001:0002::/64');
  });

  test('SEC-3 同じ /64 の2つのアドレス（省略した書き方と省略しない書き方）は同じ値', () => {
    expect(clientKey('2001:db8:1:2::1')).toBe(clientKey('2001:0db8:0001:0002:ffff:0000:0000:0009'));
  });

  test('SEC-3 違う /64 は違う値', () => {
    expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
  });

  test('SEC-3 末尾が IPv4 の書き方の IPv6 も読める', () => {
    expect(clientKey('::ffff:192.0.2.1')).toBe('0000:0000:0000:0000::/64');
  });

  test.each([
    ['ない', null],
    ['空', ''],
    ['読めない', 'not-an-ip'],
    ['IPv4 の数が大きい', '256.0.0.1'],
    [':: が2つ', '2001::1::2'],
    ['組が多すぎる', '1:2:3:4:5:6:7:8:9'],
  ])('SEC-3 値が%sときは unknown', (_, input) => {
    expect(clientKey(input)).toBe('unknown');
  });
});
