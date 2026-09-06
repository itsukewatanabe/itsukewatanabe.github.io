/*
 * Chess rules — 0x88 board, complete legal move generation.
 *
 * The wire format below is deliberately identical to the Android app's, so a phone with the
 * APK and a phone with only this page can sit in the same game.
 *
 * Verified against the standard perft positions (see perft.js) before it ever shipped.
 */

export const EMPTY = 0, PAWN = 1, KNIGHT = 2, BISHOP = 3, ROOK = 4, QUEEN = 5, KING = 6;
export const WHITE = 0, BLACK = 1;

const CASTLE_WK = 1, CASTLE_WQ = 2, CASTLE_BK = 4, CASTLE_BQ = 8;

const KNIGHT_DIRS = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP_DIRS = [-17, -15, 15, 17];
const ROOK_DIRS = [-16, -1, 1, 16];
const KING_DIRS = [-17, -16, -15, -1, 1, 15, 16, 17];

export const piece = (type, color) => type | (color << 3);
export const typeOf = (p) => p & 7;
export const colorOf = (p) => (p >> 3) & 1;
const onBoard = (sq) => (sq & 0x88) === 0;

export const square = (file, rank) => rank * 16 + file;
export const fileOf = (sq) => sq & 15;
export const rankOf = (sq) => sq >> 4;
export const squareName = (sq) => "abcdefgh"[fileOf(sq)] + (rankOf(sq) + 1);
export const nameToSquare = (s) =>
  square("abcdefgh".indexOf(s[0]), "12345678".indexOf(s[1]));

/** A position. `ply` counts half-moves from the start — it is the move index on the wire. */
export function initialPosition() {
  const b = new Int8Array(128);
  const back = [ROOK, KNIGHT, BISHOP, QUEEN, KING, BISHOP, KNIGHT, ROOK];
  for (let f = 0; f < 8; f++) {
    b[square(f, 0)] = piece(back[f], WHITE);
    b[square(f, 1)] = piece(PAWN, WHITE);
    b[square(f, 6)] = piece(PAWN, BLACK);
    b[square(f, 7)] = piece(back[f], BLACK);
  }
  const pos = { b, turn: WHITE, castle: 15, ep: -1, half: 0, ply: 0, keys: [] };
  pos.keys.push(positionKey(pos));
  return pos;
}

function clone(pos) {
  return {
    b: Int8Array.from(pos.b), turn: pos.turn, castle: pos.castle,
    ep: pos.ep, half: pos.half, ply: pos.ply, keys: pos.keys.slice(),
  };
}

/** Identity of a position for threefold repetition: men, side to move, castling, en passant. */
function positionKey(pos) {
  let s = "";
  for (let r = 7; r >= 0; r--) for (let f = 0; f < 8; f++) s += pos.b[square(f, r)] + ",";
  return s + pos.turn + "|" + pos.castle + "|" + pos.ep;
}

export function kingSquare(pos, color) {
  const want = piece(KING, color);
  for (let sq = 0; sq < 128; sq++) if (onBoard(sq) && pos.b[sq] === want) return sq;
  return -1;
}

/** Is `sq` attacked by any man of `by`? Used for check, castling and legality. */
export function attacked(pos, sq, by) {
  // pawns
  const pawn = piece(PAWN, by);
  const back = by === WHITE ? -16 : 16;
  for (const side of [-1, 1]) {
    const from = sq + back + side;
    if (onBoard(from) && pos.b[from] === pawn) return true;
  }
  // knights and king
  for (const d of KNIGHT_DIRS) {
    const from = sq + d;
    if (onBoard(from) && pos.b[from] === piece(KNIGHT, by)) return true;
  }
  for (const d of KING_DIRS) {
    const from = sq + d;
    if (onBoard(from) && pos.b[from] === piece(KING, by)) return true;
  }
  // sliders
  for (const [dirs, sliders] of [[BISHOP_DIRS, [BISHOP, QUEEN]], [ROOK_DIRS, [ROOK, QUEEN]]]) {
    for (const d of dirs) {
      for (let s = sq + d; onBoard(s); s += d) {
        const p = pos.b[s];
        if (p === EMPTY) continue;
        if (colorOf(p) === by && sliders.includes(typeOf(p))) return true;
        break;
      }
    }
  }
  return false;
}

export const inCheck = (pos, color = pos.turn) =>
  attacked(pos, kingSquare(pos, color), 1 - color);

