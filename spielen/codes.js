/* Invite codes: what you type, what you send, and the relay topic behind it.
   Identical to the Android app's Codes.java, so both sides derive the same topic. */

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";   // no I, O, 0 or 1
export const LENGTH = 8;
export const SITE = "https://itsukewatanabe.github.io/spielen/";

export function newCode() {
  const bytes = new Uint8Array(LENGTH);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

/** Accepts a bare code, a grouped code, a link, or a whole pasted message. Null if none. */
export function normalize(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toUpperCase();
  const q = s.indexOf("?C=");
  if (q >= 0) {
    const hit = exactRun(cut(s.slice(q + 3)));
    if (hit) return hit;
  }
  const j = s.indexOf("JOIN/");
  if (j >= 0) {
    const hit = exactRun(cut(s.slice(j + 5)));
    if (hit) return hit;
  }
  return exactRun(s);
}

const cut = (s) => s.split(/[&#/\s]/)[0];

/**
 * A run of exactly LENGTH alphabet characters (dashes and spaces inside a run are ignored).
 * Demanding the exact length is what keeps words out: "SCHACHDUE" is a run too, just wrong-sized.
 */
function exactRun(s) {
  let run = "";
  for (const ch of s + "\n") {
    if (ALPHABET.includes(ch)) { run += ch; continue; }
    if (ch === "-" || ch === " ") continue;
    if (run.length === LENGTH) return run;
    run = "";
  }
  return run.length === LENGTH ? run : null;
}

export const pretty = (code) =>
  code && code.length === LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : (code || "");

export const topic = (code) => `schachduell-${code.toLowerCase()}`;
export const link = (code) => `${SITE}?c=${code}`;

export const invite = (name, code) =>
  `${name || "Ich"} fordert dich zu einer Partie Schach heraus.\n\n`
  + `${link(code)}\n\n`
  + `Einfach antippen — kein Download, läuft im Browser.\n`
  + `Code zum Eintippen: ${pretty(code)}`;
