// Интеграционные тесты сервера: поднимаем настоящий server.js на временной базе
// и ходим в него по HTTP и Socket.IO, как это делает клиент.
// Запуск: npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextPort = 4600 + Math.floor(Math.random() * 300);

// запустить сервер на отдельном порту и в отдельной папке данных
async function startServer(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veche-test-'));
  if (seed) fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify(seed));
  const port = nextPort++;
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dir, ADMINS: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (d) => { out += d; });
  proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes('На этом компе'); i++) await sleep(50);
  if (!out.includes('На этом компе')) { proc.kill(); throw new Error('сервер не стартовал:\n' + out); }
  const base = `http://127.0.0.1:${port}`;
  const sockets = [];
  return {
    base, dir, proc, log: () => out,
    async post(p, body, token) {
      const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    async user(name, reg = true) {
      const r = await this.post(reg ? '/api/register' : '/api/login', { username: name, password: 'secret123' });
      assert.ok(r.body && r.body.token, 'нет токена: ' + JSON.stringify(r.body));
      const s = io(base, { auth: { token: r.body.token }, transports: ['websocket'], forceNew: true });
      sockets.push(s);
      const init = await new Promise((res, rej) => { s.once('init', res); s.once('connect_error', rej); });
      return { token: r.body.token, s, me: init.me, init };
    },
    async stop(signal = 'SIGTERM') {
      for (const s of sockets) s.close();
      proc.kill(signal);
      await new Promise((r) => proc.once('exit', r));
    },
  };
}
const ask = (s, ev, payload) => new Promise((res) => s.emit(ev, payload, res));
const alive = async (srv) => (await fetch(srv.base + '/')).status === 200;

test('регистрация, вход и неверный пароль', async () => {
  const srv = await startServer();
  try {
    const a = await srv.user('anton');
    assert.strictEqual(a.me.admin, true, 'первый пользователь — админ');
    const b = await srv.user('maria');
    assert.strictEqual(b.me.admin, false);
    const bad = await srv.post('/api/login', { username: 'anton', password: 'nope' });
    assert.strictEqual(bad.status, 401);
    const ok = await srv.post('/api/login', { username: 'anton', password: 'secret123' });
    assert.strictEqual(ok.status, 200);
  } finally { await srv.stop(); }
});

test('кривые события от клиента не роняют сервер', async () => {
  const srv = await startServer();
  try {
    const a = await srv.user('anton');
    a.s.emit('edit');
    a.s.emit('vote', { id: 'x', option: '__proto__' });
    a.s.emit('typing');
    a.s.emit('history', null, () => {});
    a.s.emit('call:offer');
    a.s.emit('mute', { chatId: { evil: true }, on: true });
    a.s.emit('game:create', 5, () => {});
    await sleep(300);
    assert.ok(await alive(srv), 'сервер должен остаться жив');
    const r = await ask(a.s, 'send', { chatId: 'efir', type: 'text', text: 'всё ещё работаю' });
    assert.ok(r.ok);
  } finally { await srv.stop(); }
});

test('нельзя отправить «личку» в чужую комнату или от чужого имени', async () => {
  const srv = await startServer();
  try {
    const a = await srv.user('anton');
    const b = await srv.user('maria');
    const c = await srv.user('ivan');
    let leaked = false;
    b.s.on('message', () => { leaked = true; });
    c.s.on('message', () => { leaked = true; });
    for (const chatId of [`dm:${a.me.id}:efir`, `dm:${b.me.id}:${c.me.id}`, `dm:${a.me.id}:${b.me.id}:x`, 'dm:nobody', 'grp:../../etc']) {
      const r = await ask(a.s, 'send', { chatId, type: 'text', text: 'спуфинг ' + chatId });
      assert.strictEqual(r.error, 'no access', chatId);
    }
    const h = await ask(a.s, 'history', { chatId: `dm:${b.me.id}:${c.me.id}` });
    assert.strictEqual(h.error, 'no access');
    await sleep(200);
    assert.strictEqual(leaked, false);
    // а нормальная личка работает, в том числе в «неканоничной» форме dm:<peerId>
    const got = new Promise((res) => b.s.once('message', res));
    const r = await ask(a.s, 'send', { chatId: 'dm:' + b.me.id, type: 'text', text: 'привет' });
    assert.ok(r.ok);
    const m = await got;
    assert.strictEqual(m.chatId, 'dm:' + [a.me.id, b.me.id].sort().join(':'));
  } finally { await srv.stop(); }
});

