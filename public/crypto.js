// ================================================================
//  ВЕЧЕ · Сквозное шифрование (E2EE) для секретных 1-на-1 чатов
// ----------------------------------------------------------------
//  Весь криптокод — в одном файле, специально, чтобы его можно было
//  прочитать и проверить целиком. Никакой самодельной криптографии:
//  только стандартный Web Crypto API браузера.
//
//  Схема (ECIES поверх ECDH P-256 + AES-256-GCM):
//   • у каждого пользователя — долговременная пара ключей ECDH.
//     ПРИВАТНЫЙ ключ несекретируемый (non-extractable) и лежит
//     в IndexedDB: его нельзя ВЫГРУЗИТЬ (exportKey на нём упадёт),
//     он не уходит на сервер и не покидает устройство.
//     ⚠️ Но это защита от КРАЖИ ключа, а не от его ИСПОЛЬЗОВАНИЯ:
//     любой JS на странице — в том числе внедрённый через XSS или
//     подменённый скомпрометированным сервером — может этим ключом
//     расшифровывать. Публичный ключ отправляется на сервер.
//   • на каждое сообщение генерируется РАЗОВЫЙ (эфемерный) ключ →
//     общий секрет с получателем → HKDF → ключ-обёртка (KEK).
//   • содержимое шифруется случайным ключом сообщения (MK, AES-GCM),
//     а MK «заворачивается» отдельно для каждого получателя (и для
//     самого автора, чтобы он тоже видел свои сообщения).
//
//  Сервер хранит и пересылает ТОЛЬКО шифротекст: без приватного
//  ключа получателя расшифровать его нельзя.
// ================================================================
(() => {
  'use strict';
  const subtle = (window.crypto && window.crypto.subtle) || null;
  const DB_NAME = 'veche-e2e';
  const STORE = 'keys';
  const KEY_ID = 'identity';
  const HKDF_INFO = new TextEncoder().encode('veche-e2e-v1');

  let myKeyPair = null;   // CryptoKeyPair (приватный — non-extractable)
  let myPubB64 = null;    // публичный ключ (base64, raw)
  let myId = null;        // мой userId — по нему ищем «свою» обёртку MK

  // ── base64 ↔ bytes ──
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const enc = new TextEncoder(), dec = new TextDecoder();

  // ── IndexedDB (храним пару ключей как есть; приватный не выгружается) ──
  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const tx = req.result.transaction(STORE, mode);
        const st = tx.objectStore(STORE);
        const r = fn(st);
        tx.oncomplete = () => resolve(r && r.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }

  async function importPub(raw) {
    return subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  }

  // общий секрет → HKDF → AES-GCM ключ (KEK), salt = публичный эфемерный ключ
  async function deriveKEK(privKey, peerPub, ephPubRaw, usage) {
    const bits = await subtle.deriveBits({ name: 'ECDH', public: peerPub }, privKey, 256);
    const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: ephPubRaw, info: HKDF_INFO },
      hk, { name: 'AES-GCM', length: 256 }, false, usage,
    );
  }

  const VecheCrypto = {
    available() { return !!(subtle && window.indexedDB && window.isSecureContext); },
    setMyId(id) { myId = id; },

    // создать (или загрузить) свою пару ключей; вернуть публичный ключ (base64)
    async ensureIdentity() {
      if (!this.available()) throw new Error('crypto unavailable');
      if (myPubB64) return myPubB64;
      let pair = await idb('readonly', (st) => st.get(KEY_ID)).catch(() => null);
      if (!pair) {
        pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey', 'deriveBits']);
        // приватный ключ non-extractable → в IndexedDB попадёт как «непрочитываемый» CryptoKey
        await idb('readwrite', (st) => st.put(pair, KEY_ID));
      }
      myKeyPair = pair;
      myPubB64 = b64(await subtle.exportKey('raw', pair.publicKey));
      return myPubB64;
    },

    async myPublicKey() { return myPubB64 || this.ensureIdentity(); },

    // зашифровать строку для набора получателей [{id, pub(base64)}], включая себя
    async encrypt(plaintext, recipients) {
      const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits', 'deriveKey']);
      const ephPubRaw = await subtle.exportKey('raw', eph.publicKey);

      // случайный ключ сообщения (MK) + шифрование содержимого
      const mkRaw = window.crypto.getRandomValues(new Uint8Array(32));
      const mk = await subtle.importKey('raw', mkRaw, 'AES-GCM', false, ['encrypt']);
      const ctIv = window.crypto.getRandomValues(new Uint8Array(12));
      const ct = await subtle.encrypt({ name: 'AES-GCM', iv: ctIv }, mk, enc.encode(plaintext));

      // обёртка MK для каждого получателя
      const keys = {};
      for (const r of recipients) {
        if (!r || !r.id || !r.pub) continue;
        const kek = await deriveKEK(eph.privateKey, await importPub(unb64(r.pub)), ephPubRaw, ['encrypt']);
        const wkIv = window.crypto.getRandomValues(new Uint8Array(12));
        const wk = await subtle.encrypt({ name: 'AES-GCM', iv: wkIv }, kek, mkRaw);
        keys[r.id] = { iv: b64(wkIv), wk: b64(wk) };
      }
      return { v: 1, ephPub: b64(ephPubRaw), iv: b64(ctIv), ct: b64(ct), keys };
    },

    // расшифровать объект enc «своим» приватным ключом
    async decrypt(e) {
      if (!e || !e.keys || !myKeyPair) return null;
      const mine = e.keys[myId];
      if (!mine) return null;
      const ephPubRaw = unb64(e.ephPub);
      const kek = await deriveKEK(myKeyPair.privateKey, await importPub(ephPubRaw), ephPubRaw, ['decrypt']);
      const mkRaw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(mine.iv) }, kek, unb64(mine.wk));
      const mk = await subtle.importKey('raw', mkRaw, 'AES-GCM', false, ['decrypt']);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, mk, unb64(e.ct));
      return dec.decode(pt);
    },

    // зашифровать бинарные данные (фото/голос) → {header, cipher: Uint8Array}
    async encryptBytes(bytes, recipients) {
      const eph = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits', 'deriveKey']);
      const ephPubRaw = await subtle.exportKey('raw', eph.publicKey);
      const mkRaw = window.crypto.getRandomValues(new Uint8Array(32));
      const mk = await subtle.importKey('raw', mkRaw, 'AES-GCM', false, ['encrypt']);
      const ctIv = window.crypto.getRandomValues(new Uint8Array(12));
      const cipher = await subtle.encrypt({ name: 'AES-GCM', iv: ctIv }, mk, bytes);
      const keys = {};
      for (const r of recipients) {
        if (!r || !r.id || !r.pub) continue;
        const kek = await deriveKEK(eph.privateKey, await importPub(unb64(r.pub)), ephPubRaw, ['encrypt']);
        const wkIv = window.crypto.getRandomValues(new Uint8Array(12));
        const wk = await subtle.encrypt({ name: 'AES-GCM', iv: wkIv }, kek, mkRaw);
        keys[r.id] = { iv: b64(wkIv), wk: b64(wk) };
      }
      return { header: { v: 1, ephPub: b64(ephPubRaw), iv: b64(ctIv), keys }, cipher: new Uint8Array(cipher) };
    },

    async decryptBytes(header, cipherBytes) {
      const mine = header && header.keys && header.keys[myId];
      if (!mine || !myKeyPair) return null;
      const ephPubRaw = unb64(header.ephPub);
      const kek = await deriveKEK(myKeyPair.privateKey, await importPub(ephPubRaw), ephPubRaw, ['decrypt']);
      const mkRaw = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(mine.iv) }, kek, unb64(mine.wk));
      const mk = await subtle.importKey('raw', mkRaw, 'AES-GCM', false, ['decrypt']);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(header.iv) }, mk, cipherBytes);
      return new Uint8Array(pt);
    },

    // «код сверки»: детерминированный отпечаток пары публичных ключей.
    // Совпал у обоих — значит между вами нет посредника (сервер не подменил ключ).
    async safetyNumber(pubA, pubB) {
      const [x, y] = [pubA, pubB].sort();
      const h = await subtle.digest('SHA-256', concat(unb64(x), unb64(y)));
      const bytes = new Uint8Array(h);
      let out = '';
      for (let i = 0; i < 15; i++) out += (((bytes[i * 2] << 8) | bytes[i * 2 + 1]) % 100000).toString().padStart(5, '0') + (i % 3 === 2 ? '\n' : ' ');
      return out.trim();
    },
  };

  function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

  window.VecheCrypto = VecheCrypto;
})();
