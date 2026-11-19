// 試行を数える相手（docs/design/detailed/rules.md 6.2、docs/design/basic/auth.md 7。SEC-3）
// IPv4 はそのまま。IPv6 は先頭64ビット（4つの組）を省略せずに書き、/64 を付ける。
// 値がない、読めないときは 'unknown'
export function clientKey(ip) {
  if (typeof ip !== 'string' || ip === '') return 'unknown';
  if (isIPv4(ip)) return ip;
  const groups = parseIPv6(ip);
  if (groups === null) return 'unknown';
  return `${groups.slice(0, 4).map((g) => g.toString(16).padStart(4, '0')).join(':')}::/64`;
}

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIPv4(s) {
  const m = IPV4_PATTERN.exec(s);
  return m !== null && m.slice(1).every((part) => Number(part) <= 255);
}

const GROUP_PATTERN = /^[0-9a-fA-F]{1,4}$/;

// IPv6 を8つの組（数値）に直す。読めなければ null。末尾が IPv4 の書き方（::ffff:192.0.2.1）なら2つの組にする
function parseIPv6(s) {
  const halves = s.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part) => {
    if (part === '') return [];
    const pieces = part.split(':');
    const groups = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      if (i === pieces.length - 1 && isIPv4(piece)) {
        const [a, b, c, d] = piece.split('.').map(Number);
        groups.push(a * 256 + b, c * 256 + d);
      } else if (GROUP_PATTERN.test(piece)) {
        groups.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return groups;
  };

  const head = toGroups(halves[0]);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;

  const tail = toGroups(halves[1]);
  if (tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...new Array(missing).fill(0), ...tail];
}
