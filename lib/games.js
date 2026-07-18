// ================================================================
//  ВЕЧЕ · Движок мини-игр (крестики-нолики, 4-в-ряд, КНБ, кости)
// ----------------------------------------------------------------
//  Чистые функции без побочных эффектов — состояние игры хранится
//  в сообщении (msg.media.state), а ходы обрабатываются в server.js.
//  Чтобы добавить свою игру: опишите её правила здесь и подключите
//  в обработчиках game:create / game:move.
// ================================================================
'use strict';

// ── Крестики-нолики ──
const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
function tttWinner(b) { for (const [x, y, z] of TTT_LINES) if (b[x] && b[x] === b[y] && b[y] === b[z]) return b[x]; return null; }

// ── Камень-ножницы-бумага ──  (0 = ничья, 1 = первый, 2 = второй)
function rpsWinner(a, b) { if (a === b) return 0; const beats = { rock: 'scissors', scissors: 'paper', paper: 'rock' }; return beats[a] === b ? 1 : 2; }

// ── 4 в ряд: 6 строк × 7 столбцов, индекс = row*7+col ──
function c4Winner(b) {
  const at = (r, c) => (r >= 0 && r < 6 && c >= 0 && c < 7) ? b[r * 7 + c] : null;
  for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
    const v = at(r, c); if (!v) continue;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]])
      if (at(r + dr, c + dc) === v && at(r + 2 * dr, c + 2 * dc) === v && at(r + 3 * dr, c + 3 * dc) === v) return v;
  }
  return null;
}
function c4Drop(b, col) { for (let r = 5; r >= 0; r--) if (!b[r * 7 + col]) return r * 7 + col; return -1; }

// ── Создание и управление раундами (best-of-N с авто-рестартом) ──
function newGameState(type, players, target) {
  const s = { scores: { [players[0]]: 0, [players[1]]: 0 }, target, round: 1, matchWinner: null, roundWinner: null };
  if (type === 'ttt') s.marks = { [players[0]]: 'X', [players[1]]: 'O' };
  if (type === 'c4') s.marks = { [players[0]]: 'R', [players[1]]: 'Y' };
  initRound(s, type, players);
  return s;
}
function initRound(s, type, players) {
  const starter = players[(s.round - 1) % 2];
  s.roundWinner = null; s.reveal = false;
  if (type === 'ttt') { s.board = Array(9).fill(null); s.turn = starter; }
  else if (type === 'c4') { s.board = Array(42).fill(null); s.turn = starter; }
  else if (type === 'rps') { s.choices = {}; }
  else if (type === 'dice') { s.rolls = {}; }
}

module.exports = { TTT_LINES, tttWinner, rpsWinner, c4Winner, c4Drop, newGameState, initRound };
