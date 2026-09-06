/*
 * The duel: who is who, whose turn it is, and which relay message may change what.
 *
 * Byte-for-byte the same wire format as the Android app, so a phone running the APK and a phone
 * running only this page can play each other:
 *
 *   H|1|creatorId|creatorName|creatorColour|creatorBudgetMs|joinerBudgetMs
 *   J|game|joinerId|joinerName
 *   M|game|ply|uci|senderId
 *   R|game|senderId                 resign
 *   F|game|senderId|flaggedColour   clock ran out
 *   O|game|senderId                 draw offered      A = accepted, N = declined
 *   X|game|senderId                 rematch wanted
 *   S|game|whiteId|senderId         rematch starts
 *
 * There is no server and therefore no referee. Instead every message is idempotent: a move is
 * applied only when it is exactly the next ply AND its sender owns the side to move. Replaying
 * the relay's history from the start always lands on the same position, which is what makes a
 * reload or a reconnect indistinguishable from a game that never dropped.
 */

import {
  WHITE, BLACK, initialPosition, legalMoves, makeMove, fromUci, toUci, toSan, status,
} from "./chess.js";

export const NONE = 0, WHITE_WINS = 1, BLACK_WINS = 2, DRAW = 3;

const ENDINGS = {
  checkmate: "Schachmatt",
  stalemate: "Patt",
  fifty: "50-Züge-Regel",
  repetition: "Stellungswiederholung",
  material: "zu wenig Material",
};

export class Match {
  constructor({ code, myId, myName, creator }) {
    this.code = code;
    this.myId = myId;
    this.myName = clean(myName);
    this.creator = creator;

    this.pos = initialPosition();
    this.san = [];
    this.gameNo = 1;
    this.myColor = -1;
    this.myBudget = 0;
    this.oppBudget = 0;

    this.creatorId = null;
    this.joinerId = null;
    this.creatorName = null;
    this.joinerName = null;
    this.creatorColor = WHITE;
    this.creatorBudget = 0;
    this.joinerBudget = 0;

    this.started = false;
    this.lastMove = null;
    this.result = NONE;
    this.resultReason = "";
    this.drawOfferedByMe = false;
    this.drawOfferedByOpp = false;
    this.rematchByMe = false;
    this.rematchByOpp = false;
    this.seatTaken = false;

    this.future = new Map();
    this.helloSeen = false;
    this.sink = () => {};
    this.watcher = () => {};
  }

  static create({ code, myId, myName, myColor, myBudget, oppBudget }) {
    const m = new Match({ code, myId, myName, creator: true });
    m.creatorId = myId;
    m.creatorName = m.myName;
    m.creatorColor = myColor;
    m.creatorBudget = myBudget;
    m.joinerBudget = oppBudget;
    m.myColor = myColor;
    m.myBudget = myBudget;
    m.oppBudget = oppBudget;
    return m;
  }

  static join({ code, myId, myName }) {
    return new Match({ code, myId, myName, creator: false });
  }

  attach(sink, watcher) {
    this.sink = sink;
    this.watcher = watcher;
  }

  /** Announce ourselves — only after the replay has had time to land, so we don't post twice. */
  settle() {
    if (this.creator && !this.helloSeen) {
      this.send(`H|1|${this.myId}|${this.creatorName}|${this.creatorColor}`
        + `|${this.creatorBudget}|${this.joinerBudget}`);
    }
    if (!this.creator && this.creatorId && !this.joinerId) {
      this.send(`J|${this.gameNo}|${this.myId}|${this.myName}`);
    }
    this.changed();
  }

  // ---------------------------------------------------------------- queries

  get oppId() { return this.creator ? this.joinerId : this.creatorId; }
  get oppName() { return (this.creator ? this.joinerName : this.creatorName) || "Gegner"; }
  get oppColor() { return this.myColor < 0 ? -1 : 1 - this.myColor; }
  get over() { return this.result !== NONE; }
  get myTurn() { return this.started && !this.over && this.myColor >= 0 && this.pos.turn === this.myColor; }
  get oppTurn() { return this.started && !this.over && this.myColor >= 0 && this.pos.turn !== this.myColor; }

  /** The result as this player sees it. */
  resultLine() {
    if (!this.over) return "";
    if (this.result === DRAW) return `Remis — ${this.resultReason}`;
    const iWon = (this.result === WHITE_WINS) === (this.myColor === WHITE);
    return `${iWon ? "Gewonnen" : "Verloren"} — ${this.resultReason}`;
  }

