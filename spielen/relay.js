/*
 * The transport: a public ntfy.sh topic used as a message bus.
 *
 * Both players are behind carrier NAT on different networks, so nothing connects directly.
 * ntfy.sh is a free relay spoken over plain HTTPS, sends `Access-Control-Allow-Origin: *`, and
 * offers a Server-Sent-Events endpoint — so a static page can use it with no server of its own.
 *
 * Subscribing with `since=all` replays the topic's 12 h cache, which is what makes a reload, a
 * dropped connection or a second device rebuild the whole game for free. Duplicates from those
 * replays are filtered on the relay's own message ids.
 */

const BASE = "https://ntfy.sh/";
/** ntfy sends a keepalive every ~45 s; longer than that without a byte means the stream is gone. */
const SILENCE_MS = 90_000;

export class Relay {
  constructor(topic, { onMessage, onLink }) {
    this.topic = topic;
    this.onMessage = onMessage;
    this.onLink = onLink;
    this.seen = new Set();
    this.outbox = [];
    this.sending = false;
    this.source = null;
    this.watchdog = null;
    this.lastBeat = 0;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.stopped) return;
      if (Date.now() - this.lastBeat > SILENCE_MS) this.connect();   // silent stream: rebuild it
    }, 15_000);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    if (this.source) this.source.close();
    this.source = null;
  }

  connect() {
    if (this.source) this.source.close();
    this.lastBeat = Date.now();
    this.catchUp();
    const source = new EventSource(`${BASE}${this.topic}/sse?since=all`);
    this.source = source;

    source.onopen = () => {
      this.lastBeat = Date.now();
      this.onLink(true);
    };
    source.onerror = () => {
      this.onLink(false);                 // EventSource retries on its own; the watchdog backs it up
    };
    source.onmessage = (event) => {
      this.lastBeat = Date.now();
      this.onLink(true);
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.event !== "message" || !payload.message) return;
      if (payload.id && this.seen.has(payload.id)) return;           // replayed, already handled
      if (payload.id) this.seen.add(payload.id);
      this.onMessage(payload.message);
    };
  }

  /**
   * Pulls the topic's history in one plain request, on top of the stream's own replay.
   *
   * The stream is a live wire, not a guaranteed archive: a subscription can open, hand over
   * part of the cache and then simply go quiet — which looked exactly like a half-finished
   * game. This request either returns the whole history or fails outright, and the ids make
   * the overlap with the stream free.
   */
  async catchUp() {
    try {
      const res = await fetch(`${BASE}${this.topic}/json?poll=1&since=all`);
      if (!res.ok) return;
      for (const line of (await res.text()).split("\n")) {
        if (!line.trim() || this.stopped) continue;
        let payload;
        try { payload = JSON.parse(line); } catch { continue; }
        if (payload.event !== "message" || !payload.message) continue;
        if (payload.id && this.seen.has(payload.id)) continue;
        if (payload.id) this.seen.add(payload.id);
        this.onMessage(payload.message);
      }
    } catch { /* the stream is the other half of this; it retries by itself */ }
  }

  /** Queues a line. Never drops it — a flaky network only delays the move. */
  send(line) {
    if (!line) return;
    this.outbox.push(line);
    this.drain();
  }

  async drain() {
    if (this.sending) return;
    this.sending = true;
    let wait = 1000;
    while (this.outbox.length && !this.stopped) {
      const line = this.outbox[0];
      let ok = false;
      try {
        const res = await fetch(BASE + this.topic, {
          method: "POST",
          headers: { "Content-Type": "text/plain; charset=utf-8" },
          body: line,
        });
        ok = res.ok;
      } catch { ok = false; }
      if (ok) {
        this.outbox.shift();
        wait = 1000;
      } else {
        this.onLink(false);
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 2, 15_000);
      }
    }
    this.sending = false;
  }

  get pending() { return this.outbox.length; }
}
