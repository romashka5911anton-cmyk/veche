#!/usr/bin/env node
// Генератор иконок ВЕЧЕ — без внешних зависимостей (только zlib из ядра Node).
// Рисует фирменный знак: градиент бренда + шестиугольник ⬡ (как в favicon.svg).
// Запуск:  node tools/gen-icons.js
// Выход:   public/icon-192.png, icon-512.png, icon-192-maskable.png, icon-512-maskable.png
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'public');

// ── брендовые цвета (совпадают с --grad в style.css) ──
const C1 = [0x7c, 0x5f, 0xf5]; // #7c5ff5
const C2 = [0x50, 0x80, 0xf7]; // #5080f7
const C3 = [0x22, 0xd3, 0xee]; // #22d3ee

const lerp = (a, b, t) => a + (b - a) * t;
function gradient(t) {
  // t в [0,1]: C1 → C2 (t=0.5) → C3
  if (t < 0.5) { const u = t / 0.5; return [lerp(C1[0], C2[0], u), lerp(C1[1], C2[1], u), lerp(C1[2], C2[2], u)]; }
  const u = (t - 0.5) / 0.5; return [lerp(C2[0], C3[0], u), lerp(C2[1], C3[1], u), lerp(C2[2], C3[2], u)];
}

// «расстояние» до центра в метрике правильного шестиугольника (pointy-top, как в favicon)
const N0 = [1, 0], N1 = [Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)], N2 = [Math.cos(2 * Math.PI / 3), Math.sin(2 * Math.PI / 3)];
function hexDist(dx, dy) {
  return Math.max(Math.abs(dx * N0[0] + dy * N0[1]), Math.abs(dx * N1[0] + dy * N1[1]), Math.abs(dx * N2[0] + dy * N2[1]));
}

function renderPixel(px, py, N, opts) {
  const c = (N - 1) / 2;
  const dx = px - c, dy = py - c;

  // фон-градиент по диагонали
  let [r, g, b] = gradient((px + py) / (2 * (N - 1)));
  let a = 255;

  // скруглённые углы для «обычной» иконки (у maskable — во весь квадрат, ОС сама маскирует)
  if (opts.round) {
    const rad = 0.22 * N;
    const qx = Math.abs(dx) - (N / 2 - rad), qy = Math.abs(dy) - (N / 2 - rad);
    if (qx > 0 && qy > 0 && Math.hypot(qx, qy) > rad) a = 0;
  }

  // шестиугольный знак
  const h = hexDist(dx, dy);
  const A = opts.A * N, stroke = opts.stroke * N, inner = opts.inner * N;
  const ring = Math.abs(h - A) <= stroke;
  const core = h <= inner;
  if (ring || core) { r = 255; g = 255; b = 255; if (a === 0) a = 255; }

  return [Math.round(r), Math.round(g), Math.round(b), a];
}

function makeIcon(N, opts) {
  const S = 2; // суперсэмплинг ×2 для гладких краёв
  const M = N * S;
  const raw = Buffer.alloc(N * (N * 4 + 1)); // +1 фильтр-байт на строку
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < N; x++) {
      let R = 0, G = 0, B = 0, A = 0;
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const [r, g, b, a] = renderPixel(x * S + sx, y * S + sy, M, {
          round: opts.round, A: opts.A, stroke: opts.stroke, inner: opts.inner,
        });
        // премультипликация, чтобы прозрачные углы не «протекали» белым
        R += r * a; G += g * a; B += b * a; A += a;
      }
      const n = S * S;
      const o = y * (N * 4 + 1) + 1 + x * 4;
      const aAvg = A / n;
      raw[o]     = aAvg > 0 ? Math.round(R / A) : 0;
      raw[o + 1] = aAvg > 0 ? Math.round(G / A) : 0;
      raw[o + 2] = aAvg > 0 ? Math.round(B / A) : 0;
      raw[o + 3] = Math.round(aAvg);
    }
  }
  return encodePNG(N, N, raw);
}

// ── минимальный кодировщик PNG (truecolor+alpha) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(w, h, raw) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const ANY = { round: true, A: 0.30, stroke: 0.032, inner: 0.12 };
const MASK = { round: false, A: 0.255, stroke: 0.028, inner: 0.10 };

const files = [
  ['icon-192.png', 192, ANY],
  ['icon-512.png', 512, ANY],
  ['icon-192-maskable.png', 192, MASK],
  ['icon-512-maskable.png', 512, MASK],
];
for (const [name, size, opts] of files) {
  fs.writeFileSync(path.join(OUT, name), makeIcon(size, opts));
  console.log('✓', name, `(${size}×${size})`);
}
console.log('Иконки готовы →', OUT);
