// ВЕЧЕ — свободный мессенджер. Собрание, которое не разогнать.
// Запуск: node server.js  →  http://localhost:4040
//
// Copyright (C) 2026 ВЕЧЕ contributors.
// Эта программа — свободное ПО: распространяется на условиях GNU AGPL v3
// или (по вашему выбору) любой более поздней версии. Полный текст — в файле LICENSE.
// Программа распространяется БЕЗ КАКИХ-ЛИБО ГАРАНТИЙ. См. <https://www.gnu.org/licenses/>.

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
let webpush; try { webpush = require('web-push'); } catch { console.warn('web-push not installed — push notifications disabled'); }

// ---------- .env (без зависимостей) ----------
// Читаем локальный .env один раз на старте — удобно для самостоятельного хостинга:
// достаточно скопировать .env.example → .env и вписать значения. Реальное окружение
// (systemd/докер) имеет приоритет: уже заданные переменные не перезаписываем.
(function loadEnv() {
  try {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  } catch (e) { console.warn('.env load skipped:', e.message); }
})();

const PORT = process.env.PORT || 4040;
const DATA_FILE = path.join(__dirname, 'data.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const EFIR = 'efir';

// TURN/STUN для звонков (на проде задаются через окружение в systemd)
const TURN_HOST = process.env.TURN_HOST || '';
const TURN_SECRET = process.env.TURN_SECRET || '';

// ИИ-ассистент «Алиса» (YandexGPT). Ключ и каталог задаются через окружение в systemd (см. _deploy.py).
const YANDEX_API_KEY = process.env.YANDEX_API_KEY || '';
const YANDEX_FOLDER_ID = process.env.YANDEX_FOLDER_ID || '';
const YANDEX_MODEL = process.env.YANDEX_MODEL || 'yandexgpt-lite';
function iceServers() {
  const list = [];
  if (TURN_HOST) {
    list.push({ urls: `stun:${TURN_HOST}:3478` });
    if (TURN_SECRET) {
      const username = Math.floor(Date.now() / 1000 + 12 * 3600) + ':veche';
      const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
      list.push({ urls: [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`], username, credential });
    }
  } else {
    list.push({ urls: 'stun:stun.l.google.com:19302' });
  }
  return list;
}

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- хранилище ----------
let db = { users: [], messages: [], chats: [], scheduled: [], posts: [], reports: [], pushSubs: {}, reminders: [], vapid: null };
try {
  if (fs.existsSync(DATA_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = Object.assign({ users: [], messages: [], chats: [], scheduled: [], posts: [], reports: [], pushSubs: {}, reminders: [], vapid: null }, loaded);
  }
} catch (e) {
  console.error('data.json повреждён, начинаю с чистого листа:', e.message);
}
// миграция старых юзеров до новой схемы
for (const u of db.users) {
  if (!u.photos) u.photos = u.avatar ? [u.avatar] : [];
  if (!u.privacy) u.privacy = { closed: false };
  if (!u.settings) u.settings = { muteNewChats: false, hideOnline: false };
  if (typeof u.settings.hideEfir !== 'boolean') u.settings.hideEfir = false;
  if (!u.contacts) u.contacts = [];
  if (!u.blocked) u.blocked = [];
  if (!u.muted) u.muted = [];
}

// ---------- Web Push (VAPID) ----------
if (webpush) {
  if (!db.vapid) {
    db.vapid = webpush.generateVAPIDKeys();
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch {}
    console.log('🔑 VAPID ключи сгенерированы');
  }
  webpush.setVapidDetails('mailto:admin@veche.app', db.vapid.publicKey, db.vapid.privateKey);
}

// ---------- утилиты push ----------
function isUserOnline(userId) {
  const room = io && io.sockets && io.sockets.adapter.rooms.get(userId);
  return !!(room && room.size > 0);
}
async function sendPush(userId, payload) {
  if (!webpush || !db.pushSubs) return;
  const subs = db.pushSubs[userId];
  if (!subs || !subs.length) return;
  const bad = [];
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) bad.push(sub.endpoint); }
  }
  if (bad.length) { db.pushSubs[userId] = db.pushSubs[userId].filter((s) => !bad.includes(s.endpoint)); save(); }
}

// Входящие звонки — in-memory (сбрасываются при рестарте; хранить в db незачем — звонок длится секунды)
const pendingCalls = new Map(); // calleeId -> {from, name, avatar, colors, sdp, ts}

// флаг: нужно ли разово сохранить базу на старте (после очистки/создания Алисы)
let bootDirty = false;

// ---------- очистка: старый бот-помощник удалён полностью ----------
(() => {
  const oldBot = db.users.find((u) => u.username === 'pomoshnik' || u.id === 'aibot');
  if (!oldBot) return;
  const bid = oldBot.id;
  db.users = db.users.filter((u) => u.id !== bid);
  // вычищаем его сообщения и личную переписку с ним
  db.messages = db.messages.filter((m) => m.from !== bid && !(m.chatId && m.chatId.startsWith('dm:') && m.chatId.includes(bid)));
  for (const u of db.users) {
    if (Array.isArray(u.contacts)) u.contacts = u.contacts.filter((id) => id !== bid);
    if (Array.isArray(u.muted)) u.muted = u.muted.filter((id) => !String(id).includes(bid));
  }
  for (const c of db.chats) {
    if (Array.isArray(c.members)) c.members = c.members.filter((id) => id !== bid);
    if (Array.isArray(c.subscribers)) c.subscribers = c.subscribers.filter((id) => id !== bid);
    if (Array.isArray(c.admins)) c.admins = c.admins.filter((id) => id !== bid);
  }
  bootDirty = true;
  console.log('🗑  Старый бот-помощник (pomoshnik) удалён из базы.');
})();

// ---------- ИИ-ассистент «Алиса» (YandexGPT) ----------
const ALISA_USERNAME = 'alisa';
let ALISA = db.users.find((u) => u.username === ALISA_USERNAME);
if (!ALISA) {
  ALISA = {
    id: 'alisa', username: ALISA_USERNAME, displayName: 'Алиса ✨',
    bio: 'ИИ-ассистент ВЕЧЕ на YandexGPT. Спроси что угодно — в личке или позови через @алиса в любом чате.',
    avatar: null, photos: [], tg: null, phone: null, email: null,
    salt: '', passHash: '__nologin__', token: null, colors: ['#ff5ca8', '#7a5cff'],
    createdAt: Date.now(), lastSeen: null, privacy: { closed: false, showPhone: false, ghost: false },
    settings: { muteNewChats: false, hideOnline: false, hideEfir: false },
    contacts: [], blocked: [], muted: [], isBot: true,
    customStatus: '✨ ИИ-ассистент · YandexGPT',
  };
  db.users.push(ALISA);
  bootDirty = true;
} else { ALISA.isBot = true; ALISA.customStatus = '✨ ИИ-ассистент · YandexGPT'; }
// разовое сохранение на старте (save() ещё в TDZ, пишем напрямую)
if (bootDirty) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch {} }

// ---------- YandexGPT: запрос к модели ----------
const ALISA_SYSTEM = 'Ты — Алиса, дружелюбный ИИ-ассистент внутри мессенджера ВЕЧЕ. Отвечай по-русски, тепло и по делу, без воды. Если просят код или факты — будь точной. Если чего-то не знаешь — честно скажи. Пиши коротко, как в мессенджере.';
async function yandexGPT(messages) {
  if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) return null;
  try {
    const r = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Api-Key ' + YANDEX_API_KEY,
        'x-folder-id': YANDEX_FOLDER_ID,
      },
      body: JSON.stringify({
        modelUri: `gpt://${YANDEX_FOLDER_ID}/${YANDEX_MODEL}/latest`,
        completionOptions: { stream: false, temperature: 0.6, maxTokens: 1500 },
        messages,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) { console.error('YandexGPT', r.status, (await r.text().catch(() => '')).slice(0, 200)); return null; }
    const data = await r.json();
    const alt = data && data.result && data.result.alternatives && data.result.alternatives[0];
    const text = alt && alt.message && alt.message.text;
    return text ? String(text).trim() : null;
  } catch (e) { console.error('YandexGPT exc:', e.message); return null; }
}

// ---------- триггер и ответ Алисы ----------
const alisaCooldown = new Map();
function alisaTriggered(msg) {
  if (!ALISA || msg.from === ALISA.id || !msg.text) return false;
  // в ЛС с Алисой — любое сообщение; при голосовом с «расшифруй» в тексте — тоже
  if (msg.chatId.startsWith('dm:') && msg.chatId.includes(ALISA.id)) return true;
  if (msg.type !== 'text') return false;
  const low = msg.text.toLowerCase();
  return low.includes('@алиса') || low.includes('@alisa') || low.includes('@' + ALISA_USERNAME);
}
function alisaTyping(chatId, humanId) {
  if (chatId.startsWith('dm:')) io.to(humanId).emit('typing', { chatId: 'dm:' + ALISA.id, userId: ALISA.id, name: ALISA.displayName });
  else if (chatId === EFIR) io.to(EFIR).emit('typing', { chatId: EFIR, userId: ALISA.id, name: ALISA.displayName });
  else for (const u of roomTargets(chatId)) if (u !== ALISA.id) io.to(u).emit('typing', { chatId, userId: ALISA.id, name: ALISA.displayName });
}
function alisaSend(chatId, text) {
  const bmsg = { id: uid(), chatId, from: ALISA.id, type: 'text', text, ts: Date.now(), readBy: [ALISA.id], reactions: {}, deleted: false };
  db.messages.push(bmsg); save(); emitToChat(chatId, 'message', bmsg);
}
function stripMention(t) { return String(t || '').replace(/@алиса/gi, '').replace(/@alisa/gi, '').trim(); }

// Yandex SpeechKit — расшифровка голосовых
async function speechKitTranscribe(filePath) {
  if (!YANDEX_API_KEY || !YANDEX_FOLDER_ID) return null;
  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const fmt = (ext === '.mp4' || ext === '.m4a') ? 'mp4' : 'oggopus';
    const url = `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?folderId=${YANDEX_FOLDER_ID}&format=${fmt}&lang=ru-RU`;
    const r = await fetch(url, { method: 'POST', headers: { 'Authorization': `Api-Key ${YANDEX_API_KEY}` }, body: data, signal: AbortSignal.timeout(15000) });
    const json = await r.json();
    return json.result || null;
  } catch (e) { console.error('SpeechKit:', e.message); return null; }
}

// Парсинг напоминалки из текста
function parseReminder(text, chatId, userId) {
  const t = text.toLowerCase();
  const now = Date.now();
  let fireAt = null;
  let what = '';
  const inM = t.match(/через\s+(\d+)\s*(мин|минут|час|ч\b|дн|день|дней|сут)/);
  if (inM) {
    const n = parseInt(inM[1]);
    const u = inM[2];
    const mult = u.startsWith('мин') ? 60000 : (u === 'ч' || u.startsWith('час')) ? 3600000 : 86400000;
    fireAt = now + n * mult;
    what = text.replace(/напомни\s*/i, '').replace(/через\s+\d+\s*\S+\s*/i, '').trim();
  }
  if (!fireAt) {
    const atM = t.match(/(завтра\s+)?в\s+(\d{1,2})[:\.](\d{2})/);
    if (atM) {
      const d = new Date();
      d.setHours(parseInt(atM[2]), parseInt(atM[3]), 0, 0);
      if (atM[1]) d.setDate(d.getDate() + 1);
      else if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      fireAt = d.getTime();
      what = text.replace(/напомни\s*/i, '').replace(/(завтра\s+)?в\s+\d+[:.]\d+\s*/i, '').trim();
    }
  }
  if (!fireAt) return null;
  return { id: uid(), userId, chatId, text: what || 'Напоминание!', fireAt };
}

async function maybeAlisaReply(msg) {
  if (!alisaTriggered(msg)) return;
  const now = Date.now();
  if (now - (alisaCooldown.get(msg.from) || 0) < 2000) return;
  alisaCooldown.set(msg.from, now);
  const chatId = msg.chatId;
  const rawText = stripMention(msg.text || '');
  const tLow = rawText.toLowerCase();

  // ── Расшифровка голосового: @алиса расшифруй / в ответ на войс ──
  const isTranscribeReq = tLow.includes('расшифруй') || tLow.includes('транскрибируй') || tLow.includes('перевод') || tLow === 'текст';
  if (isTranscribeReq && msg.replyTo) {
    const voiceMsg = db.messages.find((m) => m.id === msg.replyTo.id && m.type === 'voice' && !m.deleted);
    if (voiceMsg && voiceMsg.media && voiceMsg.media.url) {
      alisaTyping(chatId, msg.from);
      const filePath = path.join(UPLOAD_DIR, path.basename(voiceMsg.media.url));
      const transcript = await speechKitTranscribe(filePath);
      alisaSend(chatId, transcript ? `🎤 «${transcript}»` : 'Не смогла расшифровать — возможно, формат не поддерживается. Попробуй сохранить как .ogg и отправить снова.');
      return;
    }
  }

  // ── Напоминалка: @алиса напомни через X / в Y:MM ──
  if (tLow.includes('напомни')) {
    const reminder = parseReminder(rawText, chatId, msg.from);
    if (reminder) {
      if (!db.reminders) db.reminders = [];
      db.reminders.push(reminder); save();
      const when = new Date(reminder.fireAt).toLocaleString('ru', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      alisaSend(chatId, `⏰ Напомню ${when}: «${reminder.text}»`);
      return;
    }
  }

  alisaTyping(chatId, msg.from);

  // ── Определяем: просят резюме чата («что пропустил?») или обычный вопрос ──
  const isSummary = rawText.trim().length < 70 && (
    tLow === '' || tLow === 'привет' || tLow.includes('пропустил') || tLow.includes('tldr') ||
    tLow.includes('что тут') || tLow.includes('о чём') || tLow.includes('о чем') ||
    tLow.includes('резюме') || tLow.includes('кратко') || tLow.includes('что было')
  );

  const sysText = isSummary
    ? 'Ты — Алиса, ИИ-ассистент мессенджера ВЕЧЕ. Тебе дана история переписки с именами участников. Сделай краткое резюме по-русски: о чём говорили, какие договорились, что важного. Пиши кратко, по пунктам. Не перечисляй каждое сообщение — выдели суть.'
    : 'Ты — Алиса, дружелюбный ИИ-ассистент внутри мессенджера ВЕЧЕ. Отвечай по-русски, тепло и по делу, без воды. Если просят код или факты — будь точной. Если чего-то не знаешь — честно скажи. Пиши коротко, как в мессенджере.';

  const histLimit = isSummary ? 100 : 25;
  const hist = db.messages.filter((m) => m.chatId === chatId && !m.deleted).slice(-histLimit);

  const gmsgs = [{ role: 'system', text: sysText }];
  for (const m of hist) {
    if (m.from === ALISA.id) {
      if (m.text) gmsgs.push({ role: 'assistant', text: m.text.slice(0, 800) });
      continue;
    }
    const author = findUser(m.from);
    const name = author ? author.displayName : 'кто-то';
    let content = null;
    if (m.type === 'text' && m.text) content = stripMention(m.text).slice(0, 1500);
    else if (m.type === 'voice') content = '[голосовое сообщение]';
    else if (m.type === 'image' || m.type === 'album') content = '[фото]';
    else if (m.type === 'video_circle' || m.type === 'circle') content = '[кружок]';
    else if (m.type === 'file') content = `[файл: ${(m.media && m.media.name) || ''}]`;
    else if (m.type === 'geo') content = '[геолокация]';
    else if (m.type === 'poll') content = `[опрос: ${(m.media && m.media.question) || ''}]`;
    else if (m.type === 'system' && m.text) content = `[система: ${m.text}]`;
    if (content) gmsgs.push({ role: 'user', text: `${name}: ${content}` });
  }
  if (!isSummary && gmsgs[gmsgs.length - 1].role !== 'user')
    gmsgs.push({ role: 'user', text: rawText || 'привет' });

  let text = await yandexGPT(gmsgs);
  if (!text) {
    text = (!YANDEX_API_KEY || !YANDEX_FOLDER_ID)
      ? 'Привет! Я Алиса ✨ Меня почти подключили — осталось вписать ключ и каталог Яндекс Облака на сервере.'
      : 'Ой, не получилось подумать 🤕 Попробуй ещё раз чуть позже.';
  }
  alisaSend(chatId, text);
}

// ---------- Push: уведомляем офлайн-получателей о новом сообщении ----------
async function notifyOffline(msg, sender) {
  if (!webpush) return;
  const chatId = msg.chatId;
  let recipients = [];
  if (chatId === EFIR) {
    recipients = db.users.map((u) => u.id).filter((id) => id !== sender.id && id !== ALISA.id);
  } else if (chatId.startsWith('dm:')) {
    const [, a, b] = chatId.split(':');
    recipients = [a === sender.id ? b : a];
  } else {
    const chat = findChat(chatId);
    if (!chat) return;
    recipients = [...(chat.members || []), ...(chat.subscribers || [])].filter((id) => id !== sender.id);
  }
  let body = '';
  if (msg.type === 'e2e') body = '🔒 Зашифрованное сообщение';   // содержимое серверу неизвестно
  else if (msg.type === 'text') body = (msg.text || '').slice(0, 120);
  else if (msg.type === 'voice') body = '🎤 Голосовое сообщение';
  else if (msg.type === 'image' || msg.type === 'album') body = '🖼 Фото';
  else if (msg.type === 'file') body = `📎 ${(msg.media && msg.media.name) || 'Файл'}`;
  else if (msg.type === 'geo') body = '📍 Геолокация';
  else if (msg.type === 'video_circle' || msg.type === 'circle') body = '⭕ Кружок';
  else if (msg.type === 'poll') body = `📊 Опрос: ${(msg.media && msg.media.question) || ''}`;
  else body = 'Новое сообщение';

  const isDM = chatId.startsWith('dm:');
  for (const userId of recipients) {
    if (isUserOnline(userId)) continue;
    const user = findUser(userId);
    if (!user || user.banned) continue;
    if (user.muted && (user.muted.includes(chatId) || (user.settings && user.settings.muteNewChats))) continue;
    const chat = !isDM && chatId !== EFIR ? findChat(chatId) : null;
    const title = isDM ? sender.displayName : `${sender.displayName} в ${chat ? chat.title : 'чате'}`;
    await sendPush(userId, { type: 'message', title, body, chatId });
  }
}

// ---------- Напоминалки: доставка ----------
setInterval(async () => {
  if (!db.reminders || !db.reminders.length) return;
  const now = Date.now();
  const due = db.reminders.filter((r) => r.fireAt <= now);
  if (!due.length) return;
  db.reminders = db.reminders.filter((r) => r.fireAt > now);
  for (const r of due) {
    alisaSend(r.chatId, `⏰ Напоминание: ${r.text}`);
    if (!isUserOnline(r.userId)) {
      sendPush(r.userId, { type: 'message', title: 'Алиса ✨', body: `⏰ ${r.text}`, chatId: r.chatId }).catch(() => {});
    }
  }
  save();
}, 10000);

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(db), (err) => { if (err) console.error('save:', err.message); });
  }, 250);
}