/** Every pseudo-legal move — the king may still be left hanging; `legalMoves` filters. */
function pseudoMoves(pos) {
  const moves = [];
  const us = pos.turn, them = 1 - us;
  const push = (from, to, extra) => moves.push({ from, to, promo: 0, ...extra });

  for (let from = 0; from < 128; from++) {
    if (!onBoard(from)) continue;
    const p = pos.b[from];
    if (p === EMPTY || colorOf(p) !== us) continue;
    const type = typeOf(p);

    if (type === PAWN) {
      const up = us === WHITE ? 16 : -16;
      const startRank = us === WHITE ? 1 : 6;
      const lastRank = us === WHITE ? 7 : 0;
      const one = from + up;
      if (onBoard(one) && pos.b[one] === EMPTY) {
        if (rankOf(one) === lastRank) {
          for (const q of [QUEEN, ROOK, BISHOP, KNIGHT]) push(from, one, { promo: q });
        } else {
          push(from, one, {});
          const two = one + up;
          if (rankOf(from) === startRank && pos.b[two] === EMPTY) push(from, two, { double: true });
        }
      }
      for (const side of [-1, 1]) {
        const to = from + up + side;
        if (!onBoard(to)) continue;
        const target = pos.b[to];
        if (target !== EMPTY && colorOf(target) === them) {
          if (rankOf(to) === lastRank) {
            for (const q of [QUEEN, ROOK, BISHOP, KNIGHT]) push(from, to, { promo: q });
          } else push(from, to, {});
        } else if (to === pos.ep && target === EMPTY) {
          push(from, to, { ep: true });
        }
      }
      continue;
    }

    if (type === KNIGHT || type === KING) {
      for (const d of type === KNIGHT ? KNIGHT_DIRS : KING_DIRS) {
        const to = from + d;
        if (!onBoard(to)) continue;
        const target = pos.b[to];
        if (target === EMPTY || colorOf(target) === them) push(from, to, {});
      }
      continue;
    }

    const dirs = type === BISHOP ? BISHOP_DIRS : type === ROOK ? ROOK_DIRS : KING_DIRS;
    for (const d of dirs) {
      for (let to = from + d; onBoard(to); to += d) {
        const target = pos.b[to];
        if (target === EMPTY) { push(from, to, {}); continue; }
        if (colorOf(target) === them) push(from, to, {});
        break;
      }
    }
  }

  // castling: the king may not start in check, pass through an attacked square, or land in one
  const home = us === WHITE ? 0 : 7;
  const kingHome = square(4, home);
  const canK = us === WHITE ? pos.castle & CASTLE_WK : pos.castle & CASTLE_BK;
  const canQ = us === WHITE ? pos.castle & CASTLE_WQ : pos.castle & CASTLE_BQ;
  if ((canK || canQ) && pos.b[kingHome] === piece(KING, us) && !attacked(pos, kingHome, them)) {
    if (canK && pos.b[square(5, home)] === EMPTY && pos.b[square(6, home)] === EMPTY
        && pos.b[square(7, home)] === piece(ROOK, us)
        && !attacked(pos, square(5, home), them) && !attacked(pos, square(6, home), them)) {
      push(kingHome, square(6, home), { castle: "K" });
    }
    if (canQ && pos.b[square(3, home)] === EMPTY && pos.b[square(2, home)] === EMPTY
        && pos.b[square(1, home)] === EMPTY && pos.b[square(0, home)] === piece(ROOK, us)
        && !attacked(pos, square(3, home), them) && !attacked(pos, square(2, home), them)) {
      push(kingHome, square(2, home), { castle: "Q" });
    }
  }
  return moves;
}

/** Applies a move and returns the new position. The move must come from `legalMoves`. */
export function makeMove(pos, move) {
  const next = clone(pos);
  const us = pos.turn, them = 1 - us;
  const moving = next.b[move.from];
  const captured = move.ep ? piece(PAWN, them) : next.b[move.to];

  next.b[move.to] = move.promo ? piece(move.promo, us) : moving;
  next.b[move.from] = EMPTY;

  if (move.ep) next.b[move.to + (us === WHITE ? -16 : 16)] = EMPTY;

  if (move.castle) {
    const home = us === WHITE ? 0 : 7;
    if (move.castle === "K") {
      next.b[square(5, home)] = next.b[square(7, home)];
      next.b[square(7, home)] = EMPTY;
    } else {
      next.b[square(3, home)] = next.b[square(0, home)];
      next.b[square(0, home)] = EMPTY;
    }
  }

  // castling rights die when the king or a rook leaves, or a rook is captured on its square
  if (typeOf(moving) === KING) next.castle &= us === WHITE ? ~(CASTLE_WK | CASTLE_WQ) : ~(CASTLE_BK | CASTLE_BQ);
  const clearRook = (sq) => {
    if (sq === square(7, 0)) next.castle &= ~CASTLE_WK;
    if (sq === square(0, 0)) next.castle &= ~CASTLE_WQ;
    if (sq === square(7, 7)) next.castle &= ~CASTLE_BK;
    if (sq === square(0, 7)) next.castle &= ~CASTLE_BQ;
  };
  clearRook(move.from);
  clearRook(move.to);

  next.ep = move.double ? move.from + (us === WHITE ? 16 : -16) : -1;
  next.half = (typeOf(moving) === PAWN || captured !== EMPTY) ? 0 : pos.half + 1;
  next.turn = them;
  next.ply = pos.ply + 1;
  if (next.half === 0) next.keys.length = 0;          // no repetition can cross a pawn or capture
  next.keys.push(positionKey(next));
  return next;
}

