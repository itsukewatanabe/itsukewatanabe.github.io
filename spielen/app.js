/*
 * The page: lobby, board, clocks — and the glue that keeps them in step with the relay.
 *
 * Everything the match touches happens on the one browser thread, and relay traffic is handed
 * to it as it arrives, so there is no shared state to guard anywhere.
 */

import { EMPTY, WHITE, BLACK, PAWN, KNIGHT, BISHOP, ROOK, QUEEN, KING,
         typeOf, colorOf, square, fileOf, rankOf, kingSquare, inCheck } from "./chess.js";
import { Match } from "./match.js";
import { Relay } from "./relay.js";
import * as Codes from "./codes.js";

const $ = (id) => document.getElementById(id);

const BUDGETS = [10000, 20000, 30000, 60000, 120000, 0];
const BUDGET_LABELS = ["10s", "20s", "30s", "1m", "2m", "∞"];
const GLYPH = { [PAWN]: "♟", [KNIGHT]: "♞", [BISHOP]: "♝", [ROOK]: "♜", [QUEEN]: "♛", [KING]: "♚" };
const RESUME_GRACE_MS = 3000;
const SETTLE_MS = 2500;

// ------------------------------------------------------------------- storage

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("sd." + key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem("sd." + key, JSON.stringify(value)); } catch { /* private mode */ } },
  del(key) { try { localStorage.removeItem("sd." + key); } catch { /* ignore */ } },
};

function myId() {
  let id = store.get("id", null);
  if (!id) {
    const b = new Uint8Array(5);
    crypto.getRandomValues(b);
    id = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    store.set("id", id);
  }
  return id;
}

// --------------------------------------------------------------------- clock

/**
 * A per-move budget, spent only while the page is actually in front of the player. A budget of
 * 0 means no clock at all — the shape the opponent's clock usually has here.
 */
class MoveClock {
  constructor(budget) { this.budget = budget; this.consumed = 0; this.since = -1; }
  get unlimited() { return this.budget <= 0; }
  newTurn() { this.consumed = 0; this.since = -1; }
  run(now, grace = 0) { if (!this.unlimited && this.since < 0) this.since = now + grace; }
  hold(now) {
    if (this.since >= 0) {
      const elapsed = now - this.since;
      if (elapsed > 0) this.consumed += elapsed;
      this.since = -1;
    }
  }
  get running() { return this.since >= 0; }
  remaining(now) {
    if (this.unlimited) return Infinity;
    const extra = this.since >= 0 ? Math.max(0, now - this.since) : 0;
    return this.budget - this.consumed - extra;
  }
  expired(now) { return !this.unlimited && this.remaining(now) <= 0; }
}

// ------------------------------------------------------------------- session

const app = {
  match: null, relay: null, myClock: null, oppClock: null,
  selected: null, promoMoves: null,
  linkUp: false, visible: true, graceOnce: false,
  clockGame: -1, clockPly: -1, rendered: "", wakeLock: null,
};

function startSession(match, remember) {
  stopSession(false);
  app.match = match;
  app.myClock = new MoveClock(match.myBudget);
  app.oppClock = new MoveClock(match.oppBudget);
  app.selected = null;
  app.promoMoves = null;
  app.rendered = "";
  app.clockGame = app.clockPly = -1;

  app.relay = new Relay(Codes.topic(match.code), {
    onMessage: (line) => { match.onWire(line); render(); },
    onLink: (up) => { app.linkUp = up; render(); },
  });
  match.attach((line) => app.relay.send(line), () => render());
  app.relay.start();
  setTimeout(() => { if (app.match === match) { match.settle(); render(); } }, SETTLE_MS);

  if (remember) {
    store.set("game", {
      code: match.code, creator: match.creator,
      color: match.myColor, myBudget: match.myBudget, oppBudget: match.oppBudget,
    });
  }
  showGame();
  render();
  requestWakeLock();
}

function stopSession(forget) {
  if (app.relay) app.relay.stop();
  app.relay = null;
  app.match = null;
  releaseWakeLock();
  if (forget) store.del("game");
}

async function requestWakeLock() {
  try { app.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* unsupported */ }
}
function releaseWakeLock() {
  try { app.wakeLock?.release(); } catch { /* ignore */ }
  app.wakeLock = null;
}

// --------------------------------------------------------------------- ticks

setInterval(tick, 100);

/** The clock only runs while the board is the thing in front of the player. */
function boardVisible() {
  return app.visible && !document.getElementById("game").classList.contains("hidden");
}