// ---------- утилиты ----------
const uid = () => crypto.randomBytes(8).toString('hex');
const hashPass = (p, s) => crypto.scryptSync(p, s, 64).toString('hex');
const sanitize = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

const PALETTES = [
  ['#7a5cff', '#00d4ff'], ['#ff5c7a', '#ff9d5c'], ['#00e676', '#00b0ff'],
  ['#ff6ec4', '#7873f5'], ['#f7b733', '#fc4a1a'], ['#43e97b', '#38f9d7'],
  ['#fa709a', '#fee140'], ['#30cfd0', '#5b48e0'], ['#a8ff78', '#78ffd6'],
  ['#f953c6', '#b91d73'],
];
function paletteFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTES[h % PALETTES.length];
}
const dmId = (a, b) => 'dm:' + [a, b].sort().join(':');
const findUser = (id) => db.users.find((u) => u.id === id);
const findChat = (id) => db.chats.find((c) => c.id === id);

// игры — движок вынесен в lib/games.js (чистые функции)
const { tttWinner, rpsWinner, c4Winner, c4Drop, newGameState, initRound } = require('./lib/games');

function publicUser(u) {
  return {
    id: u.id, username: u.username, name: u.displayName,
    bio: u.bio || '', avatar: u.avatar || null, photos: u.photos || [],
    tg: u.tg || null, phone: (u.privacy && u.privacy.showPhone) ? (u.phone || null) : null,
    colors: u.colors, closed: !!(u.privacy && u.privacy.closed),
    ghost: !!(u.privacy && u.privacy.ghost),
    customStatus: u.customStatus || (u.isBot ? '🤖 бот · всегда на связи' : null),
    bot: !!u.isBot,
    pubKey: u.pubKey || null,   // публичный ключ E2E (для секретных чатов); приватный сервер не видит никогда
    online: u.isBot ? true : (!(u.settings && u.settings.hideOnline) && onlineSet.has(u.id)),
    lastSeen: (u.settings && u.settings.hideOnline) || (u.privacy && u.privacy.ghost) ? null : (u.lastSeen || null),
  };
}
// видят ли друг друга (для режима Призрак): есть общая история/чат/контакт
function knowsEachOther(viewerId, targetId) {
  if (viewerId === targetId) return true;
  const v = findUser(viewerId), t = findUser(targetId);
  if (v && v.contacts.includes(targetId)) return true;
  if (t && t.contacts.includes(viewerId)) return true;
  const dm = dmId(viewerId, targetId);
  if (db.messages.some((m) => m.chatId === dm)) return true;
  // общий групповой чат / канал
  for (const c of db.chats) {
    const all = [...c.members, ...(c.subscribers || [])];
    if (all.includes(viewerId) && all.includes(targetId)) return true;
  }
  return false;
}
// список юзеров, видимых конкретному зрителю (Призраки скрыты от незнакомцев)
function visibleUsersFor(viewer) {
  return db.users
    .filter((u) => !(u.privacy && u.privacy.ghost) || knowsEachOther(viewer.id, u.id))
    .map(publicUser);
}
// рассылка мета-инфо о юзере с учётом режима Призрак
function broadcastUserMeta(user, event) {
  const payload = publicUser(user);
  if (!(user.privacy && user.privacy.ghost)) { io.emit(event, payload); return; }
  for (const v of db.users) if (knowsEachOther(v.id, user.id)) io.to(v.id).emit(event, payload);
}
function broadcastPresence(user, data) {
  if (user.privacy && user.privacy.ghost) {
    for (const v of db.users) if (v.id !== user.id && knowsEachOther(v.id, user.id)) io.to(v.id).emit('presence', data);
  } else io.emit('presence', data);
}
function selfUser(u) {
  return {
    id: u.id, username: u.username, name: u.displayName, bio: u.bio || '',
    avatar: u.avatar || null, photos: u.photos || [], tg: u.tg || null,
    phone: u.phone || null, email: u.email || null, colors: u.colors,
    privacy: u.privacy, settings: u.settings, customStatus: u.customStatus || null,
    contacts: u.contacts, blocked: u.blocked, muted: u.muted,
    admin: isSuperAdmin(u), banned: !!u.banned, pubKey: u.pubKey || null,
  };
}