export function legalMoves(pos) {
  const out = [];
  for (const m of pseudoMoves(pos)) {
    const after = makeMove(pos, m);
    if (!attacked(after, kingSquare(after, pos.turn), 1 - pos.turn)) out.push(m);
  }
  return out;
}

function insufficientMaterial(pos) {
  const men = [];
  for (let sq = 0; sq < 128; sq++) {
    if (!onBoard(sq) || pos.b[sq] === EMPTY) continue;
    const t = typeOf(pos.b[sq]);
    if (t === PAWN || t === ROOK || t === QUEEN) return false;
    if (t !== KING) men.push({ t, sq, c: colorOf(pos.b[sq]) });
  }
  if (men.length <= 1) return true;                                   // K v K, K+minor v K
  if (men.length === 2 && men[0].t === BISHOP && men[1].t === BISHOP && men[0].c !== men[1].c) {
    const dark = (sq) => (fileOf(sq) + rankOf(sq)) % 2 === 0;
    return dark(men[0].sq) === dark(men[1].sq);                       // same-colour bishops
  }
  return false;
}

/** "playing", or how the game ended. */
export function status(pos) {
  if (legalMoves(pos).length === 0) return inCheck(pos) ? "checkmate" : "stalemate";
  if (pos.half >= 100) return "fifty";
  const key = pos.keys[pos.keys.length - 1];
  if (pos.keys.filter((k) => k === key).length >= 3) return "repetition";
  if (insufficientMaterial(pos)) return "material";
  return "playing";
}

// ------------------------------------------------------------------ notation

export function toUci(move) {
  return squareName(move.from) + squareName(move.to) + (move.promo ? "nbrq"[move.promo - 2] : "");
}

/** Parses a UCI string against the position — returns null unless it names a legal move. */
export function fromUci(pos, uci) {
  if (typeof uci !== "string" || uci.length < 4) return null;
  for (const m of legalMoves(pos)) if (toUci(m) === uci) return m;
  return null;
}

export function toSan(pos, move) {
  if (move.castle) return sanSuffix(pos, move, move.castle === "K" ? "O-O" : "O-O-O");
  const p = pos.b[move.from], type = typeOf(p);
  const capture = move.ep || pos.b[move.to] !== EMPTY;
  let s = "";
  if (type === PAWN) {
    if (capture) s += "abcdefgh"[fileOf(move.from)] + "x";
    s += squareName(move.to);
    if (move.promo) s += "=" + "NBRQ"[move.promo - 2];
  } else {
    s += "  NBRQK"[type];
    // disambiguate against any other man of the same type reaching the same square
    const rivals = legalMoves(pos).filter((o) =>
      o.to === move.to && o.from !== move.from && typeOf(pos.b[o.from]) === type);
    if (rivals.length) {
      const sameFile = rivals.some((o) => fileOf(o.from) === fileOf(move.from));
      const sameRank = rivals.some((o) => rankOf(o.from) === rankOf(move.from));
      if (!sameFile) s += "abcdefgh"[fileOf(move.from)];
      else if (!sameRank) s += rankOf(move.from) + 1;
      else s += squareName(move.from);
    }
    if (capture) s += "x";
    s += squareName(move.to);
  }
  return sanSuffix(pos, move, s);
}

function sanSuffix(pos, move, s) {
  const after = makeMove(pos, move);
  if (!inCheck(after)) return s;
  return s + (legalMoves(after).length === 0 ? "#" : "+");
}

// ------------------------------------------------------------------ perft

/** Node count to `depth` — the standard way to prove a move generator correct. */
export function perft(pos, depth) {
  if (depth === 0) return 1;
  const moves = legalMoves(pos);
  if (depth === 1) return moves.length;
  let n = 0;
  for (const m of moves) n += perft(makeMove(pos, m), depth - 1);
  return n;
}

/** Minimal FEN reader — only used to load the perft test positions. */
export function fromFen(fen) {
  const [men, turn, castle, ep, half, full] = fen.trim().split(/\s+/);
  const b = new Int8Array(128);
  let rank = 7, file = 0;
  for (const ch of men) {
    if (ch === "/") { rank--; file = 0; continue; }
    if (ch >= "1" && ch <= "8") { file += +ch; continue; }
    const type = { p: PAWN, n: KNIGHT, b: BISHOP, r: ROOK, q: QUEEN, k: KING }[ch.toLowerCase()];
    b[square(file++, rank)] = piece(type, ch === ch.toUpperCase() ? WHITE : BLACK);
  }
  const pos = {
    b,
    turn: turn === "w" ? WHITE : BLACK,
    castle: (castle.includes("K") ? CASTLE_WK : 0) | (castle.includes("Q") ? CASTLE_WQ : 0)
          | (castle.includes("k") ? CASTLE_BK : 0) | (castle.includes("q") ? CASTLE_BQ : 0),
    ep: ep && ep !== "-" ? nameToSquare(ep) : -1,
    half: half ? +half : 0,
    ply: 0,
    keys: [],
  };
  pos.keys.push(positionKey(pos));
  return pos;
}
