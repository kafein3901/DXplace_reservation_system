// 利用者の画面の動き（screens.md 2・3）
import { callApi } from './api.js';
import { messageFor } from './messages.js';

const bar = document.getElementById('bar');

// 画面を出す。利用の開始の画面では帯を隠す。画面を切り替えたら文を消す（screens.md 2.3・3.1）
function show(name) {
  for (const section of document.querySelectorAll('section')) {
    section.hidden = section.id !== `screen-${name}`;
  }
  bar.hidden = name === 'start';
  setMessage(name, '', null);
}

function currentScreen() {
  return document.querySelector('section:not([hidden])').id.replace('screen-', '');
}

// 文は textContent で入れる（SEC-1）。kind は 'error' か 'success'
function setMessage(name, text, kind) {
  const element = document.querySelector(`#screen-${name} .message`);
  element.textContent = text;
  element.classList.toggle('error', kind === 'error');
  element.classList.toggle('success', kind === 'success');
}

// 断られた応答を受け取る1つの関数（screens.md 2.4）。
// AUTH_REQUIRED・AUTH_REVOKED なら利用の開始の画面に移ってそこに文を出し、ほかは今の画面に文を出す
function showError(code) {
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_REVOKED') {
    show('start');
    setMessage('start', messageFor(code), 'error');
    return;
  }
  setMessage(currentScreen(), messageFor(code), 'error');
}

for (const button of bar.querySelectorAll('[data-screen]')) {
  button.addEventListener('click', () => show(button.dataset.screen));
}

// 開いたとき（screens.md 2.5・3.2。USR-2）
async function start() {
  // #k= があれば値をそのまま送る（空の文字列でも送り、台帳が断る）。# があって k がなければ #k= がないものとする
  const k = location.hash === '' ? null : new URLSearchParams(location.hash.slice(1)).get('k');
  if (k !== null) {
    const pending = callApi('POST', '/api/session', { k });
    // 応答を待たずに URL から # 以降を消す（auth.md 2）
    history.replaceState(null, '', location.pathname + location.search);
    const result = await pending;
    if (result.ok) return show('day');
    show('start');
    return showError(result.code);
  }

  const result = await callApi('GET', '/api/session');
  if (result.ok && result.data.active) return show('day');
  show('start');
  // active が偽なら reason のコードの文を出す（api.md 8.13）
  showError(result.ok ? result.data.reason : result.code);
}

start();