// ---------- антиспам / модерация ----------
const spamState = new Map(); // userId -> {times:[], strikes, mutedUntil}
// фильтр запрещённого контента вынесен в lib/moderation.js — настраивайте под свою площадку
const { moderate } = require('./lib/moderation');
function spamCheck(userId, text) {
  const now = Date.now();
  let st = spamState.get(userId);
  if (!st) { st = { times: [], strikes: 0, mutedUntil: 0 }; spamState.set(userId, st); }
  if (st.mutedUntil > now) return { blocked: true, reason: `Слишком много сообщений — подожди ${Math.ceil((st.mutedUntil - now) / 1000)} сек` };
  st.times = st.times.filter((t) => now - t < 5000);
  st.times.push(now);
  if (st.times.length > 7) { st.mutedUntil = now + 15000; st.strikes++; return { blocked: true, reason: 'Антифлуд: пауза 15 сек' }; }
  if (text && text.length > 8 && st.lastText === text) {
    st.repeat = (st.repeat || 0) + 1;
    if (st.repeat >= 3) { st.mutedUntil = now + 15000; return { blocked: true, reason: 'Не повторяй одно и то же' }; }
  } else st.repeat = 0;
  st.lastText = text;
  const banned = moderate(text);
  if (banned) { st.strikes = (st.strikes || 0) + 1; return { blocked: true, reason: banned, flagged: true }; }
  return { blocked: false };
}

// супер-админы (видят жалобы, банят пользователей).
// По умолчанию администратором становится ПЕРВЫЙ зарегистрированный человек (см. /api/register).
// Дополнительно можно закрепить ников через переменную ADMINS="ivan,petrov" в .env.
const ADMIN_USERNAMES = (process.env.ADMINS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
function isSuperAdmin(u) { return u && (ADMIN_USERNAMES.includes(u.username) || u.admin === true); }
// нет ли уже живого админа (человека)? — чтобы назначить первого пользователя
function hasHumanAdmin() { return db.users.some((u) => !u.isBot && isSuperAdmin(u)); }

// членство в чате
function canSee(user, chatId) {
  if (chatId === EFIR) return true;
  if (chatId.startsWith('dm:')) return chatId.includes(user.id);
  const c = findChat(chatId);
  if (!c) return false;
  if (c.type === 'channel') return c.members.includes(user.id) || c.subscribers.includes(user.id);
  return c.members.includes(user.id);
}
function canSend(user, chatId) {
  if (chatId === EFIR) return true;
  if (chatId.startsWith('dm:')) return chatId.includes(user.id);
  const c = findChat(chatId);
  if (!c) return false;
  if (c.type === 'channel') return c.admins.includes(user.id) || c.owner === user.id;
  return c.members.includes(user.id);
}
const isAdmin = (c, uid) => c.owner === uid || c.admins.includes(uid);

// ---------- HTTP ----------
const app = express();
app.set('trust proxy', 1);      // за nginx/reverse-proxy — корректный req.ip
app.disable('x-powered-by');

// базовые заголовки безопасности для всех ответов
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');            // защита от кликджекинга
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Раздача загруженных файлов. Всё, кроме безопасного медиа, отдаём как вложение
// (Content-Disposition: attachment) + nosniff — иначе загруженный .html/.svg мог бы
// выполнить скрипт в контексте нашего домена (stored XSS).
const INLINE_OK = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.m4a', '.ogg', '.mp3', '.wav', '.mov']);
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders(res, filePath) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!INLINE_OK.has(path.extname(filePath).toLowerCase())) res.setHeader('Content-Disposition', 'attachment');
  },
}));

// Простой антибрутфорс: N попыток на IP в окне. Хранится в памяти.
const rlHits = new Map();
function rateLimit(ip, bucket, max, windowMs) {
  const key = bucket + ':' + (ip || '?'), now = Date.now();
  let e = rlHits.get(key);
  if (!e || now > e.reset) { e = { count: 0, reset: now + windowMs }; rlHits.set(key, e); }
  e.count++;
  return e.count <= max;
}
setInterval(() => { const now = Date.now(); for (const [k, e] of rlHits) if (now > e.reset) rlHits.delete(k); }, 60000).unref();

function userByToken(req) {
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-token'] || '');
  return db.users.find((u) => u.token === token);
}

app.post('/api/register', (req, res) => {
  if (!rateLimit(req.ip, 'reg', 8, 60000)) return res.status(429).json({ error: 'Слишком много попыток — подождите минуту' });
  const username = sanitize(req.body.username, 24).toLowerCase();
  const displayName = sanitize(req.body.username, 24);
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,24}$/i.test(username))
    return res.status(400).json({ error: 'Юзернейм: 3–24, латиница/цифры/_' });
  if (password.length < 4) return res.status(400).json({ error: 'Пароль: минимум 4 символа' });
  if (db.users.some((u) => u.username === username))
    return res.status(409).json({ error: 'Этот юзернейм уже занят' });
  // первый зарегистрированный человек становится администратором (если админы не заданы через ADMINS)
  const makeAdmin = ADMIN_USERNAMES.length === 0 && !hasHumanAdmin();
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: uid(), username, displayName, bio: '', avatar: null, photos: [],
    tg: null, phone: null, email: null,
    salt, passHash: hashPass(password, salt), token: crypto.randomBytes(24).toString('hex'),
    colors: paletteFor(username), createdAt: Date.now(), lastSeen: null,
    privacy: { closed: false, showPhone: false }, settings: { muteNewChats: false, hideOnline: false },
    contacts: [], blocked: [], muted: [], admin: makeAdmin,
  };
  db.users.push(user);
  save();
  if (makeAdmin) console.log(`👑 @${username} — первый пользователь, назначен администратором.`);
  io.emit('user_joined', publicUser(user));   // новый юзер не Призрак по умолчанию
  res.json({ token: user.token });
});