  // ---------------------------------------------------------------- actions

  play(move) {
    if (!this.myTurn || !move) return false;
    const legal = fromUci(this.pos, toUci(move));
    if (!legal) return false;
    this.send(`M|${this.gameNo}|${this.pos.ply}|${toUci(legal)}|${this.myId}`);
    this.apply(legal);
    return true;
  }

  resign() {
    if (this.over || !this.started) return;
    this.send(`R|${this.gameNo}|${this.myId}`);
    this.finishByResign(this.myColor);
  }

  /** Our own clock ran out — we are the honest source for our own time. */
  flag() {
    if (this.over || !this.started || this.myColor < 0) return;
    this.send(`F|${this.gameNo}|${this.myId}|${this.myColor}`);
    this.finishByFlag(this.myColor);
  }

  /** Their clock ran out and they went quiet (tab closed, offline). */
  claimFlag() {
    if (this.over || !this.started || this.myColor < 0) return;
    this.send(`F|${this.gameNo}|${this.myId}|${this.oppColor}`);
    this.finishByFlag(this.oppColor);
  }

  offerDraw() {
    if (this.over || !this.started || this.drawOfferedByMe) return;
    this.drawOfferedByMe = true;
    this.send(`O|${this.gameNo}|${this.myId}`);
    this.changed();
  }

  acceptDraw() {
    if (this.over || !this.drawOfferedByOpp) return;
    this.send(`A|${this.gameNo}|${this.myId}`);
    this.finish(DRAW, "Remis vereinbart");
  }

  declineDraw() {
    if (!this.drawOfferedByOpp) return;
    this.drawOfferedByOpp = false;
    this.send(`N|${this.gameNo}|${this.myId}`);
    this.changed();
  }

  askRematch() {
    if (!this.over || this.rematchByMe) return;
    this.rematchByMe = true;
    this.send(`X|${this.gameNo}|${this.myId}`);
    this.maybeStartRematch();
    this.changed();
  }

  // ---------------------------------------------------------------- inbound

  onWire(line) {
    if (typeof line !== "string") return;
    const p = line.split("|");
    if (p.length < 2) return;
    const type = p[0];
    const g = Number.parseInt(p[1], 10);
    if (!Number.isInteger(g) || g < 0) return;

    if (type === "H") return this.onHello(p);
    if (type === "S") return this.onRematchStart(g, p);
    if (g !== this.gameNo) return;                       // a message from an earlier game

    if (type === "J") this.onJoin(p);
    else if (type === "M") this.onMove(p);
    else if (type === "R") this.onResign(p);
    else if (type === "F") this.onFlag(p);
    else if (type === "O") this.onOffer(p);
    else if (type === "A") this.onAccept(p);
    else if (type === "N") this.onDecline(p);
    else if (type === "X") this.onRematchAsk(p);
  }

  onHello(p) {
    if (p.length < 7 || this.helloSeen) return;
    this.helloSeen = true;
    this.creatorId = p[2];
    this.creatorName = clean(p[3]);
    this.creatorColor = Number.parseInt(p[4], 10) === BLACK ? BLACK : WHITE;
    this.creatorBudget = num(p[5]);
    this.joinerBudget = num(p[6]);
    this.myBudget = this.creator ? this.creatorBudget : this.joinerBudget;
    this.oppBudget = this.creator ? this.joinerBudget : this.creatorBudget;
    // Colours only follow the hello for game 1; a rematch assigns them itself.
    if (this.gameNo === 1) this.myColor = this.creator ? this.creatorColor : 1 - this.creatorColor;
    this.markStarted();
    this.changed();
  }

  onJoin(p) {
    if (p.length < 4) return;
    if (!this.joinerId) {
      this.joinerId = p[2];
      this.joinerName = clean(p[3]);
    }
    if (!this.creator && this.myId !== this.joinerId) this.seatTaken = true;
    this.markStarted();
    this.changed();
  }

  onMove(p) {
    if (p.length < 5 || this.over) return;
    const ply = Number.parseInt(p[2], 10);
    if (!Number.isInteger(ply) || ply < this.pos.ply) return;   // already played
    this.future.set(ply, { uci: p[3], sender: p[4] });
    this.drainFuture();
  }