function tick() {
  const m = app.match;
  if (!m) return;
  const now = performance.now();
  const watching = boardVisible();

  if (m.gameNo !== app.clockGame || m.pos.ply !== app.clockPly) {
    app.clockGame = m.gameNo;
    app.clockPly = m.pos.ply;
    app.myClock.newTurn();
    app.oppClock.newTurn();
  }

  const live = m.started && !m.over;
  if (!live) {
    app.myClock.hold(now);
    app.oppClock.hold(now);
  } else if (m.myTurn) {
    app.oppClock.hold(now);
    if (watching) startRun(app.myClock, now); else app.myClock.hold(now);
    if (app.myClock.expired(now)) m.flag();
  } else {
    app.myClock.hold(now);
    if (watching) startRun(app.oppClock, now); else app.oppClock.hold(now);
  }
  render();
}

function startRun(clock, now) {
  if (clock.running) return;
  clock.run(now, app.graceOnce ? RESUME_GRACE_MS : 0);
  app.graceOnce = false;
}

document.addEventListener("visibilitychange", () => {
  app.visible = document.visibilityState === "visible";
  if (app.visible) { app.graceOnce = true; requestWakeLock(); }
  render();
});

// ------------------------------------------------------------------ the board

const boardEl = $("board");
const cells = [];
for (let i = 0; i < 64; i++) {
  const cell = document.createElement("div");
  cell.className = "sq";
  cell.addEventListener("click", () => onSquare(cell.dataset.sq | 0));
  boardEl.appendChild(cell);
  cells.push(cell);
}

function flipped() { return app.match?.myColor === BLACK; }

function paintBoard() {
  const m = app.match;
  if (!m) return;
  const pos = m.pos;
  const legal = m.myTurn ? m.legal() : [];
  const targets = new Map();
  if (app.selected !== null) {
    for (const mv of legal) if (mv.from === app.selected) targets.set(mv.to, mv);
  }
  const checkSq = inCheck(pos) ? kingSquare(pos, pos.turn) : -1;

  for (let i = 0; i < 64; i++) {
    const row = i >> 3, col = i & 7;
    const rank = flipped() ? row : 7 - row;
    const file = flipped() ? 7 - col : col;
    const sq = square(file, rank);
    const cell = cells[i];
    cell.dataset.sq = sq;

    let cls = "sq " + ((file + rank) % 2 === 1 ? "light" : "dark");
    if (m.lastMove && (m.lastMove.from === sq || m.lastMove.to === sq)) cls += " last";
    if (app.selected === sq) cls += " sel";
    if (sq === checkSq) cls += " check";
    cell.className = cls;

    let html = "";
    const p = pos.b[sq];
    if (p !== EMPTY) {
      html += `<span class="piece ${colorOf(p) === WHITE ? "w" : "b"}">${GLYPH[typeOf(p)]}</span>`;
    }
    if (targets.has(sq)) {
      html += `<span class="dot ${p === EMPTY && !targets.get(sq).ep ? "quiet" : "capture"}"></span>`;
    }
    if (row === 7) html += `<span class="coord file">${"abcdefgh"[file]}</span>`;
    if (col === 0) html += `<span class="coord rank">${rank + 1}</span>`;
    cell.innerHTML = html;
  }
}

function onSquare(sq) {
  const m = app.match;
  if (!m || app.promoMoves || !m.myTurn) return;

  if (app.selected !== null) {
    const options = m.legal().filter((mv) => mv.from === app.selected && mv.to === sq);
    if (options.length === 1) return doMove(options[0]);
    if (options.length > 1) return askPromotion(options);
  }
  const p = m.pos.b[sq];
  app.selected = (p !== EMPTY && colorOf(p) === m.myColor) ? sq : null;
  paintBoard();
}

function doMove(move) {
  app.selected = null;
  app.promoMoves = null;
  $("promo").classList.add("hidden");
  app.match.play(move);
  render();
}

function askPromotion(options) {
  app.promoMoves = options;
  const box = $("promo");
  const color = app.match.myColor === WHITE ? "w" : "b";
  box.innerHTML = "";
  for (const type of [QUEEN, ROOK, BISHOP, KNIGHT]) {
    const move = options.find((o) => o.promo === type);
    if (!move) continue;
    const b = document.createElement("button");
    b.innerHTML = `<span class="piece ${color}">${GLYPH[type]}</span>`;
    b.addEventListener("click", () => doMove(move));
    box.appendChild(b);
  }
  box.onclick = (event) => { if (event.target === box) cancelPromotion(); };
  box.classList.remove("hidden");
  paintBoard();
}

function cancelPromotion() {
  app.promoMoves = null;
  document.getElementById("promo").classList.add("hidden");
  paintBoard();
}