app.post('/api/login', (req, res) => {
  if (!rateLimit(req.ip, 'login', 12, 60000)) return res.status(429).json({ error: 'Слишком много попыток — подождите минуту' });
  const username = sanitize(req.body.username, 24).toLowerCase();
  const password = String(req.body.password || '');
  const user = db.users.find((u) => u.username === username);
  if (!user || hashPass(password, user.salt) !== user.passHash)
    return res.status(401).json({ error: 'Неверный юзернейм или пароль' });
  if (user.banned) return res.status(403).json({ error: 'Аккаунт заблокирован за нарушение правил' });
  user.token = crypto.randomBytes(24).toString('hex');
  save();
  res.json({ token: user.token });
});

app.post('/api/profile', (req, res) => {
  const user = userByToken(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const b = req.body;
  if (typeof b.name === 'string' && sanitize(b.name, 24)) user.displayName = sanitize(b.name, 24);
  if (typeof b.bio === 'string') user.bio = sanitize(b.bio, 140);
  if (typeof b.tg === 'string') {
    const tg = sanitize(b.tg, 32).replace(/^@/, '');
    user.tg = /^[a-z0-9_]{3,32}$/i.test(tg) ? tg : (tg === '' ? null : user.tg);
  }
  if (typeof b.phone === 'string') user.phone = sanitize(b.phone, 24) || null;
  if (typeof b.email === 'string') user.email = sanitize(b.email, 64) || null;
  if (typeof b.avatar === 'string' && b.avatar.startsWith('/uploads/')) {
    user.avatar = b.avatar;
    if (!user.photos.includes(b.avatar)) user.photos.unshift(b.avatar);
    user.photos = user.photos.slice(0, 10);
  }
  if (b.removePhoto && typeof b.removePhoto === 'string') {
    user.photos = user.photos.filter((p) => p !== b.removePhoto);
    if (user.avatar === b.removePhoto) user.avatar = user.photos[0] || null;
  }
  if (b.setMainPhoto && user.photos.includes(b.setMainPhoto)) user.avatar = b.setMainPhoto;
  if (typeof b.customStatus === 'string') user.customStatus = sanitize(b.customStatus, 40) || null;
  if (b.privacy && typeof b.privacy === 'object') {
    if (typeof b.privacy.closed === 'boolean') user.privacy.closed = b.privacy.closed;
    if (typeof b.privacy.showPhone === 'boolean') user.privacy.showPhone = b.privacy.showPhone;
    if (typeof b.privacy.ghost === 'boolean') user.privacy.ghost = b.privacy.ghost;
  }
  if (b.settings && typeof b.settings === 'object') {
    if (typeof b.settings.muteNewChats === 'boolean') user.settings.muteNewChats = b.settings.muteNewChats;
    if (typeof b.settings.hideOnline === 'boolean') user.settings.hideOnline = b.settings.hideOnline;
    if (typeof b.settings.hideEfir === 'boolean') user.settings.hideEfir = b.settings.hideEfir;
  }
  if (Array.isArray(b.blocked)) user.blocked = b.blocked.filter((id) => typeof id === 'string').slice(0, 500);
  // публичный ключ E2E (base64 raw ECDH P-256, ~88 симв.). Приватный ключ на сервер не приходит НИКОГДА.
  if (typeof b.pubKey === 'string' && b.pubKey.length && b.pubKey.length < 500 && /^[A-Za-z0-9+/=]+$/.test(b.pubKey)) user.pubKey = b.pubKey;
  save();
  broadcastUserMeta(user, 'user_updated');
  res.json(selfUser(user));
});

app.post('/api/password', (req, res) => {
  const user = userByToken(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const cur = String(req.body.current || ''), next = String(req.body.next || '');
  if (hashPass(cur, user.salt) !== user.passHash) return res.status(403).json({ error: 'Текущий пароль неверный' });
  if (next.length < 4) return res.status(400).json({ error: 'Новый пароль: минимум 4 символа' });
  user.salt = crypto.randomBytes(16).toString('hex');
  user.passHash = hashPass(next, user.salt);
  user.token = crypto.randomBytes(24).toString('hex');
  save();
  res.json({ token: user.token });
});

// универсальная загрузка: фото / голос / видео-кружок / любой файл
app.post('/api/upload',
  express.raw({ type: () => true, limit: '40mb' }),
  (req, res) => {
    const user = userByToken(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Пусто' });
    const mime = (req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    const origName = sanitize(decodeURIComponent(req.headers['x-filename'] || ''), 120);
    let ext = '';
    const m = origName.match(/\.[a-z0-9]{1,8}$/i);
    if (m) ext = m[0];
    else {
      const map = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
        'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3',
        'video/webm': '.webm', 'video/mp4': '.mp4' };
      ext = map[mime] || '.bin';
    }
    const fname = uid() + uid() + ext;
    try { fs.writeFileSync(path.join(UPLOAD_DIR, fname), req.body); }
    catch (e) { return res.status(500).json({ error: 'Не удалось сохранить' }); }
    res.json({ url: '/uploads/' + fname, size: req.body.length, name: origName || null, mime });
  }
);

// лог падений мобильного клиента (необработанные исключения) — «чёрный ящик».
// Пишем построчно JSON в mobile-crash.log, файл не даём разрастаться больше 1МБ.
app.post('/api/mobile-log', (req, res) => {
  try {
    const b = req.body || {};
    const line = JSON.stringify({
      at: new Date().toISOString(),
      v: String(b.versionName || '') + '/' + String(b.versionCode || ''),
      device: String(b.device || '').slice(0, 80),
      android: b.android,
      error: String(b.error || '').slice(0, 300),
      stack: String(b.stack || '').slice(0, 4000),
    }) + '\n';
    const file = path.join(__dirname, 'mobile-crash.log');
    try { if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.writeFileSync(file, ''); } catch (_) {}
    fs.appendFileSync(file, line);
  } catch (_) {}
  res.json({ ok: true });
});

// ---------- Превью ссылок (Open Graph) ----------
// Сервер сам ходит по ссылке и достаёт title/description/image — клиент показывает карточку.
// Защита от SSRF: только http/https и только публичные адреса (не локальная сеть/облачные метаданные).
const linkCache = new Map(); // url -> { data, exp }
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 10 || p[0] === 127 || p[0] === 0 || (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
}
async function hostIsPublic(hostname) {
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return false;
  if (net.isIP(h)) return !isPrivateIp(h);
  try {
    const addrs = await dns.lookup(h, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch { return false; }
}
function ogTag(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*>', 'i');
  const tag = html.match(re);
  if (!tag) return null;
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? c[1].trim() : null;
}
app.get('/api/link-preview', async (req, res) => {
  const user = userByToken(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  if (!rateLimit(req.ip, 'lp', 40, 60000)) return res.status(429).json({ error: 'rate' });
  const raw = String(req.query.url || '').slice(0, 2000);
  let url;
  try { url = new URL(raw); } catch { return res.status(400).json({ error: 'bad url' }); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return res.status(400).json({ error: 'bad scheme' });
  const cached = linkCache.get(url.href);
  if (cached && cached.exp > Date.now()) return res.json(cached.data);
  if (!(await hostIsPublic(url.hostname))) return res.status(403).json({ error: 'private host' });
  try {
    const r = await fetch(url.href, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VecheBot/1.0; +link-preview)', 'Accept': 'text/html' },
      redirect: 'follow', signal: AbortSignal.timeout(6000),
    });
    const ctype = r.headers.get('content-type') || '';
    if (!r.ok || !ctype.includes('text/html')) return res.json({ url: url.href, host: url.hostname });
    // читаем не более ~256 КБ
    const reader = r.body.getReader();
    let received = 0; const chunks = [];
    while (received < 262144) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); received += value.length;
    }
    try { await reader.cancel(); } catch {}
    const html = Buffer.concat(chunks).toString('utf8');
    const titleTag = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1];
    const data = {
      url: url.href, host: url.hostname,
      title: (ogTag(html, 'og:title') || titleTag || '').slice(0, 200) || null,
      description: (ogTag(html, 'og:description') || ogTag(html, 'description') || '').slice(0, 300) || null,
      image: ogTag(html, 'og:image') || null,
      siteName: ogTag(html, 'og:site_name') || null,
    };
    if (data.image) { try { data.image = new URL(data.image, url.href).href; } catch { data.image = null; } }
    linkCache.set(url.href, { data, exp: Date.now() + 6 * 3600 * 1000 });
    if (linkCache.size > 500) linkCache.delete(linkCache.keys().next().value);
    res.json(data);
  } catch (e) { res.json({ url: url.href, host: url.hostname }); }
});

// ---------- Socket.io ----------
// ---------- Push API ----------
app.get('/api/push/keys', (req, res) => {
  if (!webpush || !db.vapid) return res.status(503).json({ error: 'push not configured' });
  res.json({ publicKey: db.vapid.publicKey });
});
app.post('/api/push/subscribe', express.json(), (req, res) => {
  const user = userByToken(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'bad subscription' });
  if (!db.pushSubs[user.id]) db.pushSubs[user.id] = [];
  if (!db.pushSubs[user.id].some((s) => s.endpoint === sub.endpoint)) { db.pushSubs[user.id].push(sub); save(); }
  res.json({ ok: true });
});
app.post('/api/push/unsubscribe', express.json(), (req, res) => {
  const user = userByToken(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const { endpoint } = req.body || {};
  if (endpoint && db.pushSubs[user.id]) {
    db.pushSubs[user.id] = db.pushSubs[user.id].filter((s) => s.endpoint !== endpoint); save();
  }
  res.json({ ok: true });
});
// Проверить входящий звонок при открытии приложения
app.get('/api/call/pending', (req, res) => {
  const user = userByToken(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const call = pendingCalls.get(user.id);
  if (!call || Date.now() - call.ts > 45000) return res.json({ call: null });
  res.json({ call: { from: call.from, name: call.name, avatar: call.avatar, colors: call.colors, sdp: call.sdp } });
});
// Отклонить звонок из уведомления без открытия приложения
app.post('/api/call/decline', express.json(), (req, res) => {
  const user = userByToken(req);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  const call = pendingCalls.get(user.id);
  if (call) { pendingCalls.delete(user.id); io && io.to(call.from).emit('call:declined', { from: user.id }); }
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e6 });

const sockets = new Map();
let onlineSet = new Set();
function recomputeOnline() {
  onlineSet = new Set([...sockets.keys()].filter((k) => sockets.get(k).size > 0));
}

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const user = db.users.find((u) => u.token === token);
  if (!user) return next(new Error('unauthorized'));
  if (user.banned) return next(new Error('banned'));
  socket.user = user;
  next();
});

// все чаты, видимые юзеру (для списка)
function chatsFor(user) {
  const result = [];
  const seen = new Set();
  // EFIR
  result.push(chatMeta(EFIR, user));
  seen.add(EFIR);
  // закреплённый чат с Алисой (ИИ-ассистент) — всегда доступен
  if (ALISA && user.id !== ALISA.id) {
    const aid = dmId(user.id, ALISA.id);
    if (!seen.has(aid)) { result.push(chatMeta(aid, user)); seen.add(aid); }
  }
  // группы/каналы
  for (const c of db.chats) {
    if (canSee(user, c.id)) { result.push(chatMeta(c.id, user)); seen.add(c.id); }
  }
  // ЛС с историей
  for (const m of db.messages) {
    if (m.chatId.startsWith('dm:') && m.chatId.includes(user.id) && !seen.has(m.chatId)) {
      result.push(chatMeta(m.chatId, user)); seen.add(m.chatId);
    }
  }
  return result;
}
function lastMsg(chatId) {
  for (let i = db.messages.length - 1; i >= 0; i--)
    if (db.messages[i].chatId === chatId && !db.messages[i].deleted) return db.messages[i];
  return null;
}
function chatMeta(chatId, user) {
  let unread = 0;
  for (const m of db.messages)
    if (m.chatId === chatId && !m.deleted && m.from !== user.id && !m.readBy.includes(user.id)) unread++;
  const meta = { chatId, last: lastMsg(chatId), unread, muted: user.muted.includes(chatId) };
  const c = chatId.startsWith('dm:') ? null : findChat(chatId);
  if (c) {
    meta.kind = c.type; meta.title = c.title; meta.avatar = c.avatar;
    meta.membersCount = c.members.length;
  } else if (chatId.startsWith('dm:')) {
    meta.kind = 'dm';
    const [, a, b] = chatId.split(':');
    meta.peerId = a === user.id ? b : a;
  } else { meta.kind = 'efir'; }
  return meta;
}

function roomTargets(chatId) {
  if (chatId === EFIR) return null; // EFIR room
  if (chatId.startsWith('dm:')) { const [, a, b] = chatId.split(':'); return [a, b]; }
  const c = findChat(chatId);
  if (!c) return [];
  const set = new Set([...c.members, ...(c.subscribers || []), ...c.admins, c.owner]);
  return [...set];
}
function emitToChat(chatId, event, payload) {
  if (chatId === EFIR) io.to(EFIR).emit(event, payload);
  else for (const u of roomTargets(chatId)) io.to(u).emit(event, payload);
}

io.on('connection', (socket) => {
  const me = socket.user;
  if (!sockets.has(me.id)) sockets.set(me.id, new Set());
  sockets.get(me.id).add(socket.id);
  recomputeOnline();

  socket.join(me.id);
  socket.join(EFIR);

  if (sockets.get(me.id).size === 1 && !(me.settings && me.settings.hideOnline))
    broadcastPresence(me, { userId: me.id, online: true });

  socket.emit('init', {
    me: selfUser(me),
    users: visibleUsersFor(me),
    chats: chatsFor(me),
    iceServers: iceServers(),
  });

  socket.on('history', ({ chatId }, cb) => {
    if (typeof cb !== 'function') return;
    if (!canSee(me, chatId)) return cb({ error: 'no access' });
    const msgs = db.messages.filter((m) => m.chatId === chatId).slice(-400);
    const c = chatId.startsWith('dm:') || chatId === EFIR ? null : findChat(chatId);
    cb({ msgs, chat: c ? publicChat(c) : null });
  });

  // ---- отправка ----
  socket.on('send', (p, cb) => {
    const out = doSend(me, p);
    if (typeof cb === 'function') cb(out);
  });

  // ---- редактирование ----
  socket.on('edit', ({ id, text }) => {
    const m = db.messages.find((x) => x.id === id);
    if (!m || m.from !== me.id || m.deleted) return;
    if (m.type !== 'text') return;
    m.text = sanitize(text, 4000); m.edited = true;
    save();
    emitToChat(m.chatId, 'edited', { id: m.id, text: m.text });
  });

  // ---- удалить у всех ----
  socket.on('delete', ({ id }) => {
    const m = db.messages.find((x) => x.id === id);
    if (!m) return;
    const chat = m.chatId.startsWith('dm:') || m.chatId === EFIR ? null : findChat(m.chatId);
    const allowed = m.from === me.id || (chat && isAdmin(chat, me.id));
    if (!allowed) return;
    m.deleted = true; m.text = ''; m.media = null; m.reactions = {};
    save();
    emitToChat(m.chatId, 'deleted', { id: m.id, chatId: m.chatId });
  });

  // ---- реакция ----
  socket.on('react', ({ id, emoji }) => {
    const m = db.messages.find((x) => x.id === id);
    if (!m || m.deleted || !canSee(me, m.chatId)) return;
    emoji = sanitize(emoji, 8);
    m.reactions = m.reactions || {};
    for (const e of Object.keys(m.reactions)) {
      m.reactions[e] = m.reactions[e].filter((u) => u !== me.id);
      if (!m.reactions[e].length) delete m.reactions[e];
    }
    if (emoji) { (m.reactions[emoji] = m.reactions[emoji] || []).push(me.id); }
    save();
    emitToChat(m.chatId, 'reacted', { id: m.id, reactions: m.reactions });
  });

  // ---- закрепить ----
  socket.on('pin', ({ id }) => {
    const m = db.messages.find((x) => x.id === id);
    if (!m || !canSee(me, m.chatId)) return;
    const chat = m.chatId.startsWith('dm:') || m.chatId === EFIR ? null : findChat(m.chatId);
    if (chat && !isAdmin(chat, me.id)) return;
    for (const x of db.messages) if (x.chatId === m.chatId) x.pinned = false;
    m.pinned = true; save();
    emitToChat(m.chatId, 'pinned', { id: m.id, chatId: m.chatId });
  });
  socket.on('unpin', ({ chatId }) => {
    if (!canSee(me, chatId)) return;
    for (const x of db.messages) if (x.chatId === chatId) x.pinned = false;
    save();
    emitToChat(chatId, 'pinned', { id: null, chatId });
  });

  // ---- typing ----
  socket.on('typing', ({ chatId }) => {
    if (!canSend(me, chatId)) return;
    if (chatId === EFIR) socket.to(EFIR).emit('typing', { chatId: EFIR, userId: me.id, name: me.displayName });
    else if (chatId.startsWith('dm:')) {
      const [, a, b] = chatId.split(':'); const peer = a === me.id ? b : a;
      io.to(peer).emit('typing', { chatId: 'dm:' + me.id, userId: me.id, name: me.displayName });
    } else {
      for (const u of roomTargets(chatId)) if (u !== me.id) io.to(u).emit('typing', { chatId, userId: me.id, name: me.displayName });
    }
  });

  // ---- прочитано ----
  socket.on('read', ({ chatId }) => {
    if (!canSee(me, chatId)) return;
    let changed = false; const senders = new Set();
    for (const m of db.messages)
      if (m.chatId === chatId && m.from !== me.id && !m.readBy.includes(me.id)) {
        m.readBy.push(me.id); senders.add(m.from); changed = true;
      }
    if (changed) { save(); for (const s of senders) io.to(s).emit('read', { chatId, by: me.id }); }
  });

  // ---- мут ----
  socket.on('mute', ({ chatId, on }) => {
    if (on) { if (!me.muted.includes(chatId)) me.muted.push(chatId); }
    else me.muted = me.muted.filter((c) => c !== chatId);
    save();
    socket.emit('muted', { chatId, on: me.muted.includes(chatId) });
  });

  // ---- группы / каналы ----
  socket.on('createChat', ({ type, title, members, description }, cb) => {
    type = type === 'channel' ? 'channel' : 'group';
    title = sanitize(title, 48);
    if (!title) return cb && cb({ error: 'Нужно название' });
    const mem = Array.isArray(members) ? members.filter((id) => findUser(id)) : [];
    const chat = {
      id: (type === 'channel' ? 'chn:' : 'grp:') + uid(),
      type, title, description: sanitize(description, 200), avatar: null,
      owner: me.id, admins: [me.id],
      members: type === 'group' ? [...new Set([me.id, ...mem])] : [me.id],
      subscribers: type === 'channel' ? [...new Set(mem)] : [],
      createdAt: Date.now(),
    };
    db.chats.push(chat); save();
    // системное сообщение
    pushSystem(chat.id, `${me.displayName} создал ${type === 'channel' ? 'канал' : 'группу'} «${title}»`);
    for (const u of roomTargets(chat.id)) {
      io.to(u).emit('chat_created', chatMeta(chat.id, findUser(u)));
      io.to(u).emit('chat_info', publicChat(chat));
    }
    cb && cb({ ok: true, chatId: chat.id });
  });

  socket.on('updateChat', ({ chatId, title, description, avatar }, cb) => {
    const c = findChat(chatId);
    if (!c || !isAdmin(c, me.id)) return cb && cb({ error: 'нет прав' });
    if (typeof title === 'string' && sanitize(title, 48)) c.title = sanitize(title, 48);
    if (typeof description === 'string') c.description = sanitize(description, 200);
    if (typeof avatar === 'string' && avatar.startsWith('/uploads/')) c.avatar = avatar;
    save();
    broadcastChat(c);
    cb && cb({ ok: true });
  });

  socket.on('addMembers', ({ chatId, members }, cb) => {
    const c = findChat(chatId);
    if (!c || !isAdmin(c, me.id)) return cb && cb({ error: 'нет прав' });
    const list = (members || []).filter((id) => findUser(id));
    const arr = c.type === 'channel' ? c.subscribers : c.members;
    for (const id of list) if (!arr.includes(id)) {
      arr.push(id);
      io.to(id).emit('chat_created', chatMeta(c.id, findUser(id)));
      io.to(id).emit('chat_info', publicChat(c));
    }
    save();
    if (list.length) pushSystem(c.id, `${me.displayName} добавил: ${list.map((id) => findUser(id).displayName).join(', ')}`);
    broadcastChat(c);
    cb && cb({ ok: true });
  });

  socket.on('removeMember', ({ chatId, userId }, cb) => {
    const c = findChat(chatId);
    if (!c || !isAdmin(c, me.id) || userId === c.owner) return cb && cb({ error: 'нельзя' });
    c.members = c.members.filter((id) => id !== userId);
    c.subscribers = (c.subscribers || []).filter((id) => id !== userId);
    c.admins = c.admins.filter((id) => id !== userId);
    save();
    io.to(userId).emit('chat_removed', { chatId });
    pushSystem(c.id, `${findUser(userId) ? findUser(userId).displayName : 'участник'} удалён`);
    broadcastChat(c);
    cb && cb({ ok: true });
  });

  socket.on('setAdmin', ({ chatId, userId, on }, cb) => {
    const c = findChat(chatId);
    if (!c || c.owner !== me.id) return cb && cb({ error: 'только владелец' });
    if (on) { if (!c.admins.includes(userId)) c.admins.push(userId); }
    else c.admins = c.admins.filter((id) => id !== userId);
    save(); broadcastChat(c);
    cb && cb({ ok: true });
  });

  socket.on('leaveChat', ({ chatId }, cb) => {
    const c = findChat(chatId);
    if (!c) return;
    c.members = c.members.filter((id) => id !== me.id);
    c.subscribers = (c.subscribers || []).filter((id) => id !== me.id);
    c.admins = c.admins.filter((id) => id !== me.id);
    if (c.owner === me.id) c.owner = c.admins[0] || c.members[0] || null;
    save();
    socket.emit('chat_removed', { chatId });
    if (!c.members.length && !c.subscribers.length) db.chats = db.chats.filter((x) => x.id !== c.id);
    else { pushSystem(c.id, `${me.displayName} вышел`); broadcastChat(c); }
    cb && cb({ ok: true });
  });

  socket.on('chatInfo', ({ chatId }, cb) => {
    const c = findChat(chatId);
    if (!c || !canSee(me, chatId)) return cb && cb(null);
    cb && cb(publicChat(c));
  });

  // ---- ЗВОНКИ (WebRTC сигналинг, 1:1) ----
  socket.on('getIce', (a, b) => { const cb = typeof a === 'function' ? a : b; if (typeof cb === 'function') cb(iceServers()); });
  socket.on('call:offer', ({ to, sdp, video }) => {
    const peer = findUser(to); if (!peer) return;
    if (peer.blocked && peer.blocked.includes(me.id)) { socket.emit('call:declined', { from: to, reason: 'недоступен' }); return; }
    // Сохраняем входящий звонок — нужен если получатель откроет приложение позже
    const callData = { from: me.id, name: me.displayName, avatar: me.avatar || null, colors: me.colors, sdp, video: !!video, ts: Date.now() };
    pendingCalls.set(to, callData);
    setTimeout(() => { if (pendingCalls.get(to) === callData) pendingCalls.delete(to); }, 45000);
    io.to(to).emit('call:incoming', { from: me.id, name: me.displayName, avatar: me.avatar || null, colors: me.colors, sdp, video: !!video });
    // Push если получатель не в сети (приложение закрыто)
    if (!isUserOnline(to)) {
      sendPush(to, { type: 'call', from: me.id, name: me.displayName, avatar: me.avatar || null, token: peer.token }).catch(() => {});
    }
  });
  socket.on('call:answer', ({ to, sdp }) => {
    pendingCalls.delete(me.id); // я ответил — убираем pending
    io.to(to).emit('call:answered', { from: me.id, sdp });
  });
  socket.on('call:ice', ({ to, candidate }) => io.to(to).emit('call:ice', { from: me.id, candidate }));
  socket.on('call:decline', ({ to }) => {
    pendingCalls.delete(me.id); // я отклонил
    io.to(to).emit('call:declined', { from: me.id });
  });
  socket.on('call:end', ({ to }) => {
    pendingCalls.delete(me.id); pendingCalls.delete(to);
    io.to(to).emit('call:ended', { from: me.id });
  });
  socket.on('call:cancel', ({ to }) => {
    pendingCalls.delete(to); // вызывающий отменил — убираем pending у получателя
    io.to(to).emit('call:canceled', { from: me.id });
  });

  // ---- ИГРЫ (в личке, как сообщение) ----
  socket.on('game:create', ({ chatId, type, wins }, cb) => {
    let cid = chatId;
    if (cid && cid.startsWith('dm:') && cid.split(':').length === 2) cid = dmId(me.id, cid.slice(3));
    if (!cid || !cid.startsWith('dm:') || !cid.includes(me.id)) return cb && cb({ error: 'Игры только в личке' });
    const [, a, b] = cid.split(':'); const peer = a === me.id ? b : a;
    type = ['ttt', 'rps', 'c4', 'dice'].includes(type) ? type : 'ttt';
    const target = [1, 2, 3, 5].includes(Number(wins)) ? Number(wins) : 1;
    const msg = {
      id: uid(), chatId: cid, from: me.id, type: 'game', text: '', ts: Date.now(), readBy: [me.id],
      reactions: {}, deleted: false,
      media: { game: type, players: [me.id, peer], state: newGameState(type, [me.id, peer], target) },
    };
    db.messages.push(msg); save();
    emitToChat(cid, 'message', msg);
    cb && cb({ ok: true, id: msg.id });
  });

  function concludeRound(m, winnerId) {
    const g = m.media, s = g.state;
    s.roundWinner = winnerId; s.reveal = true;
    if (winnerId !== 'draw') s.scores[winnerId] = (s.scores[winnerId] || 0) + 1;
    if (s.scores[winnerId] >= s.target) s.matchWinner = winnerId;
    save();
    emitToChat(m.chatId, 'game_update', { id: m.id, media: g });
    if (!s.matchWinner) setTimeout(() => {
      const mm = db.messages.find((x) => x.id === m.id);
      if (!mm || mm.deleted) return;
      mm.media.state.round++;
      initRound(mm.media.state, mm.media.game, mm.media.players);
      save();
      emitToChat(mm.chatId, 'game_update', { id: mm.id, media: mm.media });
    }, 2400);
  }

  socket.on('game:move', ({ id, move }) => {
    const m = db.messages.find((x) => x.id === id);
    if (!m || m.type !== 'game' || m.deleted) return;
    const g = m.media; if (!g.players.includes(me.id)) return;
    const s = g.state;
    if (s.matchWinner || s.roundWinner) return; // раунд окончен/идёт авто-рестарт
    const peer = g.players.find((p) => p !== me.id);

    if (g.game === 'ttt') {
      if (s.turn !== me.id) return;
      const i = Number(move);
      if (!(i >= 0 && i < 9) || s.board[i]) return;
      s.board[i] = s.marks[me.id];
      if (tttWinner(s.board)) return concludeRound(m, me.id);
      if (s.board.every(Boolean)) return concludeRound(m, 'draw');
      s.turn = peer;
    } else if (g.game === 'c4') {
      if (s.turn !== me.id) return;
      const col = Number(move);
      if (!(col >= 0 && col < 7)) return;
      const idx = c4Drop(s.board, col); if (idx < 0) return;
      s.board[idx] = s.marks[me.id];
      if (c4Winner(s.board)) return concludeRound(m, me.id);
      if (s.board.every(Boolean)) return concludeRound(m, 'draw');
      s.turn = peer;
    } else if (g.game === 'rps') {
      if (!['rock', 'scissors', 'paper'].includes(move) || s.choices[me.id]) return;
      s.choices[me.id] = move;
      if (s.choices[g.players[0]] && s.choices[g.players[1]]) {
        const w = rpsWinner(s.choices[g.players[0]], s.choices[g.players[1]]);
        return concludeRound(m, w === 0 ? 'draw' : (w === 1 ? g.players[0] : g.players[1]));
      }
    } else if (g.game === 'dice') {
      if (s.rolls[me.id]) return;
      s.rolls[me.id] = 1 + Math.floor(Math.random() * 6);
      if (s.rolls[g.players[0]] && s.rolls[g.players[1]]) {
        const r0 = s.rolls[g.players[0]], r1 = s.rolls[g.players[1]];
        return concludeRound(m, r0 === r1 ? 'draw' : (r0 > r1 ? g.players[0] : g.players[1]));
      }
    }
    save();
    emitToChat(m.chatId, 'game_update', { id: m.id, media: g });
  });

  // ---- кастомный статус ----
  socket.on('setStatus', ({ text }) => {
    me.customStatus = sanitize(text, 40) || null;
    save();
    broadcastUserMeta(me, 'user_updated');
  });

  // ---- индикатор «стирает…» ----
  socket.on('erasing', ({ chatId }) => {
    if (chatId && chatId.startsWith('dm:') && chatId.split(':').length === 2) chatId = dmId(me.id, chatId.slice(3));
    if (!canSee(me, chatId)) return;
    if (chatId === EFIR) socket.to(EFIR).emit('erasing', { chatId: EFIR, userId: me.id, name: me.displayName });
    else if (chatId.startsWith('dm:')) { const [, a, b] = chatId.split(':'); const peer = a === me.id ? b : a; io.to(peer).emit('erasing', { chatId: 'dm:' + me.id, userId: me.id, name: me.displayName }); }
    else for (const u of roomTargets(chatId)) if (u !== me.id) io.to(u).emit('erasing', { chatId, userId: me.id, name: me.displayName });
  });

  // ---- голосование в опросе ----
  socket.on('vote', ({ id, option }) => {
    const m = db.messages.find((x) => x.id === id);
    if (!m || m.type !== 'poll' || m.deleted || !canSee(me, m.chatId)) return;
    const v = m.media.votes;
    for (const k of Object.keys(v)) v[k] = v[k].filter((u) => u !== me.id);
    if (v[option]) v[option].push(me.id); else v[option] = [me.id];
    save();
    emitToChat(m.chatId, 'voted', { id: m.id, votes: m.media.votes });
  });

  // ---- жалоба ----
  socket.on('report', ({ targetType, targetId, reason }) => {
    const rep = { id: uid(), by: me.id, byName: me.displayName, targetType: sanitize(targetType, 16), targetId: sanitize(targetId, 64), reason: sanitize(reason, 200), ts: Date.now(), status: 'open' };
    db.reports.push(rep); save();
    socket.emit('reported');
    // живое уведомление всем админам онлайн
    const target = rep.targetType === 'user' ? findUser(rep.targetId) : null;
    rep.targetName = target ? target.displayName : (rep.targetType === 'msg' ? 'сообщение' : rep.targetId);
    for (const u of db.users) if (isSuperAdmin(u)) io.to(u.id).emit('new_report', rep);
    // авто-флаг: 3+ разных жалобщика на одного юзера
    if (rep.targetType === 'user') {
      const reporters = new Set(db.reports.filter((r) => r.targetType === 'user' && r.targetId === rep.targetId && r.status === 'open').map((r) => r.by));
      if (reporters.size >= 3 && target && !target.flagged) { target.flagged = true; save(); }
    }
  });
  socket.on('reportMsg', ({ id, reason }) => {
    const m = db.messages.find((x) => x.id === id); if (!m) return;
    const author = findUser(m.from);
    const rep = { id: uid(), by: me.id, byName: me.displayName, targetType: 'msg', targetId: id, authorId: m.from, reason: sanitize(reason, 200), excerpt: (m.text || m.type).slice(0, 80), ts: Date.now(), status: 'open' };
    db.reports.push(rep); save();
    socket.emit('reported');
    rep.targetName = author ? author.displayName : '—';
    for (const u of db.users) if (isSuperAdmin(u)) io.to(u.id).emit('new_report', rep);
  });

  // ---- МОДЕРАЦИЯ (только админ) ----
  socket.on('getReports', (a, b) => {
    const cb = typeof a === 'function' ? a : b;
    if (!isSuperAdmin(me)) return cb && cb({ error: 'нет прав' });
    const reps = db.reports.slice().reverse().slice(0, 100).map((r) => {
      const t = r.targetType === 'user' ? findUser(r.targetId) : (r.authorId ? findUser(r.authorId) : null);
      return { ...r, targetName: t ? t.displayName : (r.targetName || '—'), targetBanned: t ? !!t.banned : false };
    });
    cb && cb({ ok: true, reports: reps, admin: true });
  });
  socket.on('banUser', ({ userId, on }, cb) => {
    if (!isSuperAdmin(me)) return cb && cb({ error: 'нет прав' });
    const u = findUser(userId); if (!u || isSuperAdmin(u)) return cb && cb({ error: 'нельзя' });
    u.banned = !!on; if (on) u.token = null; save();
    io.to(userId).emit('banned_notice', { banned: !!on });
    cb && cb({ ok: true, banned: u.banned });
  });
  socket.on('dismissReport', ({ id }, cb) => {
    if (!isSuperAdmin(me)) return cb && cb({ error: 'нет прав' });
    const r = db.reports.find((x) => x.id === id); if (r) r.status = 'closed'; save();
    cb && cb({ ok: true });
  });
  socket.on('deleteAnyMsg', ({ id }, cb) => {
    if (!isSuperAdmin(me)) return cb && cb({ error: 'нет прав' });
    const m = db.messages.find((x) => x.id === id); if (!m) return cb && cb({ error: 'нет' });
    m.deleted = true; m.text = ''; m.media = null; save();
    emitToChat(m.chatId, 'deleted', { id: m.id, chatId: m.chatId });
    cb && cb({ ok: true });
  });

  // ---- ЛЕНТА / СТЕНА (посты) ----
  socket.on('createPost', ({ text, photos }, cb) => {
    text = sanitize(text, 1000);
    const ph = Array.isArray(photos) ? photos.filter((u) => typeof u === 'string' && u.startsWith('/uploads/')).slice(0, 10) : [];
    if (!text && !ph.length) return cb && cb({ error: 'Пустой пост' });
    const sp = spamCheck(me.id, text); if (sp.blocked) return cb && cb({ error: sp.reason });
    const post = { id: uid(), author: me.id, text, photos: ph, likes: [], viewers: [], ts: Date.now() };
    db.posts.push(post); save();
    io.emit('new_post', publicPost(post, me.id));
    cb && cb({ ok: true, post: publicPost(post, me.id) });
  });
  socket.on('feed', ({ before }, cb) => {
    let posts = db.posts.slice();
    // не показываем посты заблокировавших меня и тех, кого я заблокировал
    posts = posts.filter((p) => { const a = findUser(p.author); return a && !a.blocked.includes(me.id) && !me.blocked.includes(p.author); });
    posts.sort((a, b) => b.ts - a.ts);
    if (before) posts = posts.filter((p) => p.ts < before);
    const page = posts.slice(0, 30);
    let changed = false;
    for (const p of page) if (countView(p, me.id)) changed = true;
    if (changed) save();
    cb && cb(page.map((p) => publicPost(p, me.id)));
  });
  socket.on('wall', ({ userId }, cb) => {
    const posts = db.posts.filter((p) => p.author === userId).sort((a, b) => b.ts - a.ts);
    let changed = false;
    for (const p of posts) if (countView(p, me.id)) changed = true;
    if (changed) save();
    cb && cb(posts.map((p) => publicPost(p, me.id)));
  });
  socket.on('likePost', ({ id }) => {
    const p = db.posts.find((x) => x.id === id); if (!p) return;
    if (p.likes.includes(me.id)) p.likes = p.likes.filter((u) => u !== me.id);
    else p.likes.push(me.id);
    save();
    io.emit('post_liked', { id, likes: p.likes.length, by: me.id, liked: p.likes.includes(me.id) });
  });
  socket.on('deletePost', ({ id }) => {
    const p = db.posts.find((x) => x.id === id); if (!p || p.author !== me.id) return;
    db.posts = db.posts.filter((x) => x.id !== id); save();
    io.emit('post_deleted', { id });
  });

  socket.on('disconnect', () => {
    const set = sockets.get(me.id);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        me.lastSeen = Date.now(); save(); recomputeOnline();
        if (!(me.settings && me.settings.hideOnline))
          broadcastPresence(me, { userId: me.id, online: false, lastSeen: (me.privacy && me.privacy.ghost) ? null : me.lastSeen });
      }
    }
  });
});

