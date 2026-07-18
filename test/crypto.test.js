// Тесты сквозного шифрования ВЕЧЕ (public/crypto.js).
// Запуск: npm test   (нужен Node 18+, никаких дополнительных зависимостей)
//
// crypto.js написан для браузера, поэтому здесь мы поднимаем минимальное
// окружение: подставляем Web Crypto из Node и простую заглушку IndexedDB.
// Каждый «пользователь» получает свой экземпляр модуля со своей парой ключей —
// это честно моделирует разные устройства.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

const CRYPTO_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'crypto.js'),
  'utf8',
);

// ── заглушка IndexedDB в памяти (ровно под контракт idb() из crypto.js) ──
function makeFakeIndexedDB() {
  const dbs = new Map(); // dbName -> Map(storeName -> Map)

  return {
    open(name) {
      const req = {
        result: null,
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
      };
      const isNew = !dbs.has(name);
      if (isNew) dbs.set(name, new Map());

      req.result = {
        createObjectStore(storeName) {
          dbs.get(name).set(storeName, new Map());
          return {};
        },
        transaction(storeName, _mode) {
          const tx = { oncomplete: null, onerror: null, error: null };
          tx.objectStore = () => {
            const data = dbs.get(name).get(storeName);
            const done = (result) => {
              const r = { result };
              // oncomplete назначается уже ПОСЛЕ вызова get/put — поэтому асинхронно
              setTimeout(() => tx.oncomplete && tx.oncomplete(), 0);
              return r;
            };
            return {
              get: (key) => done(data.get(key)),
              put: (value, key) => {
                data.set(key, value);
                return done(key);
              },
            };
          };
          return tx;
        },
      };

      setTimeout(() => {
        if (isNew && req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess();
      }, 0);

      return req;
    },
  };
}

// Загружаем crypto.js в свежем замыкании → отдельная «личность» со своими ключами.
function newIdentity() {
  const window = {
    crypto: webcrypto,
    isSecureContext: true,
    indexedDB: makeFakeIndexedDB(),
  };
  const factory = new Function(
    'window', 'indexedDB', 'btoa', 'atob', 'TextEncoder', 'TextDecoder',
    CRYPTO_SRC + '\nreturn window.VecheCrypto;',
  );
  return factory(
    window, window.indexedDB, btoa, atob, TextEncoder, TextDecoder,
  );
}

async function makeUser(id) {
  const vc = newIdentity();
  vc.setMyId(id);
  const pub = await vc.ensureIdentity();
  return { id, pub, vc };
}

test('ключи создаются, приватный не выгружается наружу', async () => {
  const alice = await makeUser('alisa');
  assert.ok(alice.pub && alice.pub.length > 0, 'публичный ключ должен быть строкой base64');
  // повторный вызов возвращает тот же ключ, а не создаёт новый
  const again = await alice.vc.myPublicKey();
  assert.strictEqual(again, alice.pub, 'ключ должен быть стабильным между вызовами');
});

test('получатель расшифровывает сообщение отправителя', async () => {
  const alice = await makeUser('alisa');
  const bob = await makeUser('boris');
  const secret = 'Пароль от сейфа: 4291';

  const box = await alice.vc.encrypt(secret, [
    { id: bob.id, pub: bob.pub },
    { id: alice.id, pub: alice.pub },
  ]);

  assert.strictEqual(await bob.vc.decrypt(box), secret);
});

test('отправитель может прочитать собственное сообщение', async () => {
  const alice = await makeUser('alisa');
  const bob = await makeUser('boris');
  const secret = 'Привет из секретного чата';

  const box = await alice.vc.encrypt(secret, [
    { id: bob.id, pub: bob.pub },
    { id: alice.id, pub: alice.pub },
  ]);

  assert.strictEqual(await alice.vc.decrypt(box), secret);
});

test('посторонний не может расшифровать', async () => {
  const alice = await makeUser('alisa');
  const bob = await makeUser('boris');
  const eve = await makeUser('eva');

  const box = await alice.vc.encrypt('только для Бориса', [
    { id: bob.id, pub: bob.pub },
    { id: alice.id, pub: alice.pub },
  ]);

  // Ева не в списке получателей — для неё нет обёртки ключа
  assert.strictEqual(await eve.vc.decrypt(box), null);
});

test('подмена личности не помогает: чужой ключ не расшифрует обёртку', async () => {
  const alice = await makeUser('alisa');
  const bob = await makeUser('boris');

  const box = await alice.vc.encrypt('только для Бориса', [
    { id: bob.id, pub: bob.pub },
    { id: alice.id, pub: alice.pub },
  ]);

  // Ева выдаёт себя за Бориса (берёт его id), но ключ у неё свой
  const eve = newIdentity();
  eve.setMyId(bob.id);
  await eve.ensureIdentity();

  await assert.rejects(
    () => eve.vc ? eve.vc.decrypt(box) : eve.decrypt(box),
    'расшифровка чужим ключом должна падать, а не возвращать текст',
  );
});

test('в шифротексте нет исходного текста', async () => {
  const alice = await makeUser('alisa');
  const bob = await makeUser('boris');
  const secret = 'СверхсекретнаяСтрокаДляПоиска';

  const box = await alice.vc.encrypt(secret, [
    { id: bob.id, pub: bob.pub },
    { id: alice.id, pub: alice.pub },
  ]);

  assert.strictEqual(box.v, 1);
  assert.ok(box.ephPub && box.iv && box.ct, 'структура шифроблока');

  const dump = JSON.stringify(box);
  assert.ok(!dump.includes(secret), 'открытый текст не должен встречаться в шифроблоке');

  const raw = Buffer.from(box.ct, 'base64').toString('utf8');
  assert.ok(!raw.includes(secret), 'открытый текст не должен встречаться в расшифрованном виде в ct');
});

test('каждое сообщение шифруется новым ключом (разные шифротексты)', async () => {
  const alice = await makeUser('alisa');
  const bob = await makeUser('boris');
  const recips = [{ id: bob.id, pub: bob.pub }, { id: alice.id, pub: alice.pub }];

  const a = await alice.vc.encrypt('одно и то же', recips);
  const b = await alice.vc.encrypt('одно и то же', recips);

  assert.notStrictEqual(a.ct, b.ct, 'шифротексты одинакового текста должны различаться');
  assert.notStrictEqual(a.ephPub, b.ephPub, 'эфемерный ключ должен быть новым на каждое сообщение');
});

test('код сверки одинаков у обеих сторон и не зависит от порядка', async () => {
  const alice = await makeUser('alisa');
  const bob = await makeUser('boris');

  const fromAlice = await alice.vc.safetyNumber(alice.pub, bob.pub);
  const fromBob = await bob.vc.safetyNumber(bob.pub, alice.pub);

  assert.strictEqual(fromAlice, fromBob, 'обе стороны должны видеть один и тот же код');

  const groups = fromAlice.split(/\s+/).filter(Boolean);
  assert.strictEqual(groups.length, 15, 'код сверки — 15 групп по 5 цифр');
  for (const g of groups) assert.match(g, /^\d{5}$/);
});

test('код сверки различается для разных собеседников', async () => {
  const alice = await makeUser('alisa');
  const bob = await makeUser('boris');
  const eve = await makeUser('eva');

  const withBob = await alice.vc.safetyNumber(alice.pub, bob.pub);
  const withEve = await alice.vc.safetyNumber(alice.pub, eve.pub);

  assert.notStrictEqual(withBob, withEve, 'подмена ключа должна менять код сверки');
});

test('бинарное шифрование вложений работает (пока не используется в клиенте)', async () => {
  const alice = await makeUser('alisa');
  const bob = await makeUser('boris');
  const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);

  const { header, cipher } = await alice.vc.encryptBytes(bytes, [
    { id: bob.id, pub: bob.pub },
    { id: alice.id, pub: alice.pub },
  ]);

  const out = await bob.vc.decryptBytes(header, cipher);
  assert.deepStrictEqual(Array.from(out), Array.from(bytes));
});