// ------------------------------------------------------------------ rendering

function paintClocks() {
  const m = app.match;
  if (!m) return;
  paintClock($("opp-clock"), app.oppClock, m.oppTurn);
  paintClock($("my-clock"), app.myClock, m.myTurn);
}

function paintClock(el, clock, ticking) {
  if (clock.unlimited) {
    el.textContent = "∞";
    el.className = "clock" + (ticking ? " running" : "");
    return;
  }
  const ms = Math.max(0, clock.remaining(performance.now()));
  const s = Math.floor(ms / 1000);
  el.textContent = s >= 60
    ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
    : `${s},${Math.floor((ms % 1000) / 100)}`;
  el.className = "clock" + (!ticking ? "" : ms <= 5000 ? " panic" : ms <= 10000 ? " low" : " running");
}

function render() {
  const m = app.match;
  if (!m) return;
  paintClocks();

  const sig = [m.gameNo, m.pos.ply, m.result, m.started, m.myColor, app.selected,
    m.drawOfferedByMe, m.drawOfferedByOpp, m.rematchByMe, m.rematchByOpp,
    m.seatTaken, app.linkUp, boardVisible(), m.oppName, !!app.promoMoves,
    oppOverdue()].join("/");
  if (sig === app.rendered) return;
  app.rendered = sig;

  paintBoard();

  $("link-dot").className = "dot-link" + (app.linkUp ? " up" : "");
  $("opp-name").innerHTML = m.started
    ? `${escapeHtml(m.oppName)}<small>${m.oppColor === WHITE ? "Weiß" : "Schwarz"}</small>`
    : "Warte auf den Gegner…";
  $("my-name").innerHTML = `${escapeHtml(m.myName || "Du")}<small>${
    m.myColor === WHITE ? "Weiß" : m.myColor === BLACK ? "Schwarz" : ""}</small>`;
  $("opp-row").classList.toggle("turn", m.oppTurn);
  $("me-row").classList.toggle("turn", m.myTurn);

  $("moves").textContent = m.san
    .map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s))
    .join("  ");
  $("moves").scrollLeft = $("moves").scrollWidth;

  const status = $("status");
  status.textContent = statusText(m);
  status.className = m.over ? "over" : m.myTurn ? "mine" : "";
  $("substatus").textContent = subStatusText(m);

  const waiting = !m.started && !m.seatTaken;
  $("link-box").classList.toggle("hidden", !waiting);
  if (waiting) $("link-box").textContent = Codes.pretty(m.code);

  $("resign").disabled = !m.started || m.over;
  $("draw").disabled = !m.started || m.over || m.drawOfferedByMe;
  $("draw").textContent = m.drawOfferedByOpp ? "Remis annehmen" : m.drawOfferedByMe ? "Angeboten" : "Remis";

  const big = $("big-action");
  if (m.over) {
    big.classList.remove("hidden");
    big.textContent = m.rematchByMe ? "Revanche angefragt…" : "Revanche";
    big.disabled = m.rematchByMe;
    big.onclick = () => { m.askRematch(); render(); };
  } else if (oppOverdue()) {
    big.classList.remove("hidden");
    big.textContent = "Zeit reklamieren";
    big.disabled = false;
    big.onclick = () => { m.claimFlag(); render(); };
  } else {
    big.classList.add("hidden");
  }
}

function oppOverdue() {
  return app.match?.oppTurn && !app.oppClock.unlimited
    && app.oppClock.remaining(performance.now()) < -8000;
}

function statusText(m) {
  if (m.seatTaken) return "Diese Einladung hat schon jemand angenommen.";
  if (m.over) return m.resultLine();
  if (!m.started) return m.creator ? "Warte auf den Gegner." : "Verbinde mit der Partie…";
  if (m.drawOfferedByOpp) return `${m.oppName} bietet Remis an.`;
  if (m.drawOfferedByMe) return "Remisangebot verschickt.";
  if (m.myTurn) return inCheck(m.pos) ? "Schach! Du bist am Zug." : "Du bist am Zug.";
  return `${m.oppName} überlegt.`;
}

function subStatusText(m) {
  if (!app.linkUp) return "Keine Verbindung zum Relay — wird automatisch neu aufgebaut.";
  if (m.seatTaken) return "Lass dir eine neue Einladung schicken.";
  if (!m.started && m.creator) return "Schick ihm den Link — die Partie startet, sobald er da ist.";
  if (m.over) return "";
  if (!boardVisible()) return "Uhr angehalten, solange die Seite im Hintergrund ist.";
  if (m.myTurn && !app.myClock.unlimited) return "Deine Uhr läuft.";
  return "";
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// -------------------------------------------------------------------- lobby

function chips(container, values, labels, get, set) {
  container.innerHTML = "";
  values.forEach((value, i) => {
    const b = document.createElement("button");
    b.textContent = labels[i];
    b.dataset.value = value;
    b.addEventListener("click", () => { set(value); paintChips(); });
    container.appendChild(b);
  });
  container._get = get;
}

function paintChips() {
  for (const el of [$("color-chips"), $("my-time-chips"), $("opp-time-chips")]) {
    const current = el._get();
    for (const b of el.children) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.value) === current));
    }
  }
}