function publicChat(c) {
  return {
    id: c.id, type: c.type, title: c.title, description: c.description || '',
    avatar: c.avatar, owner: c.owner, admins: c.admins,
    members: c.members.map((id) => { const u = findUser(id); return u ? publicUser(u) : null; }).filter(Boolean),
    subscribers: (c.subscribers || []).map((id) => { const u = findUser(id); return u ? publicUser(u) : null; }).filter(Boolean),
    membersCount: c.members.length + (c.subscribers ? c.subscribers.length : 0),
  };
}
function broadcastChat(c) {
  for (const u of roomTargets(c.id)) io.to(u).emit('chat_info', publicChat(c));
}
function publicPost(p, viewerId) {
  const a = findUser(p.author);
  return {
    id: p.id, text: p.text, photos: p.photos || [], ts: p.ts,
    author: a ? { id: a.id, name: a.displayName, username: a.username, avatar: a.avatar || null, colors: a.colors } : null,
    likes: p.likes.length, liked: p.likes.includes(viewerId),
    views: (p.viewers || []).length,
  };
}
// засчитать просмотр поста зрителем (не автором), вернуть true если новый
function countView(p, viewerId) {
  if (!p.viewers) p.viewers = [];
  if (viewerId === p.author || p.viewers.includes(viewerId)) return false;
  p.viewers.push(viewerId); return true;
}
function pushSystem(chatId, text) {
  const msg = { id: uid(), chatId, from: null, type: 'system', text, ts: Date.now(), readBy: [], reactions: {} };
  db.messages.push(msg); save();
  emitToChat(chatId, 'message', msg);
}