test('правка сообщения проходит модерацию и не может быть пустой', async () => {
  const srv = await startServer();
  try {
    const a = await srv.user('anton');
    const r = await ask(a.s, 'send', { chatId: 'efir', type: 'text', text: 'обычный текст' });
    const bad = await ask(a.s, 'edit', { id: r.msg.id, text: 'лучшее казино вулкан' });
    assert.match(bad.error, /правила/);
    const empty = await ask(a.s, 'edit', { id: r.msg.id, text: '   ' });
    assert.ok(empty.error);
    const ok = await ask(a.s, 'edit', { id: r.msg.id, text: 'исправленный текст' });
    assert.ok(ok.ok);
    const h = await ask(a.s, 'history', { chatId: 'efir' });
    assert.strictEqual(h.msgs.find((m) => m.id === r.msg.id).text, 'исправленный текст');
  } finally { await srv.stop(); }
});

test('закреплять в Эфире может только администратор', async () => {
  const srv = await startServer();
  try {
    const admin = await srv.user('anton');
    const b = await srv.user('maria');
    const r = await ask(b.s, 'send', { chatId: 'efir', type: 'text', text: 'закрепите меня' });
    let pinnedEv = null;
    admin.s.on('pinned', (e) => { pinnedEv = e; });
    b.s.emit('pin', { id: r.msg.id });
    await sleep(200);
    assert.strictEqual(pinnedEv, null, 'обычный пользователь не может закрепить');
    admin.s.emit('pin', { id: r.msg.id });
    await sleep(200);
    assert.strictEqual(pinnedEv && pinnedEv.id, r.msg.id);
    b.s.emit('unpin', { chatId: 'efir' });
    await sleep(200);
    assert.strictEqual(pinnedEv.id, r.msg.id, 'и открепить тоже не может');
  } finally { await srv.stop(); }
});

test('«Избранное» — личка с собой — есть в списке и работает', async () => {
  const srv = await startServer();
  try {
    const a = await srv.user('anton');
    const saved = `dm:${a.me.id}:${a.me.id}`;
    assert.ok(a.init.chats.some((c) => c.chatId === saved && c.saved), 'Избранное в списке чатов');
    const r = await ask(a.s, 'send', { chatId: saved, type: 'text', text: 'заметка себе' });
    assert.ok(r.ok);
    const h = await ask(a.s, 'history', { chatId: saved });
    assert.strictEqual(h.msgs[0].text, 'заметка себе');
  } finally { await srv.stop(); }
});

test('опрос: голос только за существующий вариант, повторный тап снимает голос', async () => {
  const srv = await startServer();
  try {
    const a = await srv.user('anton');
    const r = await ask(a.s, 'send', { chatId: 'efir', type: 'poll', media: { question: 'Куда?', options: ['кино', 'шашлыки'] } });
    const voted = () => new Promise((res) => a.s.once('voted', res));
    let v = voted(); a.s.emit('vote', { id: r.msg.id, option: 1 });
    assert.deepStrictEqual((await v).votes[1], [a.me.id]);
    a.s.emit('vote', { id: r.msg.id, option: 7 });
    a.s.emit('vote', { id: r.msg.id, option: 'constructor' });
    v = voted(); a.s.emit('vote', { id: r.msg.id, option: 1 });
    assert.deepStrictEqual((await v).votes[1], []);
    assert.ok(await alive(srv));
  } finally { await srv.stop(); }
});