chips($("my-time-chips"), BUDGETS, BUDGET_LABELS,
  () => store.get("myBudget", 20000), (v) => store.set("myBudget", v));
chips($("opp-time-chips"), BUDGETS, BUDGET_LABELS,
  () => store.get("oppBudget", 0), (v) => store.set("oppBudget", v));
{
  const colorEl = $("color-chips");
  colorEl._get = () => store.get("colorChoice", 2);
  for (const b of colorEl.children) {
    b.addEventListener("click", () => { store.set("colorChoice", Number(b.dataset.value)); paintChips(); });
  }
}
paintChips();

$("name-input").value = store.get("name", "");

function currentName() {
  const n = ($("name-input").value || "").trim() || "Spieler";
  store.set("name", n);
  return n;
}

$("create").addEventListener("click", () => {
  const choice = store.get("colorChoice", 2);
  const color = choice === 2 ? (Math.random() < 0.5 ? WHITE : BLACK) : choice;
  const code = Codes.newCode();
  startSession(Match.create({
    code, myId: myId(), myName: currentName(), myColor: color,
    myBudget: store.get("myBudget", 20000), oppBudget: store.get("oppBudget", 0),
  }), true);
  shareInvite();
});

$("join").addEventListener("click", () => joinCode($("code-input").value));

function joinCode(raw) {
  const code = Codes.normalize(raw);
  if (!code) {
    $("substatus").textContent = "";
    alert("Das sieht nicht nach einem Code aus.");
    return;
  }
  startSession(Match.join({ code, myId: myId(), myName: currentName() }), true);
}

$("resume-open").addEventListener("click", resumeSaved);
$("resume-drop").addEventListener("click", () => { stopSession(true); showLobby(); });
$("leave").addEventListener("click", () => { showLobby(); });
$("resign").addEventListener("click", () => {
  if (confirm("Partie wirklich aufgeben?")) { app.match.resign(); render(); }
});
$("draw").addEventListener("click", () => {
  const m = app.match;
  if (m.drawOfferedByOpp) m.acceptDraw(); else m.offerDraw();
  render();
});
$("share").addEventListener("click", shareInvite);

async function shareInvite() {
  const m = app.match;
  if (!m) return;
  const text = Codes.invite(m.myName, m.code);
  try {
    if (navigator.share) { await navigator.share({ text }); return; }
  } catch { /* the sheet was dismissed — fall through to copying */ }
  try {
    await navigator.clipboard.writeText(text);
    $("substatus").textContent = "Einladung kopiert — jetzt in WhatsApp einfügen.";
  } catch {
    prompt("Einladung kopieren:", Codes.link(m.code));
  }
}

function resumeSaved() {
  const saved = store.get("game", null);
  if (!saved) return;
  const m = saved.creator
    ? Match.create({
        code: saved.code, myId: myId(), myName: currentName(),
        myColor: saved.color, myBudget: saved.myBudget, oppBudget: saved.oppBudget,
      })
    : Match.join({ code: saved.code, myId: myId(), myName: currentName() });
  startSession(m, true);
}

function showGame() {
  $("lobby").classList.add("hidden");
  $("game").classList.remove("hidden");
  window.scrollTo(0, 0);
}

function showLobby() {
  $("game").classList.add("hidden");
  $("lobby").classList.remove("hidden");
  paintResume();
}

function paintResume() {
  const saved = store.get("game", null);
  const card = $("resume-card");
  card.classList.toggle("hidden", !saved);
  if (saved) $("resume-info").textContent = Codes.pretty(saved.code);
}

// --------------------------------------------------------------- entry point

{
  const fromLink = Codes.normalize(location.search) || Codes.normalize(location.hash);
  if (fromLink) {
    history.replaceState(null, "", location.pathname);
    $("code-input").value = Codes.pretty(fromLink);
    if (store.get("name", "")) {
      joinCode(fromLink);
    } else {
      paintResume();
      $("name-input").focus();
      $("name-input").placeholder = "Dein Name — dann auf Beitreten tippen";
    }
  } else {
    paintResume();
  }
}