function doSend(me, p) {
  if (me.banned) return { error: 'Аккаунт заблокирован за нарушение правил' };
  const type = ['text', 'image', 'voice', 'file', 'geo', 'circle', 'video', 'album', 'poll', 'e2e'].includes(p.type) ? p.type : 'text';
  // для e2e текст пуст — содержимое лежит зашифрованным в media.enc, сервер его не видит
  let text = type === 'e2e' ? '' : sanitize(p.text, 4000);

  // разбор медиа по типу
  let media = null;
  if (type === 'e2e') {
    // Непрозрачный для сервера шифрблок. Пересобираем из известных полей и жёстко ограничиваем размеры.
    const e = p.media && p.media.enc;
    if (e && typeof e === 'object') {
      const clean = {
        v: 1, ephPub: sanitize(e.ephPub, 300), iv: sanitize(e.iv, 64),
        ct: typeof e.ct === 'string' ? e.ct.slice(0, 262144) : null,           // текст: шифр здесь
        url: (typeof e.url === 'string' && e.url.startsWith('/uploads/')) ? e.url : null, // медиа: шифр в файле
        mediaType: e.mediaType ? sanitize(e.mediaType, 16) : null,
        name: e.name ? sanitize(e.name, 120) : null, size: Number(e.size) || 0,
        dur: Math.max(0, Math.min(900, Number(e.dur) || 0)), keys: {},
      };
      if (e.keys && typeof e.keys === 'object') {
        for (const [uid2, k] of Object.entries(e.keys).slice(0, 50))
          if (k && typeof k === 'object') clean.keys[sanitize(uid2, 32)] = { iv: sanitize(k.iv, 64), wk: sanitize(k.wk, 4096) };
      }
      if (clean.ephPub && clean.iv && Object.keys(clean.keys).length && (clean.ct || clean.url)) media = { enc: clean };
    }
  } else if (type === 'album') {
    const urls = Array.isArray(p.media && p.media.urls)
      ? p.media.urls.filter((u) => typeof u === 'string' && u.startsWith('/uploads/')).slice(0, 10) : [];
    if (urls.length) media = { urls };
  } else if (type === 'poll') {
    const q = sanitize(p.media && p.media.question, 200);
    const opts = Array.isArray(p.media && p.media.options)
      ? p.media.options.map((o) => sanitize(o, 100)).filter(Boolean).slice(0, 10) : [];
    if (q && opts.length >= 2) media = { question: q, options: opts, votes: {} };
  } else if (p.media && typeof p.media === 'object') {
    if (typeof p.media.url === 'string' && p.media.url.startsWith('/uploads/')) {
      media = { url: p.media.url, dur: Math.max(0, Math.min(900, Number(p.media.dur) || 0)),
        name: sanitize(p.media.name, 120) || null, size: Number(p.media.size) || 0, mime: sanitize(p.media.mime, 80) || null };
    } else if (type === 'geo' && p.media.lat != null && p.media.lng != null) {
      media = { lat: Number(p.media.lat), lng: Number(p.media.lng), label: sanitize(p.media.label, 80) || null };
    }
  }

  // валидация
  if (type === 'text' && !text) return { error: 'empty' };
  if (['image', 'voice', 'file', 'circle', 'video'].includes(type) && (!media || !media.url)) return { error: 'no media' };
  if (type === 'album' && (!media || !media.urls.length)) return { error: 'no media' };
  if (type === 'poll' && !media) return { error: 'Опрос: вопрос + минимум 2 варианта' };
  if (type === 'geo' && (!media || media.lat == null)) return { error: 'no geo' };
  if (type === 'e2e' && (!media || !media.enc)) return { error: 'bad enc' };

  // антиспам (частота + повторы + реклама)
  const sp = spamCheck(me.id, text);
  if (sp.blocked) return { error: sp.reason };

  // нормализация chatId
  let chatId = p.chatId;
  if (chatId && chatId.startsWith('dm:')) {
    const peerId = chatId.slice(3);
    if (findUser(peerId)) chatId = dmId(me.id, peerId);
  } else if (chatId && chatId.startsWith('peer:')) {
    const peerId = chatId.slice(5);
    if (findUser(peerId)) chatId = dmId(me.id, peerId);
  }
  if (!canSend(me, chatId)) return { error: 'no access' };
  // сквозное шифрование — только в личке 1-на-1 (для групп нужен другой протокол)
  if (type === 'e2e' && !chatId.startsWith('dm:')) return { error: 'Секретные сообщения — только в личке' };

  // приватность: закрытый профиль — чужой не пишет первым
  if (chatId.startsWith('dm:')) {
    const [, a, b] = chatId.split(':'); const peerId = a === me.id ? b : a;
    const peer = findUser(peerId);
    if (peer && peer.privacy && peer.privacy.closed) {
      const known = peer.contacts.includes(me.id) ||
        db.messages.some((m) => m.chatId === chatId && m.from === peerId);
      if (peer.blocked.includes(me.id)) return { error: 'Вы заблокированы' };
      if (!known) return { error: 'Профиль закрыт — этот человек не принимает сообщения от незнакомых' };
    }
    if (peer && peer.blocked.includes(me.id)) return { error: 'Вы заблокированы' };
    // взаимные контакты
    if (!me.contacts.includes(peerId)) { me.contacts.push(peerId); }
  }

  const reply = p.replyTo ? db.messages.find((m) => m.id === p.replyTo && m.chatId === chatId && !m.deleted) : null;
  const fwd = (p.forward && typeof p.forward === 'object') ? {
    fromName: sanitize(p.forward.fromName, 48), fromId: sanitize(p.forward.fromId, 32) || null,
  } : null;

  const msg = {
    id: uid(), chatId, from: me.id, type, text, media, ts: Date.now(), readBy: [me.id],
    reactions: {}, edited: false, deleted: false, pinned: false,
    replyTo: reply ? { id: reply.id, from: reply.from, type: reply.type, text: reply.text,
      name: reply.from ? (findUser(reply.from) || {}).displayName : '' } : null,
    forward: fwd,
    ttl: p.ttl ? Math.max(1, Math.min(86400, Number(p.ttl))) : null,
  };

  // отложенная отправка
  const at = Number(p.scheduledFor) || 0;
  if (at > Date.now() + 1000) {
    msg.scheduledFor = at;
    db.scheduled.push(msg); save();
    return { scheduled: true, at, id: msg.id };
  }

  db.messages.push(msg); save();
  emitToChat(chatId, 'message', msg);

  // самоуничтожение
  if (msg.ttl) scheduleBurn(msg);
  // ответ ИИ-ассистента Алисы — НЕ для e2e (сервер не видит текст и не должен «читать» секретные чаты)
  if (type !== 'e2e') maybeAlisaReply(msg).catch((e) => console.error('alisa:', e.message));
  // push-уведомления офлайн-получателям
  notifyOffline(msg, me).catch(() => {});
  return { ok: true, msg };
}