  drainFuture() {
    while (!this.over) {
      const entry = this.future.get(this.pos.ply);
      if (!entry) return;
      this.future.delete(this.pos.ply);
      if (this.colorOf(entry.sender) !== this.pos.turn) continue;  // not their move to make
      const move = fromUci(this.pos, entry.uci);
      if (!move) continue;                                        // illegal here: never corrupt
      this.apply(move);
    }
  }

  onResign(p) {
    if (p.length < 3 || this.over) return;
    const c = this.colorOf(p[2]);
    if (c >= 0) this.finishByResign(c);
  }

  onFlag(p) {
    if (p.length < 4 || this.over) return;
    const flagged = Number.parseInt(p[3], 10);
    if (flagged !== WHITE && flagged !== BLACK) return;
    if (this.colorOf(p[2]) < 0) return;
    this.finishByFlag(flagged);
  }

  onOffer(p) {
    if (p.length < 3 || this.over) return;
    if (p[2] === this.myId) this.drawOfferedByMe = true; else this.drawOfferedByOpp = true;
    this.changed();
  }

  onAccept(p) {
    if (p.length < 3 || this.over) return;
    if (!this.drawOfferedByMe && !this.drawOfferedByOpp) return;
    this.finish(DRAW, "Remis vereinbart");
  }

  onDecline(p) {
    if (p.length < 3) return;
    if (p[2] === this.myId) this.drawOfferedByOpp = false; else this.drawOfferedByMe = false;
    this.changed();
  }

  onRematchAsk(p) {
    if (p.length < 3 || !this.over) return;
    if (p[2] === this.myId) this.rematchByMe = true; else this.rematchByOpp = true;
    this.maybeStartRematch();
    this.changed();
  }

  /** Only the creator announces the new game, so both devices cannot start one at once. */
  maybeStartRematch() {
    if (!this.creator || !this.rematchByMe || !this.rematchByOpp) return;
    const nextWhite = this.myColor === WHITE ? this.oppId : this.myId;   // colours swap
    if (!nextWhite) return;
    this.send(`S|${this.gameNo + 1}|${nextWhite}|${this.myId}`);
    this.beginGame(this.gameNo + 1, nextWhite);
  }

  onRematchStart(g, p) {
    if (p.length < 4 || g <= this.gameNo) return;
    this.beginGame(g, p[2]);
  }

  beginGame(g, whiteId) {
    this.gameNo = g;
    this.pos = initialPosition();
    this.san = [];
    this.future.clear();
    this.lastMove = null;
    this.result = NONE;
    this.resultReason = "";
    this.drawOfferedByMe = this.drawOfferedByOpp = false;
    this.rematchByMe = this.rematchByOpp = false;
    this.myColor = this.myId === whiteId ? WHITE : BLACK;
    this.changed();
  }

  // ---------------------------------------------------------------- internals

  apply(move) {
    this.san.push(toSan(this.pos, move));
    this.pos = makeMove(this.pos, move);
    this.lastMove = move;
    this.drawOfferedByMe = this.drawOfferedByOpp = false;   // an offer dies with the next move
    this.evaluate();
    this.changed();
  }

  evaluate() {
    const s = status(this.pos);
    if (s === "playing") return;
    if (s === "checkmate") {
      this.finish(this.pos.turn === WHITE ? BLACK_WINS : WHITE_WINS, ENDINGS.checkmate);
    } else {
      this.finish(DRAW, ENDINGS[s]);
    }
  }

  finishByResign(loser) { this.finish(loser === WHITE ? BLACK_WINS : WHITE_WINS, "aufgegeben"); }
  finishByFlag(loser) { this.finish(loser === WHITE ? BLACK_WINS : WHITE_WINS, "Zeit abgelaufen"); }

  finish(result, reason) {
    if (this.result !== NONE) return;
    this.result = result;
    this.resultReason = reason;
    this.changed();
  }

  markStarted() {
    if (this.creatorId && this.joinerId && !this.seatTaken) this.started = true;
  }

  colorOf(id) {
    if (!id || this.myColor < 0) return -1;
    if (id === this.myId) return this.myColor;
    if (id === this.oppId) return 1 - this.myColor;
    return -1;
  }

  legal() { return legalMoves(this.pos); }

  send(line) { this.sink(line); }
  changed() { this.watcher(); }
}

/** Names travel through a pipe-separated wire format and end up on screen. */
function clean(s) {
  return String(s ?? "").replace(/[| -]/g, "").trim().slice(0, 20);
}

function num(s) {
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}