test('история отдаётся страницами', async () => {
  const now = Date.now();
  const messages = [];
  for (let i = 0; i < 320; i++) messages.push({ id: 'm' + String(i).padStart(4, '0'), chatId: 'efir', from: null, type: 'system', text: 'сообщение ' + i, ts: now - (320 - i) * 1000, readBy: [], reactions: {} });
  const srv = await startServer({ users: [], messages, chats: [] });
  try {
    const a = await srv.user('anton');
    const p1 = await ask(a.s, 'history', { chatId: 'efir' });
    assert.strictEqual(p1.msgs.length, 150);
    assert.strictEqual(p1.hasMore, true);
    assert.strictEqual(p1.msgs[149].text, 'сообщение 319');
    const p2 = await ask(a.s, 'history', { chatId: 'efir', before: p1.msgs[0].id });
    assert.strictEqual(p2.msgs[149].text, 'сообщение 169');
    const p3 = await ask(a.s, 'history', { chatId: 'efir', before: p2.msgs[0].id });
    assert.strictEqual(p3.msgs.length, 20);
    assert.strictEqual(p3.hasMore, false);
  } finally { await srv.stop(); }
});

test('исчезающие сообщения удаляются и после перезапуска сервера', async () => {
  const now = Date.now();
  const seed = { users: [], chats: [], messages: [
    { id: 'burn1', chatId: 'efir', from: null, type: 'text', text: 'сгорю через секунду', ts: now, ttl: 1, readBy: [], reactions: {} },
  ] };
  const srv = await startServer(seed);
  try {
    const a = await srv.user('anton');
    await sleep(1600);
    const h = await ask(a.s, 'history', { chatId: 'efir' });
    const m = h.msgs.find((x) => x.id === 'burn1');
    assert.ok(m.deleted, 'сообщение должно сгореть');
    assert.strictEqual(m.text, '');
  } finally { await srv.stop(); }
});

test('превью ссылок не ходит во внутреннюю сеть', async () => {
  const srv = await startServer();
  try {
    const a = await srv.user('anton');
    for (const url of ['http://127.0.0.1/', 'http://localhost/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1/']) {
      const r = await fetch(srv.base + '/api/link-preview?url=' + encodeURIComponent(url), { headers: { Authorization: 'Bearer ' + a.token } });
      assert.strictEqual(r.status, 403, url);
    }
  } finally { await srv.stop(); }
});

test('бан сразу отключает открытые сессии', async () => {
  const srv = await startServer();
  try {
    const admin = await srv.user('anton');
    const b = await srv.user('maria');
    const gone = new Promise((res) => b.s.once('disconnect', res));
    const r = await ask(admin.s, 'banUser', { userId: b.me.id, on: true });
    assert.ok(r.ok);
    await gone;
    const again = await srv.post('/api/login', { username: 'maria', password: 'secret123' });
    assert.strictEqual(again.status, 403);
  } finally { await srv.stop(); }
});

test('база сохраняется при остановке и не портится', async () => {
  const srv = await startServer();
  await srv.user('anton');
  await srv.stop('SIGTERM');
  const db = JSON.parse(fs.readFileSync(path.join(srv.dir, 'data.json'), 'utf8'));
  assert.ok(db.users.some((u) => u.username === 'anton'));
  assert.ok(!fs.existsSync(path.join(srv.dir, 'data.json.tmp')));
});

test('повреждённая база не затирается, а откладывается в сторону', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veche-test-'));
  fs.writeFileSync(path.join(dir, 'data.json'), '{"users": [ обрыв');
  const port = nextPort++;
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dir } });
  let out = ''; proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !out.includes('На этом компе'); i++) await sleep(50);
  proc.kill('SIGTERM'); await new Promise((r) => proc.once('exit', r));
  const aside = fs.readdirSync(dir).find((f) => f.startsWith('data.json.corrupt-'));
  assert.ok(aside, 'копия повреждённой базы должна остаться');
  assert.strictEqual(fs.readFileSync(path.join(dir, aside), 'utf8'), '{"users": [ обрыв');
});