function scheduleBurn(msg) {
  setTimeout(() => {
    const m = db.messages.find((x) => x.id === msg.id);
    if (m && !m.deleted) { m.deleted = true; m.text = ''; m.media = null; save(); emitToChat(m.chatId, 'deleted', { id: m.id, chatId: m.chatId }); }
  }, msg.ttl * 1000);
}

// доставка отложенных
setInterval(() => {
  const now = Date.now();
  const due = db.scheduled.filter((m) => m.scheduledFor <= now);
  if (!due.length) return;
  db.scheduled = db.scheduled.filter((m) => m.scheduledFor > now);
  for (const m of due) {
    delete m.scheduledFor;
    db.messages.push(m);
    emitToChat(m.chatId, 'message', m);
    if (m.ttl) scheduleBurn(m);
  }
  save();
}, 4000);

// перезапуск таймеров самоуничтожения после рестарта (приблизительно)
for (const m of db.messages) if (m.ttl && !m.deleted) {
  const age = (Date.now() - m.ts) / 1000;
  if (age >= m.ttl) { m.deleted = true; m.text = ''; m.media = null; }
}

server.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces(); const ips = [];
  for (const name of Object.keys(nets)) for (const net of nets[name])
    if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
  console.log('\n  ⬡ ВЕЧЕ ⬡  собрание, которое не разогнать.\n');
  console.log(`  На этом компе:      http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  С телефона (Wi-Fi): http://${ip}:${PORT}`);
  console.log('');
});
