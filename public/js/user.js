// 利用者の画面の動き（screens.md 2・3）
import { callApi } from './api.js';
import { messageFor } from './messages.js';

const bar = document.getElementById('bar');
const userLabel = document.getElementById('user-label');

// 利用者（screens.md 3.1。USR-3）。POST /api/me の応答の { role, student_id, name, cohort }。なければ null。
// 端末に覚えさせず、ページを読み込み直すと消える
let user = null;

// 利用者が要る画面を出そうとして利用者がいなかったときの行き先（screens.md 3.1）
let destination = null;

// 利用者が要る画面。確保・予約なしの利用は予約の操作の実装で足す
const NEEDS_USER = new Set(['mine']);

// 画面を出す。利用の開始の画面では帯を隠す。画面を切り替えたら文を消す（screens.md 2.3・3.1）
function show(name) {
  for (const section of document.querySelectorAll('section')) {
    section.hidden = section.id !== `screen-${name}`;
  }
  bar.hidden = name === 'start';
  setMessage(name, '', null);
}

// 利用者が要る画面で利用者がいなければ、行き先を覚えて利用者の入力を出す（screens.md 3.1）
function open(name) {
  if (NEEDS_USER.has(name) && user === null) {
    destination = name;
    return show('input');
  }
  show(name);
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

// 上の帯の操作する人（screens.md 3.1）
function renderUserLabel() {
  if (user === null) {
    userLabel.textContent = '操作する人：未入力';
  } else if (user.role === 'teacher') {
    userLabel.textContent = `操作する人：${user.name}（教員）`;
  } else {
    userLabel.textContent = `操作する人：${user.name}（${user.cohort}期・生徒）`;
  }
}

// 断られた応答を受け取る1つの関数（screens.md 2.4）。
// AUTH_REQUIRED・AUTH_REVOKED なら利用の開始へ、NOT_FOUND_USER なら利用者の入力へ移ってそこに文を出し、
// ほかは今の画面に文を出す
function showError(code) {
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_REVOKED') {
    show('start');
    setMessage('start', messageFor(code), 'error');
    return;
  }
  if (code === 'NOT_FOUND_USER') {
    // 利用者の変数を消し、元の画面を行き先として覚える。欄には前の値が残る（screens.md 3.3）
    destination = currentScreen();
    user = null;
    renderUserLabel();
    show('input');
    setMessage('input', messageFor(code), 'error');
    return;
  }
  setMessage(currentScreen(), messageFor(code), 'error');
}

for (const button of bar.querySelectorAll('[data-screen]')) {
  button.addEventListener('click', () => open(button.dataset.screen));
}

// 利用者の入力（screens.md 3.3。USR-3〜USR-7）
const inputForm = document.getElementById('input-form');
const studentIdField = document.getElementById('input-student-id');
const nameField = document.getElementById('input-name');
const cohortField = document.getElementById('input-cohort');
const cohortLabel = document.getElementById('input-cohort-label');

function selectedRole() {
  return inputForm.querySelector('input[name="role"]:checked')?.value ?? null;
}

// 教員を選んでいる間は期生の欄を隠す（値は残す）
for (const radio of inputForm.querySelectorAll('input[name="role"]')) {
  radio.addEventListener('change', () => {
    cohortLabel.hidden = selectedRole() === 'teacher';
  });
}

// 送る前に確かめるのは、空の欄と、期生が数でないことだけ（screens.md 2.9）。問題があれば文を、なければ null を返す
function checkInputFields(role) {
  if (role === null) return '生徒か教員かを選んでください。';
  if (studentIdField.value.trim() === '') return '学籍番号を入れてください。';
  if (nameField.value === '') return '名前を入れてください。';
  if (role === 'student') {
    if (cohortField.value === '') return '期生を入れてください。';
    if (!Number.isFinite(Number(cohortField.value))) return '期生は数で入れてください。';
  }
  return null;
}

inputForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('input', '', null);
  const role = selectedRole();
  const problem = checkInputFields(role);
  if (problem !== null) return setMessage('input', problem, 'error');

  // 学籍番号は前後の空白だけ除く。全角・大文字は台帳がそろえる。教員は期生を送らない
  const body = { role, student_id: studentIdField.value.trim(), name: nameField.value };
  if (role === 'student') body.cohort = Number(cohortField.value);

  const button = inputForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const result = await callApi('POST', '/api/me', body);
    // 断られたら利用者の変数は変えない
    if (!result.ok) return showError(result.code);
    const { role: savedRole, student_id, name, cohort } = result.data;
    user = { role: savedRole, student_id, name, cohort };
    studentIdField.value = student_id; // そろえた値に置き換える（USR-4）
    renderUserLabel();
    const next = destination ?? 'day';
    destination = null;
    show(next);
    setMessage(next, `${name}として操作します。`, 'success');
  } finally {
    button.disabled = false;
  }
});

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
