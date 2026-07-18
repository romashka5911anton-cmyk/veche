// ВЕЧЕ — клиент 2.0. собрание, которое не разогнать.
(() => {
  const $ = (id) => document.getElementById(id);
  const EFIR = 'efir';
  const TOKEN_KEY = 'veche_token';
  const FREQ_KEY = 'veche_emoji_freq';
  const THEME_KEY = 'veche_theme';

  // состояние
  let socket = null, token = null, me = null;
  let users = new Map();        // userId -> publicUser
  let chats = new Map();        // chatId -> meta
  let chatInfos = new Map();    // chatId -> publicChat (группы/каналы)
  let activeChat = null;        // реальный chatId
  let activeInfo = null;        // publicChat активного группового
  let typingTimers = new Map();
  let searchQuery = '';
  let replyTarget = null, editTarget = null, forwardMsg = null;
  let pinnedMsg = null;
  let iceConfig = [{ urls: 'stun:stun.l.google.com:19302' }];
  let routeChat = null;
  // секретные (E2E) чаты — множество peerId, для которых включено сквозное шифрование (хранится локально)
  const SECRET_KEY = 'veche_secret_peers';
  let secretPeers = new Set();
  try { secretPeers = new Set(JSON.parse(localStorage.getItem(SECRET_KEY) || '[]')); } catch {}
  try {
    const params = new URLSearchParams(location.search);
    routeChat = params.get('chat');
    if (routeChat) history.replaceState(null, '', location.pathname);
  } catch {}

  // ---------- утилиты ----------
  function setTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'light' ? '#eef5ff' : '#06080e');
  }

  setTheme(localStorage.getItem(THEME_KEY) || 'dark');

  // Liquid Glass chrome for the main messenger surface.
  ['sidebar', 'chat-pane', 'chat-header', 'chat-view', 'composer', 'reply-bar', 'pinned-bar', 'messages', 'chat-list']
    .forEach((id) => { const el = $(id); if (el) el.classList.add('liquid-glass'); });

  const dmWith = (peerId) => 'dm:' + [me.id, peerId].sort().join(':');
  const peerIdOf = (chatId) => { const [, a, b] = chatId.split(':'); return a === me.id ? b : a; };
  const isDM = (id) => id && id.startsWith('dm:');
  const isGroupOrChannel = (id) => id && (id.startsWith('grp:') || id.startsWith('chn:'));
  const isSecret = (chatId) => isDM(chatId) && secretPeers.has(peerIdOf(chatId));
  function setSecret(peerId, on) {
    if (on) secretPeers.add(peerId); else secretPeers.delete(peerId);
    localStorage.setItem(SECRET_KEY, JSON.stringify([...secretPeers]));
  }
  // Инициализация ключей E2E: создаём/загружаем пару и публикуем ПУБЛИЧНЫЙ ключ (приватный не уходит с устройства)
  async function initCrypto() {
    try {
      if (!window.VecheCrypto || !VecheCrypto.available()) return;
      VecheCrypto.setMyId(me.id);
      const pub = await VecheCrypto.ensureIdentity();
      if (me.pubKey !== pub) {
        await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ pubKey: pub }) });
        me.pubKey = pub;
      }
    } catch (e) { console.warn('e2e init:', e); }
  }

  function initials(name) {
    const p = String(name || '?').trim().split(/[\s_]+/).filter(Boolean);
    return (p.length >= 2 ? p[0][0] + p[1][0] : String(name || '?').slice(0, 2)).toUpperCase();
  }
  function paintAvatar(el, { avatar, name, colors }, fontSize, icon) {
    el.textContent = ''; el.style.backgroundImage = '';
    if (avatar) { el.style.background = `center/cover no-repeat url("${avatar}")`; }
    else {
      const c = colors || ['#7a5cff', '#00d4ff'];
      el.style.background = `linear-gradient(135deg, ${c[0]}, ${c[1]})`;
      el.textContent = icon || initials(name);
    }
    if (fontSize) el.style.fontSize = fontSize + 'px';
  }
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  function fmtDay(ts) {
    const d = new Date(ts), n = new Date();
    const t0 = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const d0 = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = (t0 - d0) / 86400000;
    if (diff === 0) return 'Сегодня'; if (diff === 1) return 'Вчера';
    return d.toLocaleDateString('ru', { day: 'numeric', month: 'long' });
  }
  function fmtLastSeen(ts) {
    if (!ts) return 'не в сети';
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'был(а) только что'; if (m < 60) return `был(а) ${m} мин назад`;
    if (m < 1440) return `был(а) в ${fmtTime(ts)}`;
    return 'был(а) ' + new Date(ts).toLocaleDateString('ru', { day: 'numeric', month: 'short' });
  }
  const fmtDur = (s) => { s = Math.round(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const fmtSize = (b) => b < 1024 ? b + ' Б' : b < 1048576 ? (b / 1024).toFixed(0) + ' КБ' : (b / 1048576).toFixed(1) + ' МБ';
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2600);
  }
  function previewText(m) {
    if (!m) return '';
    if (m.deleted) return '🚫 удалено';
    if (m.type === 'image') return '🖼 Фото'; if (m.type === 'voice') return '🎤 Голосовое';
    if (m.type === 'file') return '📎 ' + (m.media && m.media.name || 'Файл');
    if (m.type === 'geo') return '📍 Геолокация'; if (m.type === 'circle') return '⭕ Кружок';
    if (m.type === 'video') return '🎬 Видео'; if (m.type === 'system') return m.text;
    if (m.type === 'album') return '🖼 Альбом';
    if (m.type === 'poll') return '📊 ' + ((m.media && m.media.question) || 'Опрос');
    if (m.type === 'game') return '🎮 Игра';
    if (m.type === 'e2e') return '🔒 ' + (m._dec != null ? m._dec : 'Секретное сообщение');
    return m.text;
  }
  function searchableText(m) {
    if (!m) return '';
    const parts = [m.text, previewText(m)];
    if (m.media) parts.push(m.media.name, m.media.question, ...(m.media.options || []));
    return parts.filter(Boolean).join(' ').toLowerCase();
  }
  const URL_RE = /\bhttps?:\/\/[^\s<>"']{4,}/i;
  const linkPreviewCache = new Map();
  function firstUrl(text) {
    const m = String(text || '').match(URL_RE);
    if (!m) return null;
    return m[0].replace(/[)\].,!?:;]+$/g, '');
  }
  async function loadLinkPreview(url) {
    if (linkPreviewCache.has(url)) return linkPreviewCache.get(url);
    const p = fetch('/api/link-preview?url=' + encodeURIComponent(url), {
      headers: { 'Authorization': 'Bearer ' + token },
    }).then((r) => r.ok ? r.json() : null).catch(() => null);
    linkPreviewCache.set(url, p);
    return p;
  }
  function maybeAttachLinkPreview(bubble, text) {
    const url = firstUrl(text);
    if (!url || bubble.querySelector('.link-preview')) return;
    const card = document.createElement('a');
    card.className = 'link-preview loading';
    card.href = url; card.target = '_blank'; card.rel = 'noopener';
    card.innerHTML = '<div class="lp-body"><div class="lp-host">Загрузка ссылки…</div><div class="lp-title"></div><div class="lp-desc"></div></div>';
    bubble.appendChild(card);
    loadLinkPreview(url).then((data) => {
      if (!card.isConnected) return;
      if (!data || (!data.title && !data.description)) { card.remove(); return; }
      card.classList.remove('loading');
      card.innerHTML = `${data.image ? `<img class="lp-img" src="${escapeHtml(data.image)}" alt="">` : ''}
        <div class="lp-body">
          <div class="lp-host">${escapeHtml(data.siteName || data.host || 'ссылка')}</div>
          <div class="lp-title">${escapeHtml(data.title || data.url || url)}</div>
          <div class="lp-desc">${escapeHtml(data.description || '')}</div>
        </div>`;
    });
  }

  // ============ АВТОРИЗАЦИЯ ============
  const authScreen = $('auth-screen'), appScreen = $('app-screen');
  let authMode = 'login';
  $('tab-login').onclick = () => setAuthMode('login');
  $('tab-register').onclick = () => setAuthMode('register');
  function setAuthMode(m) {
    authMode = m;
    $('tab-login').classList.toggle('active', m === 'login');
    $('tab-register').classList.toggle('active', m === 'register');
    $('auth-submit').textContent = m === 'login' ? 'Войти' : 'Создать аккаунт';
    $('auth-error').textContent = '';
  }
  $('auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const username = $('auth-username').value.trim(), password = $('auth-password').value;
    if (!username || !password) return;
    $('auth-submit').disabled = true; $('auth-error').textContent = '';
    try {
      const res = await fetch('/api/' + (authMode === 'login' ? 'login' : 'register'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Ошибка');
      localStorage.setItem(TOKEN_KEY, data.token); connect(data.token);
    } catch (err) { $('auth-error').textContent = err.message; }
    finally { $('auth-submit').disabled = false; }
  };

  // ============ ПОДКЛЮЧЕНИЕ ============
  function connect(tok) {
    token = tok;
    socket = io({ auth: { token: tok } });
    socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') {
        localStorage.removeItem(TOKEN_KEY); socket.disconnect();
        authScreen.classList.remove('hidden'); appScreen.classList.add('hidden');
      }
    });
    // Показываем скелетон пока ждём init
    socket.on('connect', () => {
      appScreen.classList.remove('hidden'); authScreen.classList.add('hidden');
      renderSkeletonList();
    });
    socket.on('init', (data) => {
      me = data.me;
      users = new Map(data.users.map((u) => [u.id, u]));
      users.set(me.id, { ...me, name: me.name });
      chats = new Map(); for (const c of data.chats) chats.set(c.chatId, c);
      if (data.iceServers && data.iceServers.length) iceConfig = data.iceServers;
      $('btn-admin').classList.toggle('hidden', !me.admin);
      authScreen.classList.add('hidden'); appScreen.classList.remove('hidden');
      paintAvatar($('me-avatar'), { avatar: me.avatar, name: me.name, colors: me.colors });
      renderChatList();
      if (routeChat) { const cid = routeChat; routeChat = null; openChat(cid); }
      else if (activeChat) openChat(activeChat, true);
      syncPushToggle();
      ensurePushSubscription(true);
      checkPendingCall();
      initCrypto();
    });
    socket.on('user_joined', (u) => { if (u.id !== me.id) { users.set(u.id, u); renderChatList(); } });
    socket.on('user_updated', (u) => {
      users.set(u.id, u);
      if (u.id === me.id) { Object.assign(me, u); paintAvatar($('me-avatar'), { avatar: me.avatar, name: me.name, colors: me.colors }); }
      renderChatList();
      if (activeChat && isDM(activeChat) && peerIdOf(activeChat) === u.id) { paintHeader(activeChat); renderChatStatus(); }
    });
    socket.on('presence', ({ userId, online, lastSeen }) => {
      const u = users.get(userId); if (!u) return;
      u.online = online; if (lastSeen) u.lastSeen = lastSeen;
      renderChatList();
      if (activeChat && isDM(activeChat) && peerIdOf(activeChat) === userId) renderChatStatus();
    });
    socket.on('message', (m) => {
      const c = chats.get(m.chatId) || metaFromMessage(m);
      c.last = m;
      const focused = m.chatId === activeChat && document.hasFocus();
      if (m.from !== me.id && m.from !== null && !focused) c.unread = (c.unread || 0) + 1;
      chats.set(m.chatId, c); renderChatList();
      if (m.chatId === activeChat) {
        appendMessage(m); scrollToBottom();
        if (m.from !== me.id && document.hasFocus()) socket.emit('read', { chatId: activeChat });
      }
      if (m.from !== me.id && m.from !== null && !c.muted && !(me.muted || []).includes(m.chatId)) {
        if (!focused) beep();
        buzz(focused ? 12 : [22, 30, 22]); // лёгкая вибрация при получении сообщения
      }
    });
    socket.on('edited', ({ id, text }) => {
      const el = document.querySelector(`.msg-row[data-id="${id}"] .msg-text`);
      if (el) { el.textContent = text; const b = el.closest('.bubble'); if (b && !b.querySelector('.edited-mark')) { const e = document.createElement('span'); e.className = 'edited-mark'; e.style.cssText = 'font-size:11px;opacity:.6;margin-left:4px'; e.textContent = '(ред.)'; el.after(e); } }
      const c = chats.get(activeChat); if (c && c.last && c.last.id === id) { c.last.text = text; renderChatList(); }
    });
    socket.on('deleted', ({ id, chatId }) => {
      const row = document.querySelector(`.msg-row[data-id="${id}"]`);
      if (row && chatId === activeChat) row.remove();
      const c = chats.get(chatId); if (c && c.last && c.last.id === id) { c.last = null; renderChatList(); }
      if (pinnedMsg && pinnedMsg.id === id) { pinnedMsg = null; renderPinned(); }
    });
    socket.on('reacted', ({ id, reactions }) => {
      const m = currentMsgs.get(id); if (m) m.reactions = reactions;
      const row = document.querySelector(`.msg-row[data-id="${id}"]`);
      if (row) renderReactions(row, id, reactions);
    });
    socket.on('voted', ({ id, votes }) => {
      const m = currentMsgs.get(id); if (!m) return; m.media.votes = votes;
      const row = document.querySelector(`.msg-row[data-id="${id}"] .poll`);
      if (row) { const nb = buildPoll(m); row.replaceWith(nb); }
    });
    socket.on('erasing', ({ chatId, name }) => {
      const key = isDM(chatId) ? dmWith(chatId.slice(3)) : chatId;
      typingTimers.set(key, { name, until: Date.now() + 2000, erasing: true });
      if (key === activeChat) renderChatStatus();
      setTimeout(() => { if (key === activeChat) renderChatStatus(); }, 2100);
    });
    socket.on('new_post', (post) => { if (feedOpen) prependPost(post); });
    socket.on('post_liked', ({ id, likes, liked, by }) => updatePostLikes(id, likes, liked, by));
    socket.on('post_deleted', ({ id }) => { document.querySelectorAll(`.post[data-id="${id}"]`).forEach((e) => e.remove()); });
    socket.on('game_update', ({ id, media }) => { const m = currentMsgs.get(id); if (m) m.media = media; const row = document.querySelector(`.msg-row[data-id="${id}"] .game`); if (row && m) row.replaceWith(buildGame(m)); });
    // звонки
    socket.on('call:incoming', onCallIncoming);
    socket.on('call:answered', onCallAnswered);
    socket.on('call:ice', onCallIce);
    socket.on('call:declined', () => endCall('Отклонён'));
    socket.on('call:ended', () => endCall('Звонок завершён'));
    socket.on('call:canceled', () => endCall('Отменён'));
    socket.on('new_report', (r) => { if (me.admin) { toast('🛡 Новая жалоба на ' + (r.targetName || '—')); buzz([40, 60, 40]); if (!$('admin-modal').classList.contains('hidden')) openAdmin(); } });
    socket.on('banned_notice', ({ banned }) => { if (banned) { alert('Ваш аккаунт заблокирован за нарушение правил.'); localStorage.removeItem(TOKEN_KEY); location.reload(); } });
    socket.on('pinned', ({ id, chatId }) => {
      if (chatId !== activeChat) return;
      pinnedMsg = id ? currentMsgs.get(id) : null; renderPinned();
    });
    socket.on('read', ({ chatId }) => {
      if (chatId === activeChat)
        document.querySelectorAll('#messages .ticks').forEach((el) => { el.classList.add('read'); el.textContent = '✓✓'; });
    });
    socket.on('typing', ({ chatId, name }) => {
      const key = isDM(chatId) ? dmWith(chatId.slice(3)) : chatId;
      typingTimers.set(key, { name, until: Date.now() + 2500 });
      if (key === activeChat) renderChatStatus();
      setTimeout(() => { if (key === activeChat) renderChatStatus(); }, 2600);
    });
    socket.on('muted', ({ chatId, on }) => {
      if (on) { if (!(me.muted || []).includes(chatId)) me.muted.push(chatId); }
      else me.muted = (me.muted || []).filter((c) => c !== chatId);
      const c = chats.get(chatId); if (c) c.muted = on;
      renderChatList(); if (chatId === activeChat) updateMuteBtn();
    });
    socket.on('chat_created', (meta) => { chats.set(meta.chatId, meta); renderChatList(); });
    socket.on('chat_info', (info) => {
      chatInfos.set(info.id, info);
      if (info.id === activeChat) { activeInfo = info; paintHeader(activeChat); renderChatStatus(); if (!$('chatinfo-modal').classList.contains('hidden')) renderChatInfo(info); }
    });
    socket.on('chat_removed', ({ chatId }) => {
      chats.delete(chatId); chatInfos.delete(chatId);
      if (activeChat === chatId) backToList();
      renderChatList();
    });
  }
  function metaFromMessage(m) {
    if (isDM(m.chatId)) return { chatId: m.chatId, kind: 'dm', peerId: peerIdOf(m.chatId), last: m, unread: 0 };
    return { chatId: m.chatId, kind: m.chatId.startsWith('chn:') ? 'channel' : 'group', last: m, unread: 0 };
  }

  // ============ СПИСОК ЧАТОВ ============
  function chatDisplay(c) {
    if (c.chatId === EFIR) return { title: 'Эфир', icon: '📡', colors: ['#7a5cff', '#00d4ff'], online: false, kind: 'efir' };
    if (c.kind === 'dm') {
      const p = users.get(c.peerId) || {};
      return { title: p.name || '…', avatar: p.avatar, colors: p.colors, online: p.online, kind: 'dm', peer: p };
    }
    const icon = c.kind === 'channel' ? '📣' : '👥';
    return { title: c.title || '…', avatar: c.avatar, icon, colors: ['#5b48e0', '#3e7bfa'], kind: c.kind };
  }
  function renderSkeletonList() {
    const list = $('chat-list'); list.innerHTML = '';
    const box = document.createElement('div'); box.className = 'skeleton-list';
    for (let i = 0; i < 6; i++) {
      const delay = (i * 0.08).toFixed(2) + 's';
      box.innerHTML += `<div class="skeleton-item">
        <div class="sk-av" style="animation-delay:${delay}"></div>
        <div class="sk-body">
          <div class="sk-line ${i % 3 === 0 ? 'w80' : i % 3 === 1 ? 'w65' : 'w80'}" style="animation-delay:${delay}"></div>
          <div class="sk-line ${i % 2 === 0 ? 'w55' : 'w40'}" style="animation-delay:${delay}"></div>
        </div>
      </div>`;
    }
    list.appendChild(box);
  }

  function renderChatList() {
    const list = $('chat-list'); list.innerHTML = '';
    const q = searchQuery.toLowerCase().replace(/^@/, '');
    const arr = [...chats.values()].sort((a, b) => {
      const ta = a.last ? a.last.ts : 0, tb = b.last ? b.last.ts : 0;
      return tb - ta || (a.chatId === EFIR ? -1 : 1);
    });
    const shown = new Set();
    const hideEfir = me.settings && me.settings.hideEfir;
    for (const c of arr) {
      if (c.chatId === EFIR && hideEfir && !q) continue;
      const d = chatDisplay(c);
      const uname = d.peer ? d.peer.username : '';
      if (q && !d.title.toLowerCase().includes(q) && !(uname && uname.includes(q))) continue;
      list.appendChild(chatItemEl(c, d)); shown.add(c.chatId);
    }
    if (q) {
      const found = [...users.values()].filter((u) => u.id !== me.id && !shown.has(dmWith(u.id)))
        .filter((u) => u.name.toLowerCase().includes(q) || u.username.includes(q))
        .sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name, 'ru'));
      if (found.length) {
        const s = document.createElement('div'); s.className = 'list-section'; s.textContent = 'Люди'; list.appendChild(s);
        for (const u of found) {
          const c = { chatId: dmWith(u.id), kind: 'dm', peerId: u.id, last: null, unread: 0 };
          list.appendChild(chatItemEl(c, chatDisplay(c)));
        }
      }
      if (!shown.size && !found.length) { const e = document.createElement('div'); e.className = 'list-section'; e.textContent = 'Никого не нашлось'; list.appendChild(e); }
    }
  }
  function chatItemEl(c, d) {
    const el = document.createElement('div');
    el.className = 'chat-item liquid-glass chat-card' + (c.chatId === activeChat ? ' active' : '');
    const av = document.createElement('div'); av.className = 'chat-avatar';
    paintAvatar(av, { avatar: d.avatar, name: d.title, colors: d.colors }, d.icon ? 22 : null, d.icon);
    if (d.online) { const dot = document.createElement('div'); dot.className = 'online-dot'; av.appendChild(dot); }
    let preview = '', time = '';
    if (c.last) {
      const m = c.last;
      const who = m.from === me.id ? '<span class="from-me">Ты: </span>'
        : ((c.kind === 'group' || c.chatId === EFIR) && m.from && users.get(m.from) ? escapeHtml(users.get(m.from).name) + ': ' : '');
      preview = (m.type === 'system' ? '' : who) + escapeHtml(previewText(m));
      time = fmtTime(m.ts);
    } else preview = c.chatId === EFIR ? 'Общий канал — все свои' : (d.kind === 'channel' ? 'Канал' : d.kind === 'group' ? 'Группа' : '@' + (d.peer ? d.peer.username : ''));
    const muted = c.muted || (me.muted || []).includes(c.chatId);
    const kindIcon = d.kind === 'channel' ? '<span class="chat-kind-icon">📣</span>' : d.kind === 'group' ? '<span class="chat-kind-icon">👥</span>' : '';
    el.appendChild(av);
    const body = document.createElement('div'); body.className = 'chat-item-body';
    body.innerHTML = `
      <div class="chat-item-top">
        <div class="chat-item-name">${kindIcon}${escapeHtml(d.title)}</div>
        <div class="chat-item-time">${time}</div>
      </div>
      <div class="chat-item-bottom">
        <div class="chat-item-preview">${preview}</div>
        <div class="chat-item-badges">
          ${muted ? '<span class="muted-icon">🔕</span>' : ''}
          ${c.unread ? `<div class="unread-badge${muted ? ' muted' : ''}">${c.unread > 99 ? '99+' : c.unread}</div>` : ''}
        </div>
      </div>`;
    el.appendChild(body);
    el.onclick = () => openChat(c.chatId);
    return el;
  }

  // ============ ОТКРЫТИЕ ЧАТА ============
  let currentMsgs = new Map();
  function paintHeader(chatId) {
    const av = $('chat-avatar'), c = chats.get(chatId) || metaFromMessage({ chatId, ts: 0 });
    const d = chatDisplay(c);
    $('chat-header').classList.add('chat-shell');
    paintAvatar(av, { avatar: d.avatar, name: d.title, colors: d.colors }, d.icon ? 18 : null, d.icon);
    $('chat-title').textContent = d.title;
  }
  function openChat(chatId, keep) {
    activeChat = chatId;
    activeInfo = chatInfos.get(chatId) || null;
    document.body.classList.add('chat-open');
    $('chat-pane').classList.add('chat-shell');
    $('chat-empty').classList.add('hidden'); $('chat-view').classList.remove('hidden');
    closeEmoji(); closeAttach(); clearReply();
    paintHeader(chatId); updateMuteBtn();
    const box = $('messages'); box.innerHTML = ''; lastRenderedDay = ''; currentMsgs = new Map(); pinnedMsg = null; renderPinned();
    socket.emit('history', { chatId }, (resp) => {
      if (!resp || resp.error) { renderChatStatus(); return; }
      if (resp.chat) { activeInfo = resp.chat; chatInfos.set(chatId, resp.chat); }
      for (const m of resp.msgs) { currentMsgs.set(m.id, m); appendMessage(m, true); if (m.pinned && !m.deleted) pinnedMsg = m; }
      renderPinned(); renderChatStatus(); scrollToBottom(true);
    });
    const c = chats.get(chatId);
    if (c && c.unread) { c.unread = 0; socket.emit('read', { chatId }); }
    // звонок — только в личке (и не с ботом)
    const peer = isDM(chatId) ? users.get(peerIdOf(chatId)) : null;
    $('btn-call').style.display = (isDM(chatId) && peer && !peer.bot) ? '' : 'none';
    // секретный чат — только в личке с человеком и при поддержке шифрования браузером
    const canSecret = isDM(chatId) && peer && !peer.bot && window.VecheCrypto && VecheCrypto.available();
    $('btn-secret').style.display = canSecret ? '' : 'none';
    $('btn-secret').textContent = isSecret(chatId) ? '🔒' : '🔓';
    updateComposerSecret();
    renderChatList();
    if (!keep && window.innerWidth > 760) $('msg-input').focus();
  }
  function renderChatStatus() {
    const st = $('chat-status'); const t = typingTimers.get(activeChat);
    if (t && t.until > Date.now()) { st.className = 'typing'; const verb = t.erasing ? 'стирает…' : 'печатает…'; st.textContent = isDM(activeChat) ? verb : t.name + ' ' + verb; return; }
    if (activeChat === EFIR) { st.className = ''; st.textContent = `в эфире: ${[...users.values()].filter((u) => u.online).length}`; }
    else if (isDM(activeChat)) {
      const p = users.get(peerIdOf(activeChat)) || {};
      if (p.customStatus) { st.className = 'online'; st.textContent = p.customStatus; }
      else if (p.online) { st.className = 'online'; st.textContent = 'в сети'; } else { st.className = ''; st.textContent = fmtLastSeen(p.lastSeen); }
    } else {
      const info = activeInfo; st.className = '';
      st.textContent = info ? `${info.membersCount} участник(ов)` : (activeChat.startsWith('chn:') ? 'канал' : 'группа');
    }
  }
  $('btn-back').onclick = backToList;
  function backToList() {
    document.body.classList.remove('chat-open'); activeChat = null;
    $('chat-view').classList.add('hidden'); $('chat-empty').classList.remove('hidden'); renderChatList();
  }
  function chatHeaderAction() {
    if (isDM(activeChat)) openProfile(users.get(peerIdOf(activeChat)));
    else if (isGroupOrChannel(activeChat)) openChatInfo();
    else if (activeChat === EFIR) { if (confirm('Скрыть «Эфир» из списка чатов? Вернуть можно в настройках.')) { patchProfile({ settings: { hideEfir: true } }).then(() => { renderChatList(); backToList(); toast('Эфир скрыт. Вернуть — в ⚙ Настройки'); }); } }
  }
  $('btn-chat-menu').onclick = chatHeaderAction;
  $('chat-header-info').onclick = $('chat-avatar').onclick = chatHeaderAction;

  // мут
  function updateMuteBtn() { const m = (me.muted || []).includes(activeChat) || (chats.get(activeChat) || {}).muted; $('btn-mute').textContent = m ? '🔕' : '🔔'; }
  $('btn-mute').onclick = (e) => { e.stopPropagation(); const on = !((me.muted || []).includes(activeChat)); socket.emit('mute', { chatId: activeChat, on }); };

  // ---- секретный (E2E) чат ----
  $('btn-secret').onclick = (e) => { e.stopPropagation(); openSecretModal(); };
  function openSecretModal() {
    if (!isDM(activeChat)) return;
    const peer = users.get(peerIdOf(activeChat));
    const ready = !!(peer && peer.pubKey && window.VecheCrypto && VecheCrypto.available());
    const tog = $('secret-toggle');
    tog.checked = isSecret(activeChat);
    tog.disabled = !ready;
    $('secret-hint').textContent = ready ? 'Шифровать сообщения в этом чате'
      : (window.VecheCrypto && VecheCrypto.available() ? 'Собеседник ещё не заходил с поддержкой шифрования' : 'Нужен защищённый доступ (HTTPS)');
    renderSafetyNumber(peer);
    $('secret-modal').classList.remove('hidden');
  }
  async function renderSafetyNumber(peer) {
    const box = $('secret-verify');
    if (!peer || !peer.pubKey || !window.VecheCrypto || !VecheCrypto.available() || !isSecret(activeChat)) { box.classList.add('hidden'); return; }
    try { const myPub = await VecheCrypto.myPublicKey(); $('secret-sn').textContent = await VecheCrypto.safetyNumber(myPub, peer.pubKey); box.classList.remove('hidden'); }
    catch { box.classList.add('hidden'); }
  }
  $('secret-toggle').onchange = (e) => {
    if (!isDM(activeChat)) return;
    const peerId = peerIdOf(activeChat);
    setSecret(peerId, e.target.checked);
    $('btn-secret').textContent = e.target.checked ? '🔒' : '🔓';
    updateComposerSecret();
    renderSafetyNumber(users.get(peerId));
    renderChatList();
    toast(e.target.checked ? '🔒 Секретный режим включён' : 'Секретный режим выключен');
  };

  // ============ СООБЩЕНИЯ ============
  let lastRenderedDay = '';
  function appendDaySep(day) { const el = document.createElement('div'); el.className = 'day-sep'; el.textContent = day; $('messages').appendChild(el); lastRenderedDay = day; }

  function appendMessage(m, bulk) {
    currentMsgs.set(m.id, m);
    if (m.deleted) return;
    const day = fmtDay(m.ts); if (day !== lastRenderedDay) appendDaySep(day);

    if (m.type === 'system') { const s = document.createElement('div'); s.className = 'sys-msg'; s.textContent = m.text; s.dataset.id = m.id; $('messages').appendChild(s); return; }

    const out = m.from === me.id;
    const sender = users.get(m.from);
    const groupCtx = activeChat === EFIR || (activeChat && activeChat.startsWith('grp:'));
    const row = document.createElement('div');
    row.className = 'msg-row message-row ' + (out ? 'out' : 'in'); row.dataset.id = m.id;

    if (!out && groupCtx) {
      const av = document.createElement('div'); av.className = 'msg-avatar';
      paintAvatar(av, { avatar: sender && sender.avatar, name: sender && sender.name, colors: sender && sender.colors });
      av.style.cursor = 'pointer'; av.onclick = () => sender && openProfile(sender);
      row.appendChild(av);
    }

    const bubble = document.createElement('div'); bubble.className = 'bubble message-bubble';
    if (m.type === 'image' || m.type === 'video' || m.type === 'album') bubble.classList.add('media-bubble');
    if (m.type === 'circle') bubble.classList.add('circle-bubble');

    if (!out && groupCtx && sender) {
      const s = document.createElement('span'); s.className = 'sender'; s.style.color = sender.colors[0]; s.textContent = sender.name; bubble.appendChild(s);
    }
    if (m.forward) { const f = document.createElement('span'); f.className = 'fwd-label'; f.textContent = '⤴ переслано от ' + (m.forward.fromName || '…'); bubble.appendChild(f); }
    if (m.replyTo) {
      const rq = document.createElement('div'); rq.className = 'reply-quote';
      rq.innerHTML = `<div class="rq-name">${escapeHtml(m.replyTo.name || '…')}</div><div class="rq-text">${escapeHtml(previewText(m.replyTo))}</div>`;
      rq.onclick = (e) => { e.stopPropagation(); jumpTo(m.replyTo.id); };
      bubble.appendChild(rq);
    }

    renderBody(bubble, m, out);

    // мета
    const meta = document.createElement('span'); meta.className = 'meta';
    if (m.ttl) { const fire = document.createElement('span'); fire.textContent = '🔥'; fire.style.marginRight = '3px'; meta.appendChild(fire); }
    if (m.edited) { const e = document.createElement('span'); e.className = 'edited-mark'; e.style.cssText = 'margin-right:4px;opacity:.6'; e.textContent = '(ред.)'; meta.appendChild(e); }
    meta.appendChild(document.createTextNode(fmtTime(m.ts)));
    if (out && isDM(activeChat)) { const t = document.createElement('span'); const read = m.readBy && m.readBy.length > 1; t.className = 'ticks' + (read ? ' read' : ''); t.textContent = read ? '✓✓' : '✓'; meta.appendChild(t); }
    bubble.appendChild(meta);

    row.appendChild(bubble);
    renderReactions(row, m.id, m.reactions);

    // контекст-меню
    bubble.oncontextmenu = (e) => { e.preventDefault(); openMsgMenu(e, m); };
    let pressT;
    bubble.addEventListener('touchstart', (e) => { pressT = setTimeout(() => openMsgMenu({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, preventDefault() {} }, m), 480); }, { passive: true });
    bubble.addEventListener('touchend', () => clearTimeout(pressT));
    bubble.addEventListener('touchmove', () => clearTimeout(pressT));

    $('messages').appendChild(row);
  }

  function renderBody(bubble, m, out) {
    if (m.type === 'image') {
      const img = document.createElement('img'); img.className = 'photo'; img.src = m.media.url; img.loading = 'lazy';
      img.onclick = () => openLightbox(m.media.url); img.onload = () => scrollToBottom(true); bubble.appendChild(img);
      if (m.text) { const cap = document.createElement('div'); cap.className = 'caption msg-text'; cap.textContent = m.text; bubble.appendChild(cap); }
    } else if (m.type === 'video') {
      const v = document.createElement('video'); v.className = 'vid'; v.src = m.media.url; v.controls = true; v.preload = 'metadata'; bubble.appendChild(v);
      if (m.text) { const cap = document.createElement('div'); cap.className = 'caption msg-text'; cap.textContent = m.text; bubble.appendChild(cap); }
    } else if (m.type === 'circle') {
      const w = document.createElement('div'); w.className = 'circle-msg';
      const v = document.createElement('video'); v.src = m.media.url; v.loop = false; v.playsInline = true;
      const play = document.createElement('div'); play.className = 'cm-play'; play.innerHTML = '▶';
      const dur = document.createElement('div'); dur.className = 'cm-dur'; dur.textContent = fmtDur(m.media.dur || 0);
      w.appendChild(v); w.appendChild(play); w.appendChild(dur);
      w.onclick = () => { if (v.paused) { v.play(); play.style.display = 'none'; } else { v.pause(); play.style.display = 'flex'; } };
      v.onended = () => { play.style.display = 'flex'; }; bubble.appendChild(w);
    } else if (m.type === 'voice') {
      bubble.appendChild(buildVoice(m));
    } else if (m.type === 'file') {
      const a = document.createElement('a'); a.className = 'file-card'; a.href = m.media.url; a.download = m.media.name || ''; a.target = '_blank';
      a.innerHTML = `<div class="file-ic">${fileIcon(m.media.name)}</div><div class="file-meta"><b>${escapeHtml(m.media.name || 'файл')}</b><span>${fmtSize(m.media.size || 0)}</span></div>`;
      bubble.appendChild(a);
    } else if (m.type === 'geo') {
      const a = document.createElement('a'); a.className = 'geo-card'; a.target = '_blank';
      a.href = `https://www.openstreetmap.org/?mlat=${m.media.lat}&mlon=${m.media.lng}#map=16/${m.media.lat}/${m.media.lng}`;
      a.innerHTML = `<div class="geo-map"><div class="geo-grid"></div><div class="pin">📍</div></div><div class="geo-info"><b>Геолокация</b><br><span>${m.media.lat.toFixed(5)}, ${m.media.lng.toFixed(5)}</span></div>`;
      bubble.appendChild(a);
    } else if (m.type === 'album') {
      const grid = document.createElement('div'); grid.className = 'album-grid n' + Math.min(m.media.urls.length, 4);
      m.media.urls.forEach((u) => { const im = document.createElement('img'); im.src = u; im.loading = 'lazy'; im.onclick = () => openLightbox(u); im.onload = () => scrollToBottom(true); grid.appendChild(im); });
      bubble.appendChild(grid);
      if (m.text) { const cap = document.createElement('div'); cap.className = 'caption msg-text'; cap.textContent = m.text; bubble.appendChild(cap); }
    } else if (m.type === 'poll') {
      bubble.appendChild(buildPoll(m));
    } else if (m.type === 'game') {
      bubble.appendChild(buildGame(m));
    } else if (m.type === 'e2e') {
      bubble.classList.add('e2e-bubble');
      const lock = document.createElement('span'); lock.className = 'e2e-lock'; lock.textContent = '🔒';
      const t = document.createElement('span'); t.className = 'msg-text'; t.textContent = '…';
      bubble.appendChild(lock); bubble.appendChild(t);
      decryptInto(t, m);
    } else {
      const t = document.createElement('span'); t.className = 'msg-text'; t.textContent = m.text; bubble.appendChild(t);
    }
  }
  // расшифровать e2e-сообщение и вставить текст (ключ — только на этом устройстве)
  async function decryptInto(el, m) {
    try {
      if (m._dec != null) { el.textContent = m._dec; return; }
      if (!m.media || !m.media.enc) { el.textContent = 'зашифровано'; return; }
      if (!window.VecheCrypto || !VecheCrypto.available()) { el.textContent = 'секретное (нужен HTTPS)'; return; }
      VecheCrypto.setMyId(me.id); await VecheCrypto.ensureIdentity();
      const pt = await VecheCrypto.decrypt(m.media.enc);
      m._dec = pt; el.textContent = pt != null ? pt : 'не удалось расшифровать (нет ключа)';
    } catch { el.textContent = 'не удалось расшифровать'; }
  }
  function buildPoll(m) {
    const wrap = document.createElement('div'); wrap.className = 'poll';
    const q = document.createElement('div'); q.className = 'poll-q'; q.innerHTML = '📊 ' + escapeHtml(m.media.question); wrap.appendChild(q);
    const votes = m.media.votes || {};
    const total = Object.values(votes).reduce((s, a) => s + a.length, 0);
    const myVote = Object.entries(votes).find(([, a]) => a.includes(me.id));
    m.media.options.forEach((opt, i) => {
      const cnt = (votes[i] || []).length; const pct = total ? Math.round(cnt / total * 100) : 0;
      const o = document.createElement('div'); o.className = 'poll-opt' + (myVote && +myVote[0] === i ? ' voted' : '');
      o.innerHTML = `<div class="poll-bar" style="width:${pct}%"></div><span class="poll-txt">${escapeHtml(opt)}</span><span class="poll-pct">${pct}%</span>`;
      o.onclick = () => socket.emit('vote', { id: m.id, option: i });
      wrap.appendChild(o);
    });
    const tot = document.createElement('div'); tot.className = 'poll-total'; tot.textContent = total + ' голос(ов)'; wrap.appendChild(tot);
    return wrap;
  }
  function fileIcon(name) {
    const e = (name || '').split('.').pop().toLowerCase();
    if (['pdf'].includes(e)) return '📕'; if (['doc', 'docx'].includes(e)) return '📘';
    if (['xls', 'xlsx', 'csv'].includes(e)) return '📗'; if (['zip', 'rar', '7z'].includes(e)) return '🗜';
    if (['mp3', 'wav', 'ogg'].includes(e)) return '🎵'; if (['mp4', 'mov', 'mkv'].includes(e)) return '🎬';
    return '📄';
  }

  function renderReactions(row, id, reactions) {
    let box = row.querySelector('.reactions'); if (box) box.remove();
    if (!reactions || !Object.keys(reactions).length) return;
    box = document.createElement('div'); box.className = 'reactions';
    for (const [emoji, list] of Object.entries(reactions)) {
      const r = document.createElement('span'); r.className = 'reaction' + (list.includes(me.id) ? ' mine' : '');
      r.innerHTML = `${emoji}<span class="rc">${list.length}</span>`;
      r.onclick = () => socket.emit('react', { id, emoji });
      box.appendChild(r);
    }
    (row.querySelector('.bubble') || row).after(box);
  }

  function jumpTo(id) {
    const row = document.querySelector(`.msg-row[data-id="${id}"]`);
    if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); row.querySelector('.bubble').style.transition = 'background .4s'; const b = row.querySelector('.bubble'); const old = b.style.boxShadow; b.style.boxShadow = '0 0 0 2px var(--accent-2)'; setTimeout(() => b.style.boxShadow = old, 900); }
  }

  // голосовое
  function buildVoice(m) {
    const wrap = document.createElement('div'); wrap.className = 'voice';
    const audio = new Audio(m.media.url);
    const playBtn = document.createElement('button'); playBtn.className = 'voice-play'; playBtn.innerHTML = playIcon();
    const body = document.createElement('div'); body.className = 'voice-body';
    const wave = document.createElement('div'); wave.className = 'voice-wave';
    const N = 28, hs = pseudoWave(m.id, N);
    for (let i = 0; i < N; i++) { const b = document.createElement('span'); b.style.height = (4 + hs[i] * 20) + 'px'; wave.appendChild(b); }
    const bottom = document.createElement('div'); bottom.className = 'voice-bottom';
    const dur = document.createElement('div'); dur.className = 'voice-dur'; dur.textContent = fmtDur(m.media.dur || 0);
    // кнопка скорости воспроизведения: 1× → 1.5× → 2× → 1×
    let speed = 1;
    const speedBtn = document.createElement('button'); speedBtn.className = 'voice-speed'; speedBtn.textContent = '1×';
    speedBtn.onclick = (e) => {
      e.stopPropagation();
      speed = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
      audio.playbackRate = speed;
      speedBtn.textContent = speed + '×';
      speedBtn.classList.toggle('fast', speed !== 1);
    };
    bottom.appendChild(dur); bottom.appendChild(speedBtn);
    body.appendChild(wave); body.appendChild(bottom);
    wrap.appendChild(playBtn); wrap.appendChild(body);
    const bars = [...wave.children];
    const prog = (p) => { const on = Math.floor(p * N); bars.forEach((b, i) => b.classList.toggle('on', i < on)); };
    playBtn.onclick = () => { if (audio.paused) { document.querySelectorAll('audio').forEach((a) => a !== audio && a.pause()); audio.play(); playBtn.innerHTML = pauseIcon(); } else { audio.pause(); playBtn.innerHTML = playIcon(); } };
    audio.ontimeupdate = () => { if (audio.duration) { prog(audio.currentTime / audio.duration); dur.textContent = fmtDur(audio.currentTime); } };
    audio.onended = () => { playBtn.innerHTML = playIcon(); prog(0); dur.textContent = fmtDur(m.media.dur || 0); speed = 1; audio.playbackRate = 1; speedBtn.textContent = '1×'; speedBtn.classList.remove('fast'); };
    wave.onclick = (e) => { if (audio.duration) { const r = wave.getBoundingClientRect(); audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration; } };
    return wrap;
  }
  const playIcon = () => '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  const pauseIcon = () => '<svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  function pseudoWave(seed, n) { let h = 0; for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; const o = []; for (let i = 0; i < n; i++) { h = (h * 1103515245 + 12345) & 0x7fffffff; o.push(0.2 + (h % 1000) / 1000 * 0.8); } return o; }
  function scrollToBottom(instant) { const b = $('messages'); b.scrollTo({ top: b.scrollHeight, behavior: instant ? 'auto' : 'smooth' }); }

  // ============ ПИН ============
  function renderPinned() {
    const bar = $('pinned-bar');
    if (!pinnedMsg) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden'); $('pin-text').textContent = previewText(pinnedMsg);
    bar.onclick = () => jumpTo(pinnedMsg.id);
  }
  $('pin-close').onclick = (e) => { e.stopPropagation(); socket.emit('unpin', { chatId: activeChat }); };

  // ============ КОНТЕКСТ-МЕНЮ ============
  const msgMenu = $('msg-menu');
  let menuMsg = null;
  function openMsgMenu(e, m) {
    if (m.type === 'system' || m.deleted) return;
    menuMsg = m;
    const out = m.from === me.id;
    const chatAdmin = activeInfo && (activeInfo.owner === me.id || (activeInfo.admins || []).includes(me.id));
    msgMenu.querySelector('[data-act="edit"]').style.display = (out && m.type === 'text') ? '' : 'none';
    msgMenu.querySelector('[data-act="delete"]').style.display = (out || chatAdmin) ? '' : 'none';
    msgMenu.querySelector('[data-act="pin"]').style.display = (!isDM(activeChat) && !chatAdmin && activeChat !== EFIR) ? 'none' : '';
    msgMenu.querySelector('[data-act="copy"]').style.display = (m.type === 'text' || m.type === 'e2e') ? '' : 'none';
    msgMenu.querySelector('[data-act="forward"]').style.display = m.type === 'e2e' ? 'none' : '';
    msgMenu.querySelector('[data-act="report"]').style.display = out ? 'none' : '';
    msgMenu.querySelector('[data-act="adminDelete"]').style.display = (me.admin && !out) ? '' : 'none';
    // реакции
    const rbox = $('ctx-reactions'); rbox.innerHTML = '';
    for (const em of ['👍', '❤️', '😂', '🔥', '😮', '😢', '🙏']) {
      const b = document.createElement('button'); b.textContent = em;
      b.onclick = () => { socket.emit('react', { id: m.id, emoji: em }); closeMsgMenu(); };
      rbox.appendChild(b);
    }
    msgMenu.classList.remove('hidden');
    const mw = 200, mh = msgMenu.offsetHeight || 320;
    let x = Math.min(e.clientX, window.innerWidth - mw - 10);
    let y = Math.min(e.clientY, window.innerHeight - mh - 10);
    msgMenu.style.left = Math.max(8, x) + 'px'; msgMenu.style.top = Math.max(8, y) + 'px';
  }
  function closeMsgMenu() { msgMenu.classList.add('hidden'); menuMsg = null; }
  msgMenu.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.act, m = menuMsg; if (!m) return;
      if (act === 'reply') startReply(m);
      else if (act === 'forward') openForward(m);
      else if (act === 'copy') { navigator.clipboard.writeText((m.type === 'e2e' ? (m._dec || '') : m.text) || '').then(() => toast('Скопировано')); }
      else if (act === 'pin') socket.emit('pin', { id: m.id });
      else if (act === 'edit') startEdit(m);
      else if (act === 'delete') { if (confirm('Удалить сообщение у всех?')) { socket.emit('erasing', { chatId: activeChat }); setTimeout(() => socket.emit('delete', { id: m.id }), 500); } }
      else if (act === 'report') { const reason = prompt('На что жалуешься? (спам, оскорбление, запрещёнка)', 'спам'); if (reason !== null) { socket.emit('reportMsg', { id: m.id, reason }); toast('Жалоба отправлена модераторам'); } }
      else if (act === 'adminDelete') { socket.emit('deleteAnyMsg', { id: m.id }, (r) => toast(r && r.ok ? 'Удалено модератором' : 'Ошибка')); }
      closeMsgMenu();
    };
  });
  document.addEventListener('click', (e) => { if (!msgMenu.contains(e.target) && !e.target.closest('.bubble')) closeMsgMenu(); });

  // ============ РЕПЛАЙ/РЕДАКТ ============
  function startReply(m) {
    replyTarget = m; editTarget = null;
    $('reply-bar').classList.remove('hidden');
    $('reply-title').textContent = 'Ответ ' + (users.get(m.from) ? users.get(m.from).name : '');
    $('reply-text').textContent = previewText(m);
    $('msg-input').focus();
  }
  function startEdit(m) {
    editTarget = m; replyTarget = null;
    $('reply-bar').classList.remove('hidden');
    $('reply-title').textContent = 'Редактирование';
    $('reply-text').textContent = m.text;
    $('msg-input').value = m.text; $('msg-input').focus(); toggleSend();
  }
  function clearReply() { replyTarget = null; editTarget = null; $('reply-bar').classList.add('hidden'); }
  $('reply-cancel').onclick = () => { clearReply(); if (editTarget) { $('msg-input').value = ''; toggleSend(); } };

  // ============ ОТПРАВКА ============
  const input = $('msg-input');
  function emitSend(payload, after) { socket.emit('send', payload, (r) => { if (r && r.error && r.error !== 'empty') toast(r.error); else if (after) after(r); }); }
  function send() {
    const text = input.value.trim();
    if (editTarget) { if (text) socket.emit('edit', { id: editTarget.id, text }); clearReply(); input.value = ''; input.style.height = 'auto'; toggleSend(); return; }
    if (!text || !activeChat) return;
    if (isSecret(activeChat)) { sendSecret(text); return; }
    const payload = { chatId: activeChat, type: 'text', text };
    if (replyTarget) payload.replyTo = replyTarget.id;
    emitSend(payload);
    input.value = ''; input.style.height = 'auto'; clearReply(); toggleSend(); input.focus();
  }
  // Отправка секретного (E2E) сообщения: шифруем на устройстве для собеседника и для себя
  async function sendSecret(text) {
    const chatId = activeChat, peerId = peerIdOf(chatId), peer = users.get(peerId);
    let myPub = null; try { myPub = await VecheCrypto.myPublicKey(); } catch {}
    if (!peer || !peer.pubKey || !myPub) return toast('Собеседник ещё не заходил с поддержкой шифрования');
    const rt = replyTarget;
    input.value = ''; input.style.height = 'auto'; clearReply(); toggleSend();
    try {
      const enc = await VecheCrypto.encrypt(text, [{ id: peerId, pub: peer.pubKey }, { id: me.id, pub: myPub }]);
      const payload = { chatId, type: 'e2e', media: { enc } };
      if (rt) payload.replyTo = rt.id;
      emitSend(payload);
    } catch (e) { toast('Не удалось зашифровать сообщение'); console.warn('e2e encrypt:', e); }
    input.focus();
  }
  function updateComposerSecret() {
    const on = !!(activeChat && isSecret(activeChat));
    input.placeholder = on ? '🔒 Секретное сообщение…' : 'Сообщение…';
    $('composer').classList.toggle('secret', on);
  }
  $('btn-send').onclick = send;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 130) + 'px'; toggleSend(); throttledTyping(); });
  function toggleSend() {
    const has = input.value.trim().length > 0;
    $('btn-send').classList.toggle('hidden', !has);
    $('btn-mic').classList.toggle('hidden', has);
    $('btn-circle').classList.toggle('hidden', has);
  }
  let lastTyping = 0;
  function throttledTyping() { if (!activeChat || !input.value) return; const n = Date.now(); if (n - lastTyping > 1500) { lastTyping = n; socket.emit('typing', { chatId: activeChat }); } }
  window.addEventListener('focus', () => { if (activeChat && socket) { const c = chats.get(activeChat); if (c && c.unread) { c.unread = 0; socket.emit('read', { chatId: activeChat }); renderChatList(); } } });

  // ============ ЗАГРУЗКА ============
  async function upload(blob, mime, name) {
    const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': mime };
    if (name) headers['X-Filename'] = encodeURIComponent(name);
    const res = await fetch('/api/upload', { method: 'POST', headers, body: blob });
    const data = await res.json(); if (!res.ok) throw new Error(data.error || 'upload failed'); return data;
  }

  // ============ ВЛОЖЕНИЯ ============
  const attachMenu = $('attach-menu');
  $('btn-attach').onclick = (e) => { e.stopPropagation(); closeEmoji(); attachMenu.classList.toggle('hidden'); };
  function closeAttach() { attachMenu.classList.add('hidden'); }
  document.addEventListener('click', (e) => { if (!attachMenu.contains(e.target) && e.target !== $('btn-attach') && !$('btn-attach').contains(e.target)) closeAttach(); });
  attachMenu.querySelectorAll('button[data-act]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.act; closeAttach();
      if (isSecret(activeChat)) return toast('🔒 В секретном чате — только текст. Для вложений выключи замок.');
      if (a === 'photo') $('file-photo').click();
      else if (a === 'file') $('file-any').click();
      else if (a === 'geo') sendGeo();
      else if (a === 'timed') openTimed();
      else if (a === 'burn') sendBurn();
      else if (a === 'poll') openPoll();
      else if (a === 'game') openGameModal();
    };
  });
  function sendBurn() {
    const text = input.value.trim();
    if (!text) return toast('Сначала напиши текст — он сгорит после прочтения');
    const sec = prompt('Через сколько секунд сообщение исчезнёт у всех?', '30');
    if (sec === null) return;
    const ttl = Math.max(1, Math.min(86400, parseInt(sec, 10) || 30));
    socket.emit('send', { chatId: activeChat, type: 'text', text, ttl });
    input.value = ''; input.style.height = 'auto'; toggleSend();
    toast(`🔥 Исчезнет через ${ttl} сек`);
  }
  $('file-photo').onchange = async (e) => {
    const files = [...e.target.files].slice(0, 10); e.target.value = ''; if (!files.length || !activeChat) return;
    try {
      if (files.length === 1) { const { url } = await uploadImage(files[0]); emitSend({ chatId: activeChat, type: 'image', text: '', media: { url } }); }
      else { toast('Загружаю ' + files.length + ' фото…'); const urls = []; for (const f of files) { const { url } = await uploadImage(f); urls.push(url); } emitSend({ chatId: activeChat, type: 'album', media: { urls } }); }
    } catch (err) { toast('Ошибка фото: ' + err.message); }
  };
  $('file-any').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f || !activeChat) return;
    if (f.size > 40 * 1048576) return toast('Файл больше 40 МБ');
    try { const { url, size } = await upload(f, f.type || 'application/octet-stream', f.name);
      const type = (f.type || '').startsWith('video/') ? 'video' : 'file';
      socket.emit('send', { chatId: activeChat, type, media: { url, name: f.name, size, mime: f.type } }); }
    catch (err) { toast('Ошибка файла: ' + err.message); }
  };
  function sendGeo() {
    if (!navigator.geolocation) return toast('Геолокация недоступна');
    toast('Определяю местоположение…');
    navigator.geolocation.getCurrentPosition(
      (pos) => socket.emit('send', { chatId: activeChat, type: 'geo', media: { lat: pos.coords.latitude, lng: pos.coords.longitude } }),
      () => toast('Не удалось получить геолокацию'), { enableHighAccuracy: true, timeout: 10000 });
  }

  // ============ ТАЙМЕР ============
  const timedModal = $('timed-modal');
  function openTimed() { if (!input.value.trim()) return toast('Сначала напиши текст сообщения'); timedModal.classList.remove('hidden'); }
  timedModal.querySelectorAll('.timed-quick button').forEach((b) => b.onclick = () => scheduleSend(Date.now() + Number(b.dataset.min) * 60000));
  $('timed-go').onclick = () => { const v = $('timed-at').value; if (!v) return toast('Выбери время'); scheduleSend(new Date(v).getTime()); };
  function scheduleSend(at) {
    const text = input.value.trim(); if (!text) return;
    if (at < Date.now() + 5000) return toast('Время уже прошло');
    socket.emit('send', { chatId: activeChat, type: 'text', text, scheduledFor: at }, (r) => {
      if (r && r.scheduled) { toast('⏱ Запланировано на ' + new Date(at).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })); input.value = ''; toggleSend(); }
    });
    timedModal.classList.add('hidden');
  }

  // ============ ЭМОДЗИ ============
  const emojiPanel = $('emoji-panel');
  let emojiBuilt = false;
  $('btn-emoji').onclick = (e) => { e.stopPropagation(); closeAttach(); emojiPanel.classList.toggle('hidden'); if (!emojiPanel.classList.contains('hidden')) buildEmoji(); };
  function closeEmoji() { emojiPanel.classList.add('hidden'); }
  document.addEventListener('click', (e) => { if (!emojiPanel.contains(e.target) && e.target !== $('btn-emoji')) closeEmoji(); });
  function freq() { try { return JSON.parse(localStorage.getItem(FREQ_KEY) || '{}'); } catch { return {}; } }
  function bumpFreq(em) { const f = freq(); f[em] = (f[em] || 0) + 1; localStorage.setItem(FREQ_KEY, JSON.stringify(f)); }
  function buildEmoji() {
    const tabs = $('emoji-tabs'), grid = $('emoji-grid');
    const f = freq(); const top = Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 24).map((x) => x[0]);
    const cats = {}; if (top.length) cats['🕓'] = top; Object.assign(cats, window.EMOJI);
    tabs.innerHTML = ''; let first = true;
    for (const key of Object.keys(cats)) {
      const t = document.createElement('button'); t.textContent = key; if (first) t.classList.add('active');
      t.onclick = () => { tabs.querySelectorAll('button').forEach((x) => x.classList.remove('active')); t.classList.add('active'); showCat(cats[key]); };
      tabs.appendChild(t); first = false;
    }
    function showCat(list) { grid.innerHTML = ''; for (const em of list) { const b = document.createElement('button'); b.textContent = em; b.onclick = () => insertEmoji(em); grid.appendChild(b); } grid.scrollTop = 0; }
    showCat(cats[Object.keys(cats)[0]]);
    emojiBuilt = true;
  }
  function insertEmoji(em) { bumpFreq(em); input.value += em; input.focus(); toggleSend(); }

  // ============ ГОЛОСОВОЕ ============
  let mr = null, recChunks = [], recStart = 0, recTimer = null, recStream = null, recCancelled = false;
  $('btn-mic').onclick = async () => {
    if (!activeChat) return;
    if (isSecret(activeChat)) return toast('🔒 В секретном чате — только текст');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast('Микрофон доступен только по HTTPS');
    try { recStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 } }); } catch { return toast('Разреши доступ к микрофону'); }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';
    // качество голосовых: 96 кбит/с (раньше было 32 — звучало «как из помойки»).
    // opus на 96k — прозрачно для речи; на iOS падает в AAC, где высокий битрейт особенно важен.
    mr = new MediaRecorder(recStream, mime ? { mimeType: mime, audioBitsPerSecond: 96000 } : undefined);
    recChunks = []; recCancelled = false;
    mr.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
    mr.onstop = onRecStop; mr.start(); recStart = Date.now();
    $('composer').classList.add('hidden'); $('rec-bar').classList.remove('hidden'); $('rec-time').textContent = '0:00';
    recTimer = setInterval(() => { const s = (Date.now() - recStart) / 1000; $('rec-time').textContent = fmtDur(s); if (s >= 300) $('rec-send').click(); }, 200);
  };
  $('rec-cancel').onclick = () => { recCancelled = true; stopRec(); };
  $('rec-send').onclick = () => { recCancelled = false; stopRec(); };
  function stopRec() { clearInterval(recTimer); recTimer = null; $('rec-bar').classList.add('hidden'); $('composer').classList.remove('hidden'); if (mr && mr.state !== 'inactive') mr.stop(); if (recStream) { recStream.getTracks().forEach((t) => t.stop()); recStream = null; } }
  async function onRecStop() {
    const dur = (Date.now() - recStart) / 1000;
    if (recCancelled || dur < 0.5 || !recChunks.length) return;
    const blob = new Blob(recChunks, { type: recChunks[0].type || 'audio/webm' });
    const tmpId = '_tmp_' + Date.now();
    const blobUrl = URL.createObjectURL(blob);
    appendMessage({ id: tmpId, from: me.id, chatId: activeChat, type: 'voice', ts: Date.now(), media: { url: blobUrl, dur } });
    scrollToBottom();
    try {
      const { url } = await upload(blob, blob.type, 'voice.webm');
      const tmpEl = document.querySelector(`.msg-row[data-id="${tmpId}"]`);
      if (tmpEl) tmpEl.remove();
      currentMsgs.delete(tmpId);
      URL.revokeObjectURL(blobUrl);
      socket.emit('send', { chatId: activeChat, type: 'voice', media: { url, dur } });
    } catch (e) {
      const tmpEl = document.querySelector(`.msg-row[data-id="${tmpId}"]`);
      if (tmpEl) { tmpEl.style.opacity = '0.4'; tmpEl.title = 'Ошибка отправки'; }
      URL.revokeObjectURL(blobUrl);
      toast('Ошибка голосового: ' + e.message);
    }
  }

  // ============ КРУЖОК ============
  let cmr = null, cChunks = [], cStart = 0, cTimer = null, cStream = null, cRecording = false, circleFacing = 'user';
  const circleModal = $('circle-modal');
  function getCircleStream() {
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: circleFacing }, width: 480, height: 480 },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  }
  $('btn-circle').onclick = async () => {
    if (!activeChat) return;
    if (isSecret(activeChat)) return toast('🔒 В секретном чате — только текст');
    if (!navigator.mediaDevices) return toast('Камера доступна только по HTTPS');
    circleFacing = 'user';
    try { cStream = await getCircleStream(); }
    catch { return toast('Разреши доступ к камере и микрофону'); }
    $('circle-preview').srcObject = cStream; circleModal.classList.remove('hidden'); $('circle-timer').textContent = '0:00';
    $('circle-send').classList.add('hidden'); $('circle-rec').classList.remove('hidden'); cRecording = false; circleModal.classList.remove('recording');
  };
  // смена камеры (фронтальная ↔ основная); на вебе переключать можно только до записи
  $('circle-flip').onclick = async () => {
    if (cRecording) return toast('Сначала останови запись, потом меняй камеру');
    circleFacing = circleFacing === 'user' ? 'environment' : 'user';
    const old = cStream;
    try { cStream = await getCircleStream(); }
    catch {
      circleFacing = circleFacing === 'user' ? 'environment' : 'user'; // вернуть как было
      return toast('Не получилось переключить камеру');
    }
    if (old) old.getTracks().forEach((t) => t.stop());
    $('circle-preview').srcObject = cStream;
    buzz(15);
  };
  $('circle-rec').onclick = () => { if (!cRecording) startCircle(); else stopCircle(); };
  function startCircle() {
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus' : MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : 'video/mp4';
    cmr = new MediaRecorder(cStream, { mimeType: mime }); cChunks = [];
    cmr.ondataavailable = (e) => e.data.size && cChunks.push(e.data);
    cmr.onstop = () => { $('circle-rec').classList.add('hidden'); $('circle-send').classList.remove('hidden'); circleModal.classList.remove('recording'); };
    cmr.start(); cStart = Date.now(); cRecording = true; circleModal.classList.add('recording');
    cTimer = setInterval(() => { const s = (Date.now() - cStart) / 1000; $('circle-timer').textContent = fmtDur(s); if (s >= 60) stopCircle(); }, 200);
  }
  function stopCircle() { clearInterval(cTimer); if (cmr && cmr.state !== 'inactive') cmr.stop(); cRecording = false; }
  $('circle-send').onclick = async () => {
    const dur = (Date.now() - cStart) / 1000;
    const blob = new Blob(cChunks, { type: cChunks[0] ? cChunks[0].type : 'video/webm' });
    closeCircle();
    try { const { url } = await upload(blob, 'video/webm', 'circle.webm'); socket.emit('send', { chatId: activeChat, type: 'circle', media: { url, dur } }); }
    catch (e) { toast('Ошибка кружка: ' + e.message); }
  };
  $('circle-cancel').onclick = closeCircle;
  function closeCircle() { clearInterval(cTimer); if (cmr && cmr.state !== 'inactive') try { cmr.stop(); } catch {} if (cStream) { cStream.getTracks().forEach((t) => t.stop()); cStream = null; } circleModal.classList.add('hidden'); circleModal.classList.remove('recording'); cRecording = false; }

  // ============ ПОИСК ============
  $('search').addEventListener('input', (e) => { searchQuery = e.target.value.trim(); renderChatList(); });

  // ============ ЛАЙТБОКС ============
  function openLightbox(url) { $('lightbox-img').src = url; $('lightbox').classList.remove('hidden'); }
  $('lightbox').onclick = () => $('lightbox').classList.add('hidden');

  // ============ ЗВУК ============
  let audioCtx = null;
  function beep() { try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); const o = audioCtx.createOscillator(), g = audioCtx.createGain(); o.type = 'sine'; o.frequency.value = 880; g.gain.setValueAtTime(0.06, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25); o.connect(g).connect(audioCtx.destination); o.start(); o.stop(audioCtx.currentTime + 0.25); } catch {} }

  // ============ МОДАЛКИ: общие ============
  document.querySelectorAll('[data-close]').forEach((b) => b.onclick = () => b.closest('.modal-overlay').classList.add('hidden'));
  document.querySelectorAll('.modal-overlay').forEach((o) => o.addEventListener('click', (e) => { if (e.target === o) o.classList.add('hidden'); }));

  // ============ ПРОФИЛЬ (просмотр) ============
  let viewUser = null;
  function openProfile(u) {
    if (!u) return; viewUser = u;
    const photos = u.photos && u.photos.length ? u.photos : (u.avatar ? [u.avatar] : []);
    const pc = $('pv-photos'); pc.innerHTML = '';
    if (photos.length) { pc.className = 'profile-photos'; for (const p of photos) { const it = document.createElement('div'); it.className = 'pp-item'; const im = document.createElement('img'); im.src = p; im.onclick = () => openLightbox(p); it.appendChild(im); pc.appendChild(it); } }
    else { pc.className = ''; const e = document.createElement('div'); e.className = 'pp-empty'; e.style.background = `linear-gradient(135deg,${u.colors[0]},${u.colors[1]})`; e.textContent = initials(u.name); pc.appendChild(e); }
    $('pv-name').textContent = u.name;
    $('pv-username').textContent = '@' + u.username;
    $('pv-bio').textContent = u.bio || ''; $('pv-bio').style.display = u.bio ? '' : 'none';
    const tg = $('pv-tg'); if (u.tg) { tg.classList.remove('hidden'); tg.innerHTML = `Telegram: <a href="https://t.me/${escapeHtml(u.tg)}" target="_blank" rel="noopener">@${escapeHtml(u.tg)}</a>`; } else tg.classList.add('hidden');
    const ph = $('pv-phone'); if (u.phone) { ph.classList.remove('hidden'); ph.textContent = '📞 ' + u.phone; } else ph.classList.add('hidden');
    $('pv-closed').classList.toggle('hidden', !u.closed);
    const isMe = u.id === me.id;
    $('pv-message').style.display = isMe ? 'none' : '';
    $('pv-block').style.display = isMe ? 'none' : '';
    $('pv-block').textContent = (me.blocked || []).includes(u.id) ? 'Разблокировать' : 'Заблокировать';
    $('profile-modal').classList.remove('hidden');
  }
  $('pv-message').onclick = () => { $('profile-modal').classList.add('hidden'); if (viewUser && viewUser.id !== me.id) openChat(dmWith(viewUser.id)); };
  $('pv-block').onclick = () => {
    if (!viewUser) return;
    const blocked = (me.blocked || []).includes(viewUser.id);
    fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({}) });
    // блок храним локально через быстрый патч — отправим спец-поле
    socketBlock(viewUser.id, !blocked);
    $('profile-modal').classList.add('hidden');
  };
  function socketBlock(userId, on) {
    if (on) { if (!me.blocked.includes(userId)) me.blocked.push(userId); toast('Заблокирован'); }
    else { me.blocked = me.blocked.filter((x) => x !== userId); toast('Разблокирован'); }
    fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ blocked: me.blocked }) }).catch(() => {});
  }

  // ============ СОЗДАНИЕ ГРУПП/КАНАЛОВ ============
  $('btn-new').onclick = () => $('new-modal').classList.remove('hidden');
  let createType = 'group', createSel = new Set();
  document.querySelectorAll('[data-new]').forEach((b) => b.onclick = () => { createType = b.dataset.new; $('new-modal').classList.add('hidden'); openCreate(); });
  function openCreate() {
    createSel = new Set();
    $('create-title').textContent = createType === 'channel' ? 'Новый канал' : 'Новая группа';
    $('create-name').value = ''; $('create-desc').value = ''; $('member-search').value = ''; $('create-error').textContent = '';
    renderMemberPicker('');
    $('create-modal').classList.remove('hidden');
  }
  $('member-search').oninput = (e) => renderMemberPicker(e.target.value.trim().toLowerCase());
  function renderMemberPicker(q) {
    const box = $('member-list'); box.innerHTML = '';
    const list = [...users.values()].filter((u) => u.id !== me.id).filter((u) => !q || u.name.toLowerCase().includes(q) || u.username.includes(q)).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    for (const u of list) {
      const row = document.createElement('div'); row.className = 'member-row' + (createSel.has(u.id) ? ' sel' : '');
      const av = document.createElement('div'); av.className = 'chat-avatar'; paintAvatar(av, { avatar: u.avatar, name: u.name, colors: u.colors });
      row.appendChild(av);
      const b = document.createElement('div'); b.className = 'mr-body'; b.innerHTML = `<div class="mr-name">${escapeHtml(u.name)}</div><div class="mr-sub">@${escapeHtml(u.username)}</div>`; row.appendChild(b);
      const ck = document.createElement('div'); ck.className = 'mr-check'; ck.textContent = createSel.has(u.id) ? '✓' : ''; row.appendChild(ck);
      row.onclick = () => { if (createSel.has(u.id)) createSel.delete(u.id); else createSel.add(u.id); renderMemberPicker(q); };
      box.appendChild(row);
    }
  }
  $('create-go').onclick = () => {
    const title = $('create-name').value.trim();
    if (!title) { $('create-error').textContent = 'Введи название'; return; }
    socket.emit('createChat', { type: createType, title, description: $('create-desc').value.trim(), members: [...createSel] }, (r) => {
      if (r && r.ok) { $('create-modal').classList.add('hidden'); setTimeout(() => openChat(r.chatId), 200); toast(createType === 'channel' ? 'Канал создан' : 'Группа создана'); }
      else $('create-error').textContent = (r && r.error) || 'Ошибка';
    });
  };

  // ============ ИНФО О ЧАТЕ ============
  function openChatInfo() {
    socket.emit('chatInfo', { chatId: activeChat }, (info) => { if (info) { activeInfo = info; chatInfos.set(activeChat, info); renderChatInfo(info); $('chatinfo-modal').classList.remove('hidden'); } });
  }
  function renderChatInfo(c) {
    const admin = c.owner === me.id || (c.admins || []).includes(me.id);
    $('ci-head').textContent = c.type === 'channel' ? 'Канал' : 'Группа';
    paintAvatar($('ci-avatar'), { avatar: c.avatar, name: c.title, colors: ['#5b48e0', '#3e7bfa'] }, 34, c.type === 'channel' ? '📣' : '👥');
    $('ci-title').textContent = c.title; $('ci-sub').textContent = c.description || (c.membersCount + ' участник(ов)');
    $('ci-avatar-edit').classList.toggle('hidden', !admin);
    $('ci-edit-block').classList.toggle('hidden', !admin);
    $('ci-add').style.display = admin ? '' : 'none';
    $('ci-name').value = c.title; $('ci-desc').value = c.description || '';
    const list = $('ci-members'); list.innerHTML = '';
    const all = [...c.members, ...(c.subscribers || [])];
    for (const u of all) {
      const row = document.createElement('div'); row.className = 'member-row';
      const av = document.createElement('div'); av.className = 'chat-avatar'; paintAvatar(av, { avatar: u.avatar, name: u.name, colors: u.colors }); row.appendChild(av);
      const b = document.createElement('div'); b.className = 'mr-body'; b.innerHTML = `<div class="mr-name">${escapeHtml(u.name)}</div><div class="mr-sub">@${escapeHtml(u.username)}</div>`; row.appendChild(b);
      if (u.id === c.owner) { const r = document.createElement('span'); r.className = 'mr-role'; r.textContent = 'владелец'; row.appendChild(r); }
      else if ((c.admins || []).includes(u.id)) { const r = document.createElement('span'); r.className = 'mr-role'; r.textContent = 'админ'; row.appendChild(r); }
      if (admin && u.id !== me.id && u.id !== c.owner) {
        const acts = document.createElement('div'); acts.className = 'mr-actions';
        if (c.owner === me.id) { const ab = document.createElement('button'); ab.textContent = (c.admins || []).includes(u.id) ? 'снять' : 'админ'; ab.onclick = (e) => { e.stopPropagation(); socket.emit('setAdmin', { chatId: c.id, userId: u.id, on: !(c.admins || []).includes(u.id) }); }; acts.appendChild(ab); }
        const rb = document.createElement('button'); rb.textContent = 'убрать'; rb.onclick = (e) => { e.stopPropagation(); socket.emit('removeMember', { chatId: c.id, userId: u.id }); }; acts.appendChild(rb);
        row.appendChild(acts);
      }
      row.querySelector('.mr-body').onclick = () => { $('chatinfo-modal').classList.add('hidden'); openProfile(users.get(u.id) || u); };
      list.appendChild(row);
    }
  }
  $('ci-save').onclick = () => socket.emit('updateChat', { chatId: activeChat, title: $('ci-name').value.trim(), description: $('ci-desc').value.trim() }, (r) => { if (r && r.ok) toast('Сохранено'); });
  $('ci-avatar-edit').onclick = () => { ciAvatarMode = true; $('avatar-input').click(); };
  $('ci-leave').onclick = () => { if (confirm('Выйти из чата?')) socket.emit('leaveChat', { chatId: activeChat }, () => { $('chatinfo-modal').classList.add('hidden'); }); };
  $('ci-add').onclick = () => { ciAddMode = true; createSel = new Set(); $('create-title').textContent = 'Добавить участников'; $('create-name').parentElement.style.display = 'none'; $('create-desc').parentElement.style.display = 'none'; $('member-search').value = ''; renderMemberPicker(''); $('chatinfo-modal').classList.add('hidden'); $('create-modal').classList.remove('hidden'); };
  let ciAddMode = false, ciAvatarMode = false;
  // переиспользуем create-go для добавления
  const origCreateGo = $('create-go').onclick;
  $('create-go').onclick = () => {
    if (ciAddMode) {
      socket.emit('addMembers', { chatId: activeChat, members: [...createSel] }, (r) => { ciAddMode = false; $('create-modal').classList.add('hidden'); $('create-name').parentElement.style.display = ''; $('create-desc').parentElement.style.display = ''; if (r && r.ok) toast('Добавлено'); });
      return;
    }
    origCreateGo();
  };

  // ============ НАСТРОЙКИ ============
  $('btn-settings').onclick = $('me-avatar').onclick = openSettings;
  function openSettings() {
    renderSetPhotos();
    $('set-name').value = me.name || ''; $('set-username').value = '@' + me.username;
    $('set-bio').value = me.bio || ''; $('set-phone').value = me.phone || ''; $('set-tg').value = me.tg || ''; $('set-email').value = me.email || '';
    $('set-status').value = me.customStatus || '';
    $('set-ghost').checked = !!(me.privacy && me.privacy.ghost);
    $('set-closed').checked = !!(me.privacy && me.privacy.closed);
    $('set-showphone').checked = !!(me.privacy && me.privacy.showPhone);
    $('set-hideonline').checked = !!(me.settings && me.settings.hideOnline);
    $('set-mutenew').checked = !!(me.settings && me.settings.muteNewChats);
    $('set-hideefir').checked = !!(me.settings && me.settings.hideEfir);
    $('set-pass-cur').value = ''; $('set-pass-new').value = ''; $('set-msg').textContent = '';
    syncPushToggle();
    $('settings-modal').classList.remove('hidden');
  }
  function renderSetPhotos() {
    const box = $('set-photos'); box.innerHTML = '';
    const photos = me.photos || [];
    if (!photos.length) { const e = document.createElement('div'); e.className = 'pp-empty'; e.style.background = `linear-gradient(135deg,${me.colors[0]},${me.colors[1]})`; e.textContent = initials(me.name); box.appendChild(e); return; }
    for (const p of photos) {
      const it = document.createElement('div'); it.className = 'pp-item' + (p === me.avatar ? ' main' : '');
      const im = document.createElement('img'); im.src = p; im.onclick = () => setMainPhoto(p); it.appendChild(im);
      const del = document.createElement('button'); del.className = 'pp-del'; del.textContent = '✕'; del.onclick = (e) => { e.stopPropagation(); removePhoto(p); }; it.appendChild(del);
      box.appendChild(it);
    }
  }
  $('set-add-photo').onclick = () => { ciAvatarMode = false; $('avatar-input').click(); };
  $('avatar-input').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const { url } = await uploadImage(f);
      if (ciAvatarMode) { ciAvatarMode = false; socket.emit('updateChat', { chatId: activeChat, avatar: url }, () => toast('Фото обновлено')); return; }
      const res = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ avatar: url }) });
      me = await res.json(); users.set(me.id, { ...users.get(me.id), avatar: me.avatar, photos: me.photos });
      renderSetPhotos(); paintAvatar($('me-avatar'), { avatar: me.avatar, name: me.name, colors: me.colors });
    } catch (err) { toast('Ошибка: ' + err.message); }
  };
  async function patchProfile(body) {
    const res = await fetch('/api/profile', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(body) });
    me = await res.json(); return res.ok;
  }
  async function setMainPhoto(p) { await patchProfile({ setMainPhoto: p }); renderSetPhotos(); paintAvatar($('me-avatar'), { avatar: me.avatar, name: me.name, colors: me.colors }); }
  async function removePhoto(p) { await patchProfile({ removePhoto: p }); renderSetPhotos(); paintAvatar($('me-avatar'), { avatar: me.avatar, name: me.name, colors: me.colors }); }

  // мгновенные тумблеры
  $('set-ghost').onchange = (e) => { patchProfile({ privacy: { ghost: e.target.checked } }); toast(e.target.checked ? '👻 Режим Призрак включён' : 'Режим Призрак выключен'); };
  $('set-closed').onchange = (e) => patchProfile({ privacy: { closed: e.target.checked } });
  $('set-showphone').onchange = (e) => patchProfile({ privacy: { showPhone: e.target.checked } });
  $('set-hideonline').onchange = (e) => patchProfile({ settings: { hideOnline: e.target.checked } });
  $('set-mutenew').onchange = (e) => patchProfile({ settings: { muteNewChats: e.target.checked } });
  $('set-hideefir').onchange = async (e) => { await patchProfile({ settings: { hideEfir: e.target.checked } }); renderChatList(); };
  $('set-push').onchange = async (e) => {
    if (e.target.checked) { await ensurePushSubscription(false); syncPushToggle(); }
    else { await disablePush(); syncPushToggle(); toast('🔕 Уведомления выключены'); }
  };

  $('set-save').onclick = async () => {
    const ok = await patchProfile({ name: $('set-name').value.trim(), bio: $('set-bio').value.trim(), phone: $('set-phone').value.trim(), tg: $('set-tg').value.trim(), email: $('set-email').value.trim(), customStatus: $('set-status').value.trim() });
    const msg = $('set-msg');
    if (ok) { msg.className = 'set-msg ok'; msg.textContent = 'Сохранено ✓'; paintAvatar($('me-avatar'), { avatar: me.avatar, name: me.name, colors: me.colors }); renderChatList(); }
    else { msg.className = 'set-msg err'; msg.textContent = 'Ошибка'; }
  };
  $('set-pass-save').onclick = async () => {
    const cur = $('set-pass-cur').value, next = $('set-pass-new').value;
    const msg = $('set-msg');
    if (!cur || !next) { msg.className = 'set-msg err'; msg.textContent = 'Заполни оба поля пароля'; return; }
    const res = await fetch('/api/password', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ current: cur, next }) });
    const data = await res.json();
    if (res.ok) { localStorage.setItem(TOKEN_KEY, data.token); token = data.token; msg.className = 'set-msg ok'; msg.textContent = 'Пароль изменён ✓'; $('set-pass-cur').value = ''; $('set-pass-new').value = ''; }
    else { msg.className = 'set-msg err'; msg.textContent = data.error; }
  };
  $('set-logout').onclick = () => { localStorage.removeItem(TOKEN_KEY); location.reload(); };

  // ============ ПЕРЕСЫЛКА ============
  function openForward(m) {
    forwardMsg = m; $('forward-search').value = ''; renderForwardList('');
    $('forward-modal').classList.remove('hidden');
  }
  $('forward-search').oninput = (e) => renderForwardList(e.target.value.trim().toLowerCase());
  function renderForwardList(q) {
    const box = $('forward-list'); box.innerHTML = '';
    const targets = [];
    targets.push({ chatId: EFIR, title: 'Эфир', icon: '📡' });
    for (const c of chats.values()) { if (c.chatId === EFIR) continue; const d = chatDisplay(c); targets.push({ chatId: c.chatId, title: d.title, avatar: d.avatar, colors: d.colors, icon: d.icon }); }
    for (const u of users.values()) { if (u.id === me.id) continue; const cid = dmWith(u.id); if (chats.has(cid)) continue; targets.push({ chatId: cid, title: u.name, avatar: u.avatar, colors: u.colors }); }
    const seen = new Set();
    for (const t of targets) {
      if (seen.has(t.chatId)) continue; seen.add(t.chatId);
      if (q && !t.title.toLowerCase().includes(q)) continue;
      const row = document.createElement('div'); row.className = 'member-row';
      const av = document.createElement('div'); av.className = 'chat-avatar'; paintAvatar(av, { avatar: t.avatar, name: t.title, colors: t.colors }, t.icon ? 18 : null, t.icon); row.appendChild(av);
      const b = document.createElement('div'); b.className = 'mr-body'; b.innerHTML = `<div class="mr-name">${escapeHtml(t.title)}</div>`; row.appendChild(b);
      row.onclick = () => doForward(t.chatId);
      box.appendChild(row);
    }
  }
  function doForward(chatId) {
    const m = forwardMsg; if (!m) return;
    if (isSecret(chatId)) return toast('🔒 В секретный чат пересылать нельзя — только прямой текст');
    const sender = users.get(m.from);
    socket.emit('send', { chatId, type: m.type, text: m.text, media: m.media, forward: { fromName: sender ? sender.name : '', fromId: m.from } });
    $('forward-modal').classList.add('hidden'); toast('Переслано'); forwardMsg = null;
  }

  // ============ ЛЕНТА / СТЕНА ============
  let feedOpen = false;
  $('btn-feed').onclick = openFeed;
  function openFeed() {
    feedOpen = true; $('feed-list').innerHTML = '<div class="feed-empty">Загрузка…</div>';
    $('feed-modal').classList.remove('hidden');
    socket.emit('feed', {}, (posts) => {
      $('feed-list').innerHTML = '';
      if (!posts || !posts.length) { $('feed-list').innerHTML = '<div class="feed-empty">Пока пусто. Будь первым — нажми ✎ и опубликуй пост.</div>'; return; }
      for (const p of posts) $('feed-list').appendChild(postEl(p));
    });
  }
  $('feed-modal').addEventListener('click', (e) => { if (e.target === $('feed-modal')) feedOpen = false; });
  function postEl(p) {
    const el = document.createElement('div'); el.className = 'post'; el.dataset.id = p.id;
    const head = document.createElement('div'); head.className = 'post-head';
    const av = document.createElement('div'); av.className = 'chat-avatar';
    paintAvatar(av, { avatar: p.author && p.author.avatar, name: p.author && p.author.name, colors: p.author && p.author.colors });
    av.style.cursor = 'pointer'; av.onclick = () => { const u = users.get(p.author.id); if (u) { $('feed-modal').classList.add('hidden'); openProfile(u); } };
    head.appendChild(av);
    const hb = document.createElement('div'); hb.className = 'ph-body';
    hb.innerHTML = `<div class="ph-name">${escapeHtml(p.author ? p.author.name : '—')}</div><div class="ph-time">${new Date(p.ts).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>`;
    head.appendChild(hb);
    if (p.author && p.author.id === me.id) { const d = document.createElement('button'); d.className = 'post-del'; d.textContent = '🗑'; d.onclick = () => { if (confirm('Удалить пост?')) socket.emit('deletePost', { id: p.id }); }; head.appendChild(d); }
    el.appendChild(head);
    if (p.text) { const t = document.createElement('div'); t.className = 'post-text'; t.textContent = p.text; el.appendChild(t); }
    if (p.photos && p.photos.length) {
      const g = document.createElement('div'); g.className = 'post-photos n' + Math.min(p.photos.length, 4);
      p.photos.forEach((u) => { const im = document.createElement('img'); im.src = u; im.loading = 'lazy'; im.onclick = () => openLightbox(u); g.appendChild(im); });
      el.appendChild(g);
    }
    const acts = document.createElement('div'); acts.className = 'post-actions';
    const like = document.createElement('button'); like.className = 'like-btn' + (p.liked ? ' liked' : '');
    like.innerHTML = `<span class="heart">${p.liked ? '❤️' : '🤍'}</span><span class="lc">${p.likes || 0}</span>`;
    like.onclick = () => { socket.emit('likePost', { id: p.id }); buzz(20); };
    acts.appendChild(like);
    const views = document.createElement('div'); views.className = 'post-views'; views.innerHTML = `👁 <span class="vc">${p.views || 0}</span>`;
    acts.appendChild(views);
    el.appendChild(acts);
    return el;
  }
  function prependPost(p) { const list = $('feed-list'); const empty = list.querySelector('.feed-empty'); if (empty) empty.remove(); list.prepend(postEl(p)); }
  function updatePostLikes(id, likes, liked, by) {
    document.querySelectorAll(`.post[data-id="${id}"] .like-btn`).forEach((btn) => {
      if (by === me.id) { btn.classList.toggle('liked', liked); btn.querySelector('.heart').textContent = liked ? '❤️' : '🤍'; }
      btn.querySelector('.lc').textContent = likes;
    });
  }

  // создание поста
  let postPhotos = [];
  $('feed-new').onclick = () => openPostComposer();
  function openPostComposer() {
    postPhotos = []; $('post-text').value = ''; $('post-error').textContent = ''; $('post-photos').innerHTML = '';
    $('post-modal').classList.remove('hidden');
  }
  $('post-add-photo').onclick = () => $('post-photo-input').click();
  $('post-photo-input').onchange = async (e) => {
    const files = [...e.target.files].slice(0, 10 - postPhotos.length); e.target.value = '';
    for (const f of files) { try { const { url } = await uploadImage(f); postPhotos.push(url); } catch (err) { toast('Ошибка фото: ' + err.message); } }
    renderPostPhotos();
  };
  function renderPostPhotos() {
    const box = $('post-photos'); box.innerHTML = '';
    postPhotos.forEach((u, i) => { const it = document.createElement('div'); it.className = 'pp-item'; const im = document.createElement('img'); im.src = u; it.appendChild(im); const d = document.createElement('button'); d.className = 'pp-del'; d.textContent = '✕'; d.onclick = () => { postPhotos.splice(i, 1); renderPostPhotos(); }; it.appendChild(d); box.appendChild(it); });
  }
  $('post-go').onclick = () => {
    const text = $('post-text').value.trim();
    if (!text && !postPhotos.length) { $('post-error').textContent = 'Напиши текст или добавь фото'; return; }
    socket.emit('createPost', { text, photos: postPhotos }, (r) => {
      if (r && r.ok) { $('post-modal').classList.add('hidden'); toast('Опубликовано'); if (!feedOpen) openFeed(); }
      else $('post-error').textContent = (r && r.error) || 'Ошибка';
    });
  };

  // стена в профиле
  $('pv-wall-btn').onclick = () => {
    const w = $('pv-wall');
    if (!w.classList.contains('hidden')) { w.classList.add('hidden'); $('pv-wall-btn').textContent = '📖 Стена'; return; }
    w.classList.remove('hidden'); w.innerHTML = '<div class="wall-empty">Загрузка…</div>';
    $('pv-wall-btn').textContent = '📖 Свернуть стену';
    socket.emit('wall', { userId: viewUser.id }, (posts) => {
      w.innerHTML = '';
      if (!posts || !posts.length) { w.innerHTML = '<div class="wall-empty">Пока нет постов</div>'; return; }
      for (const p of posts) w.appendChild(postEl(p));
    });
  };
  $('pv-report').onclick = () => { if (!viewUser) return; const reason = prompt('Причина жалобы на @' + viewUser.username + ':', 'спам'); if (reason !== null) { socket.emit('report', { targetType: 'user', targetId: viewUser.id, reason }); toast('Жалоба отправлена'); } };

  // ============ ОПРОС «СХОДКА» ============
  $('poll-add-opt').onclick = () => addPollOpt('');
  function addPollOpt(val) {
    const box = $('poll-opts'); if (box.children.length >= 10) return;
    const f = document.createElement('div'); f.className = 'field';
    f.innerHTML = `<input type="text" placeholder=" " maxlength="100"><label>Вариант ${box.children.length + 1}</label>`;
    f.querySelector('input').value = val; box.appendChild(f);
  }
  function openPoll() {
    if (!activeChat) return;
    $('poll-q').value = ''; $('poll-opts').innerHTML = ''; $('poll-error').textContent = '';
    addPollOpt(''); addPollOpt('');
    $('poll-modal').classList.remove('hidden');
  }
  $('poll-go').onclick = () => {
    const question = $('poll-q').value.trim();
    const options = [...$('poll-opts').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
    if (!question) { $('poll-error').textContent = 'Введи вопрос'; return; }
    if (options.length < 2) { $('poll-error').textContent = 'Нужно минимум 2 варианта'; return; }
    emitSend({ chatId: activeChat, type: 'poll', media: { question, options } }, () => {});
    $('poll-modal').classList.add('hidden');
  };

  // ============ ШПАРГАЛКА ============
  $('set-help').onclick = () => { $('settings-modal').classList.add('hidden'); openHelp(); };
  const HELP = [
    ['Сообщения', [
      ['↩', 'Ответить и переслать', 'Правый клик (или долгий тап) по сообщению → «Ответить» или «Переслать».'],
      ['😀', 'Реакции', 'В том же меню — ряд эмодзи. Тапни, чтобы поставить/снять.'],
      ['✎', 'Изменить / 🗑 удалить у всех', 'Своё сообщение можно отредактировать или стереть у всех. Собеседник видит «стирает…».'],
      ['📌', 'Закрепить', 'Важное сообщение закрепляется вверху чата.'],
      ['🔥', 'Исчезающее', 'Скрепка → «Исчезающее»: сообщение само удалится через заданное время.'],
      ['⏱', 'По таймеру', 'Скрепка → «По таймеру»: напиши текст и выбери, когда он уйдёт.'],
    ]],
    ['Вложения', [
      ['🖼', 'Фото и альбомы', 'Скрепка → «Фото». Выбери несколько — уйдут альбомом.'],
      ['📎', 'Файлы', 'Любой файл до 40 МБ.'],
      ['🎤', 'Голосовые', 'Кнопка-микрофон — запись с волной и перемоткой.'],
      ['⭕', 'Кружки', 'Кнопка-кружок — видеосообщение с камеры (как в Telegram).'],
      ['📍', 'Геолокация', 'Скрепка → «Геолокация» — отправит твою точку на карте.'],
      ['📊', 'Опрос «Сходка»', 'Скрепка → «Опрос». Вече голосует — кто за что.'],
    ]],
    ['Группы и каналы', [
      ['👥', 'Группы', 'Кнопка ＋ → «Группа». Добавляй людей, назначай админов, управляй участниками.'],
      ['📣', 'Каналы', 'Кнопка ＋ → «Канал». Пишут только админы, остальные читают.'],
      ['🔕', 'Мут', 'Колокольчик в шапке чата — отключить уведомления. В настройках — все новые чаты сразу без звука.'],
    ]],
    ['Лента и стена', [
      ['📰', 'Лента', 'Иконка газеты вверху — посты всех, как в Инсте. Лайкай ❤️, публикуй своё через ✎.'],
      ['📖', 'Стена', 'В профиле человека — кнопка «Стена»: его посты, фото, лайки. По-минимуму, пока не раскроешь.'],
    ]],
    ['Приватность и безопасность', [
      ['👻', 'Режим «Призрак»', 'Тебя не найти по @нику. Видят только те, с кем уже есть переписка, и только когда ты онлайн. Полная невидимость.'],
      ['🔒', 'Закрытый профиль', 'Незнакомые не смогут написать первыми (как в ВК).'],
      ['👁', 'Скрыть «в сети»', 'Никто не видит, когда ты онлайн и когда был.'],
      ['✏️', 'Свой статус', 'В настройках можно задать любой статус вместо «в сети».'],
      ['⚠', 'Жалобы и антиспам', 'Жалоба — в профиле человека. Реклама и флуд режутся автоматически.'],
      ['🚫', 'Блокировка', 'В профиле — заблокировать, чтобы человек не мог писать и не видел твои посты.'],
    ]],
  ];
  function openHelp() {
    const body = $('help-body'); body.innerHTML = '';
    for (const [cat, items] of HELP) {
      const h = document.createElement('div'); h.className = 'help-cat'; h.textContent = cat; body.appendChild(h);
      for (const [ic, title, desc] of items) {
        const it = document.createElement('div'); it.className = 'help-item';
        it.innerHTML = `<div class="help-ic">${ic}</div><div><b>${title}</b><p>${desc}</p></div>`;
        body.appendChild(it);
      }
    }
    $('help-modal').classList.remove('hidden');
  }

  // ============ ИГРЫ ============
  let gameType = 'ttt', gameWins = 1;
  function openGameModal() { if (!activeChat || !isDM(activeChat)) return toast('Игры доступны в личной переписке'); $('game-modal').classList.remove('hidden'); }
  document.querySelectorAll('#game-modal [data-game]').forEach((b) => b.onclick = () => { gameType = b.dataset.game; document.querySelectorAll('#game-modal [data-game]').forEach((x) => x.classList.toggle('sel', x === b)); });
  document.querySelectorAll('#game-modal [data-wins]').forEach((b) => b.onclick = () => { gameWins = +b.dataset.wins; document.querySelectorAll('#game-modal [data-wins]').forEach((x) => x.classList.toggle('sel', x === b)); });
  $('game-go').onclick = () => { $('game-modal').classList.add('hidden'); socket.emit('game:create', { chatId: activeChat, type: gameType, wins: gameWins }, (r) => { if (r && r.error) toast(r.error); }); };

  const RPS_EMOJI = { rock: '✊', scissors: '✌️', paper: '✋' };
  const DICE_FACE = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
  const GAME_NAMES = { ttt: '⭕ Крестики-нолики', c4: '🔴 4 в ряд', rps: '✊✌️✋ Камень-ножницы', dice: '🎲 Кости' };
  function buildGame(m) {
    const g = m.media, s = g.state, me2 = me.id, iAmIn = g.players.includes(me2);
    const wrap = document.createElement('div'); wrap.className = 'game';
    const title = document.createElement('div'); title.className = 'game-title'; title.textContent = GAME_NAMES[g.game] || 'Игра'; wrap.appendChild(title);
    if (s.target > 1) {
      const sc = document.createElement('div'); sc.className = 'game-score';
      const meScore = s.scores[me2] || 0, peerScore = (s.scores[g.players.find((p) => p !== me2)] || 0);
      sc.innerHTML = iAmIn ? `до ${s.target} побед · ты <b>${meScore}</b> : <b>${peerScore}</b> соперник` : `до ${s.target} побед · <b>${s.scores[g.players[0]] || 0}</b> : <b>${s.scores[g.players[1]] || 0}</b>`;
      wrap.appendChild(sc);
    }

    if (g.game === 'ttt' || g.game === 'c4') {
      const cols = g.game === 'c4' ? 7 : 3, mark = s.marks && s.marks[me2];
      const board = document.createElement('div'); board.className = g.game === 'c4' ? 'c4-board' : 'ttt-board';
      const myTurn = !s.matchWinner && !s.roundWinner && s.turn === me2 && iAmIn;
      if (g.game === 'c4' && myTurn) board.classList.add('mine');
      s.board.forEach((cell, i) => {
        const b = document.createElement('button');
        if (g.game === 'c4') { b.className = 'c4-cell' + (cell ? ' ' + cell : ''); b.disabled = !myTurn; b.onclick = () => socket.emit('game:move', { id: m.id, move: i % 7 }); }
        else { b.className = 'ttt-cell' + (cell === 'X' ? ' x' : cell === 'O' ? ' o' : ''); b.textContent = cell || ''; b.disabled = !!cell || !myTurn; b.onclick = () => socket.emit('game:move', { id: m.id, move: i }); }
        board.appendChild(b);
      });
      wrap.appendChild(board);
      wrap.appendChild(gameStatus(s, me2, iAmIn, () => s.turn === me2 ? ('твой ход' + (mark && g.game === 'ttt' ? ' (' + mark + ')' : '')) : 'ход соперника…'));
    } else if (g.game === 'rps') {
      const myChoice = s.choices[me2];
      if (s.reveal) {
        const rev = document.createElement('div'); rev.className = 'rps-reveal';
        rev.textContent = (RPS_EMOJI[s.choices[g.players[0]]] || '?') + ' vs ' + (RPS_EMOJI[s.choices[g.players[1]]] || '?');
        wrap.appendChild(rev);
      } else {
        const ch = document.createElement('div'); ch.className = 'rps-choices';
        for (const k of ['rock', 'scissors', 'paper']) { const b = document.createElement('button'); b.className = 'rps-btn' + (myChoice === k ? ' chosen' : ''); b.textContent = RPS_EMOJI[k]; b.disabled = !iAmIn || !!myChoice || s.roundWinner; b.onclick = () => socket.emit('game:move', { id: m.id, move: k }); ch.appendChild(b); }
        wrap.appendChild(ch);
      }
      wrap.appendChild(gameStatus(s, me2, iAmIn, () => myChoice ? 'ждём соперника…' : 'выбери свой ход'));
    } else if (g.game === 'dice') {
      const area = document.createElement('div'); area.className = 'dice-area';
      const mine = s.rolls[me2], peerId = g.players.find((p) => p !== me2), peerRoll = s.rolls[peerId];
      const myFace = document.createElement('div'); myFace.className = mine ? 'dice-face' : 'dice-q'; myFace.textContent = mine ? DICE_FACE[mine] : '?'; area.appendChild(myFace);
      const vs = document.createElement('div'); vs.style.cssText = 'align-self:center;opacity:.6'; vs.textContent = 'vs'; area.appendChild(vs);
      const pFace = document.createElement('div'); pFace.className = (s.reveal && peerRoll) ? 'dice-face' : 'dice-q'; pFace.textContent = (s.reveal && peerRoll) ? DICE_FACE[peerRoll] : '?'; area.appendChild(pFace);
      wrap.appendChild(area);
      if (iAmIn && !mine && !s.matchWinner && !s.roundWinner) { const rb = document.createElement('button'); rb.className = 'dice-roll-btn'; rb.textContent = '🎲 Бросить'; rb.onclick = () => socket.emit('game:move', { id: m.id, move: 'roll' }); wrap.appendChild(rb); }
      else wrap.appendChild(gameStatus(s, me2, iAmIn, () => mine ? 'ждём соперника…' : 'бросай кости'));
    }
    return wrap;
  }
  function gameStatus(s, me2, iAmIn, activeFn) {
    const st = document.createElement('div'); st.className = 'game-status';
    if (s.matchWinner) { st.className = 'game-status win'; st.textContent = s.matchWinner === me2 ? '🏆 Ты выиграл матч!' : 'Соперник выиграл матч 😅'; }
    else if (s.roundWinner === 'draw') { st.textContent = 'Раунд — ничья 🤝 новый раунд…'; }
    else if (s.roundWinner) { st.className = 'game-status win'; st.textContent = (s.roundWinner === me2 ? 'Раунд твой! 🎉' : 'Раунд соперника 😅') + ' новый раунд…'; }
    else if (!iAmIn) st.textContent = 'идёт игра…';
    else st.textContent = activeFn();
    return st;
  }

  // ============ ЗВОНКИ (WebRTC) ============
  let pc = null, localStream = null, callPeer = null, callState = null; // 'outgoing'|'incoming'|'active'
  let callTimer = null, callStart = 0, pendingOffer = null, ringTone = null;
  let speakerOn = false; // false = слуховой динамик (к уху, тихий), true = громкий нижний динамик
  const callScreen = $('call-screen');

  // ---- маршрут звука звонка: по умолчанию верхний слуховой, кнопка — громкий динамик ----
  async function listAudioOutputs() {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
    } catch { return []; }
  }
  function nativeAudio() { return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.AudioRoute; }
  async function applyAudioOutput() {
    $('call-speaker').classList.toggle('on', speakerOn);
    // в нативном приложении (APK) — настоящий контроль звука через Android AudioManager
    const AR = nativeAudio();
    if (AR) { try { await AR.setSpeaker({ on: speakerOn }); } catch {} return; }
    const el = $('remote-audio');
    if (!el || typeof el.setSinkId !== 'function') return; // iOS Safari в браузере: маршрут выбирает сама система
    const outs = await listAudioOutputs();
    const speakerRe = /speaker|loud|громк|динамик/i;
    const earRe = /earpiece|receiver|handset|слух|разговор|телефон|phone/i;
    let target = speakerOn
      ? outs.find((o) => speakerRe.test(o.label))
      : outs.find((o) => earRe.test(o.label) && !speakerRe.test(o.label));
    try { await el.setSinkId(target ? target.deviceId : 'default'); } catch {}
    try { await el.play(); } catch {}
  }
  $('call-speaker').onclick = () => { speakerOn = !speakerOn; buzz(15); applyAudioOutput(); };

  function setCallUI(state, name, avatarUser, statusText) {
    callScreen.classList.remove('hidden');
    callScreen.classList.toggle('ringing', state !== 'active');
    paintAvatar($('call-avatar'), { avatar: avatarUser && avatarUser.avatar, name: name, colors: avatarUser && avatarUser.colors }, 48);
    $('call-name').textContent = name || '';
    $('call-status').textContent = statusText || '';
    $('call-incoming-controls').classList.toggle('hidden', state !== 'incoming');
    $('call-controls').classList.toggle('hidden', state === 'incoming');
  }

  function newPC() {
    const p = new RTCPeerConnection({ iceServers: iceConfig });
    p.onicecandidate = (e) => { if (e.candidate && callPeer) socket.emit('call:ice', { to: callPeer, candidate: e.candidate }); };
    p.ontrack = (e) => { $('remote-audio').srcObject = e.streams[0]; applyAudioOutput(); };
    p.onconnectionstatechange = () => { if (p.connectionState === 'connected') onCallConnected(); if (['failed', 'disconnected', 'closed'].includes(p.connectionState)) {} };
    return p;
  }

  $('btn-call').onclick = (e) => { e.stopPropagation(); if (isDM(activeChat)) startCall(peerIdOf(activeChat)); };
  async function startCall(peerId) {
    if (callState) return;
    const peer = users.get(peerId);
    callPeer = peerId; callState = 'outgoing';
    setCallUI('outgoing', peer ? peer.name : '', peer, 'звоним…');
    playRing(true);
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 } }); }
    catch { endCall('Нет доступа к микрофону'); return; }
    socket.emit('getIce', (srv) => { if (srv && srv.length) iceConfig = srv; });
    pc = newPC();
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    socket.emit('call:offer', { to: peerId, sdp: offer });
  }

  function onCallIncoming({ from, name, avatar, colors, sdp }) {
    if (callState) { socket.emit('call:decline', { to: from }); return; } // занят
    callPeer = from; callState = 'incoming'; pendingOffer = sdp;
    setCallUI('incoming', name, { avatar, colors }, 'входящий звонок…');
    playRing(true);
  }
  $('call-accept').onclick = async () => {
    if (callState !== 'incoming') return;
    playRing(false);
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000, channelCount: 1 } }); }
    catch { endCall('Нет доступа к микрофону'); return; }
    socket.emit('getIce', (srv) => { if (srv && srv.length) iceConfig = srv; });
    pc = newPC();
    localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
    await pc.setRemoteDescription(new RTCSessionDescription(pendingOffer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('call:answer', { to: callPeer, sdp: answer });
    callState = 'active'; setCallUI('active', $('call-name').textContent, null, 'соединение…');
    flushIce();
  };
  $('call-decline').onclick = () => { socket.emit('call:decline', { to: callPeer }); endCall('Отклонён'); };
  $('call-hang').onclick = () => { socket.emit(callState === 'outgoing' ? 'call:cancel' : 'call:end', { to: callPeer }); endCall('Завершён'); };

  async function onCallAnswered({ sdp }) {
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    callState = 'active'; flushIce();
  }
  let iceQueue = [];
  function onCallIce({ candidate }) {
    if (pc && pc.remoteDescription) pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
    else iceQueue.push(candidate);
  }
  function flushIce() { for (const c of iceQueue) pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}); iceQueue = []; }

  function onCallConnected() {
    if (callTimer) return;
    playRing(false);
    const AR = nativeAudio(); if (AR) { try { AR.startCall(); } catch {} } // нативный режим разговора
    speakerOn = false; applyAudioOutput(); // старт через верхний слуховой динамик
    callStart = Date.now();
    callTimer = setInterval(() => { $('call-status').textContent = fmtDur((Date.now() - callStart) / 1000); }, 500);
  }
  let muted = false;
  $('call-mute').onclick = () => {
    if (!localStream) return; muted = !muted;
    localStream.getAudioTracks().forEach((t) => t.enabled = !muted);
    $('call-mute').classList.toggle('off', muted);
  };
  function endCall(reason) {
    playRing(false);
    const AR = nativeAudio(); if (AR) { try { AR.endCall(); } catch {} } // вернуть обычный режим звука
    if (callTimer) { clearInterval(callTimer); callTimer = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    iceQueue = []; pendingOffer = null; muted = false; $('call-mute').classList.remove('off');
    speakerOn = false; $('call-speaker').classList.remove('on');
    callPeer = null; callState = null;
    if (reason) { $('call-status').textContent = reason; setTimeout(() => callScreen.classList.add('hidden'), 800); }
    else callScreen.classList.add('hidden');
  }
  function playRing(on) {
    try {
      if (on) {
        if (ringTone) return;
        const ctx = audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        ringTone = setInterval(() => { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = 480; g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.05); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5); o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.5); }, 1500);
      } else if (ringTone) { clearInterval(ringTone); ringTone = null; }
    } catch {}
  }

  // ============ АДМИН: модерация ============
  $('btn-admin').onclick = openAdmin;
  function openAdmin() {
    $('admin-body').innerHTML = '<div class="admin-empty">Загрузка…</div>';
    $('admin-modal').classList.remove('hidden');
    socket.emit('getReports', (r) => {
      if (!r || !r.ok) { $('admin-body').innerHTML = '<div class="admin-empty">Нет доступа</div>'; return; }
      const body = $('admin-body'); body.innerHTML = '';
      const open = r.reports.filter((x) => x.status === 'open');
      if (!open.length) { body.innerHTML = '<div class="admin-empty">Жалоб нет 👍<br>Сюда приходят все жалобы пользователей.</div>'; }
      for (const rep of r.reports) body.appendChild(repEl(rep));
    });
  }
  function repEl(rep) {
    const el = document.createElement('div'); el.className = 'rep' + (rep.status === 'closed' ? ' closed' : '');
    const when = new Date(rep.ts).toLocaleString('ru', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const tgt = rep.targetType === 'user' ? 'на пользователя' : 'на сообщение';
    el.innerHTML = `<div class="rep-top"><span>${escapeHtml(rep.byName || 'кто-то')} пожаловался ${tgt}</span><span>${when}</span></div>
      <div class="rep-body"><b>${escapeHtml(rep.targetName || '—')}</b> · причина: ${escapeHtml(rep.reason || '—')}</div>
      ${rep.excerpt ? `<div class="rep-excerpt">«${escapeHtml(rep.excerpt)}»</div>` : ''}`;
    if (rep.status === 'open') {
      const acts = document.createElement('div'); acts.className = 'rep-actions';
      const targetUserId = rep.targetType === 'user' ? rep.targetId : rep.authorId;
      if (targetUserId) {
        const ban = document.createElement('button'); ban.className = 'ban'; ban.textContent = rep.targetBanned ? 'Разбанить' : 'Забанить';
        ban.onclick = () => socket.emit('banUser', { userId: targetUserId, on: !rep.targetBanned }, (x) => { if (x && x.ok) { toast(x.banned ? 'Забанен' : 'Разбанен'); openAdmin(); } else toast((x && x.error) || 'Ошибка'); });
        acts.appendChild(ban);
      }
      if (rep.targetType === 'msg') { const del = document.createElement('button'); del.textContent = 'Удалить сообщение'; del.onclick = () => socket.emit('deleteAnyMsg', { id: rep.targetId }, () => toast('Удалено')); acts.appendChild(del); }
      const dis = document.createElement('button'); dis.textContent = 'Отклонить'; dis.onclick = () => socket.emit('dismissReport', { id: rep.id }, () => openAdmin()); acts.appendChild(dis);
      el.appendChild(acts);
    }
    return el;
  }

  // ============ ВИБРАЦИЯ / тактильная отдача ============
  function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {} }

  // ============ WEB PUSH ============
  function urlBase64ToUint8Array(b64) {
    const pad = '='.repeat((4 - b64.length % 4) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }

  async function getPushReg() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    return navigator.serviceWorker.ready;
  }

  async function syncPushToggle() {
    const btn = $('set-push');
    if (!btn) return;
    const reg = await getPushReg().catch(() => null);
    if (!reg) { btn.checked = false; btn.disabled = true; return; }
    const sub = await reg.pushManager.getSubscription().catch(() => null);
    btn.checked = !!sub;
  }

  async function ensurePushSubscription(silent) {
    try {
      const reg = await getPushReg();
      if (!reg) return;
      // уже подписаны?
      const existing = await reg.pushManager.getSubscription();
      if (existing) return;
      // Запрашиваем разрешение
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { if (!silent) toast('Разрешите уведомления в браузере'); return; }
      // Получаем VAPID public key
      const kr = await fetch('/api/push/keys');
      if (!kr.ok) return;
      const { publicKey } = await kr.json();
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(sub.toJSON()),
      });
      if (!silent) toast('🔔 Уведомления включены');
    } catch (e) { if (!silent) toast('Не удалось включить уведомления'); console.warn('push:', e); }
  }

  async function disablePush() {
    try {
      const reg = await getPushReg();
      if (!reg) return;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ endpoint }),
      });
    } catch {}
  }

  // Входящий звонок пока приложение было закрыто — проверяем при открытии
  async function checkPendingCall() {
    if (!token) return;
    try {
      const r = await fetch('/api/call/pending', { headers: { 'Authorization': 'Bearer ' + token } });
      if (!r.ok) return;
      const { call } = await r.json();
      if (call && !callState) onCallIncoming({ from: call.from, name: call.name, avatar: call.avatar, colors: call.colors, sdp: call.sdp });
    } catch {}
  }

  // Сообщения от Service Worker (клик по уведомлению когда приложение открыто)
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      const { type: mtype, chatId: mchatId, callFrom } = e.data || {};
      if (mtype === 'open_chat') {
        if (callFrom) checkPendingCall();
        else if (mchatId) openChat(mchatId);
      }
    });
  }

  // Открыть чат из URL-параметра ?open=chatId (после клика на push когда приложение было закрыто)
  try {
    const urlParams = new URLSearchParams(location.search);
    const openChatId = urlParams.get('open');
    const pendingCallParam = urlParams.get('pending_call');
    if (openChatId || pendingCallParam) history.replaceState(null, '', location.pathname);
    if (openChatId && !routeChat) routeChat = openChatId;
    // pending_call обрабатывается в checkPendingCall() после init
  } catch {}

  // ============ СЖАТИЕ ФОТО перед загрузкой ============
  function compressImage(file, max = 1600, q = 0.82) {
    return new Promise((resolve) => {
      if (!file.type || !file.type.startsWith('image/') || file.type === 'image/gif') return resolve({ blob: file, mime: file.type, name: file.name });
      const img = new Image(); const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.width, h = img.height;
        if (w > max || h > max) { const r = Math.min(max / w, max / h); w = Math.round(w * r); h = Math.round(h * r); }
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        cv.toBlob((b) => {
          if (b && b.size < file.size) resolve({ blob: b, mime: 'image/jpeg', name: (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg' });
          else resolve({ blob: file, mime: file.type, name: file.name });
        }, 'image/jpeg', q);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve({ blob: file, mime: file.type, name: file.name }); };
      img.src = url;
    });
  }
  async function uploadImage(file) { const c = await compressImage(file); return upload(c.blob, c.mime, c.name); }

  // ============ СТАРТ ============
  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) connect(saved);
  setAuthMode('login');
})();
