'use strict';

// Public live feed (V3.5), served as server-sent events.
//
// The emitter is in-process, which assumes a single replica: a second instance
// would only stream the runs it served itself. That is fine for one Railway
// service and is called out in the deployment notes; going multi-replica means
// moving this onto Postgres LISTEN/NOTIFY.
//
// Only public identity travels here - display name, avatar, mode, time, clicks,
// fail reason and phase. Anonymous players have no identity and generate
// nothing.

const DEFAULT_MAX_CLIENTS = 200;
const DEFAULT_MAX_INFLIGHT_SAVES = 32;
const KEEP_ALIVE_MS = 25000;
// V3.6 replay depth. Matches the client's 50-line log, so a cold page load
// can fill it completely from history alone.
const DEFAULT_HISTORY = 50;

function createFeed(options = {}) {
  const maxClients = options.maxClients || DEFAULT_MAX_CLIENTS;
  const keepAliveMs = options.keepAliveMs || KEEP_ALIVE_MS;
  const historySize = options.historySize || DEFAULT_HISTORY;
  const maxInflightSaves = options.maxInflightSaves || DEFAULT_MAX_INFLIGHT_SAVES;
  const now = options.now || Date.now;
  // V3.7: optional persistence hook, called fire-and-forget on every emit so
  // the replay buffer can be reloaded after a restart (see seed below). A
  // failed write costs one line of history, never a request.
  const save = options.save || null;
  // Insertion-ordered, so the oldest connection is the first one dropped.
  const clients = new Set();
  // The recent past, newest last. Frames are prebuilt: replay is a plain
  // write, and an event is serialised exactly once no matter who reads it.
  const history = [];
  let seq = 0;
  let keepAlive = null;
  let inflightSaves = 0;
  let droppedSaves = 0;

  function startKeepAlive() {
    if (keepAlive) return;
    keepAlive = setInterval(() => {
      for (const client of clients) {
        try {
          if (client.write(': keep-alive\n\n') === false) drop(client);
        } catch {
          drop(client);
        }
      }
    }, keepAliveMs);
    // Never hold the process open on account of an idle stream.
    if (typeof keepAlive.unref === 'function') keepAlive.unref();
  }

  function stopKeepAlive() {
    if (!keepAlive) return;
    clearInterval(keepAlive);
    keepAlive = null;
  }

  function drop(client) {
    if (!clients.delete(client)) return;
    try {
      client.end();
    } catch {
      // Already gone.
    }
    if (clients.size === 0) stopKeepAlive();
  }

  // res is an http response already switched into event-stream mode.
  // `after` is the last event id the client already saw (0 = nothing): the
  // recent past beyond it replays immediately, so a fresh page load never
  // opens onto an empty log and a reconnect never sees a line twice.
  function subscribe(res, after = 0) {
    // A cursor beyond our own counter is from a previous process life (the
    // counter restarts on deploy); everything in this buffer is news to that
    // client, so replay from the top rather than starving it.
    if (after > seq) after = 0;
    if (clients.size >= maxClients) {
      const oldest = clients.values().next().value;
      if (oldest) drop(oldest);
    }
    clients.add(res);
    startKeepAlive();
    res.on('close', () => drop(res));
    try {
      if (res.write(': connected\n\n') === false) {
        drop(res);
        return () => {};
      }
      for (const entry of history) {
        if (entry.seq > after && res.write(entry.frame) === false) {
          drop(res);
          break;
        }
      }
    } catch {
      drop(res);
    }
    return () => drop(res);
  }

  function frameOf(id, type, stamped) {
    return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(stamped)}\n\n`;
  }

  // V3.7: reload the buffer from storage at boot, BEFORE the server listens.
  // Entries arrive oldest first with the ids they were saved under, and the
  // counter resumes past them, so ids stay monotonic across restarts and a
  // held cursor keeps meaning what it meant.
  function seed(entries) {
    if (seq !== 0 || history.length > 0) return 0;   // boot-only, never a merge
    for (const entry of entries.slice(-historySize)) {
      history.push({ seq: entry.id, frame: frameOf(entry.id, entry.type, entry.data) });
      seq = entry.id;
    }
    return history.length;
  }

  function emit(type, data) {
    seq += 1;
    // Stamped here so a replayed line can say when it actually happened
    // rather than when the viewer connected.
    const stamped = { ...data, at: now() };
    const frame = frameOf(seq, type, stamped);
    // History is written even with an empty room: what happened while nobody
    // watched is exactly what the next page load wants to see.
    history.push({ seq, frame });
    if (history.length > historySize) history.shift();
    if (save) {
      if (inflightSaves >= maxInflightSaves) {
        droppedSaves += 1;
      } else {
        inflightSaves += 1;
        try {
          Promise.resolve(save(seq, type, stamped))
            .catch(() => {})
            .finally(() => { inflightSaves -= 1; });
        } catch {
          // A throwing hook must never take a request down with it.
          inflightSaves -= 1;
        }
      }
    }
    if (clients.size === 0) return 0;
    let delivered = 0;
    for (const client of [...clients]) {
      try {
        if (client.write(frame) === false) {
          drop(client);
          continue;
        }
        delivered += 1;
      } catch {
        drop(client);
      }
    }
    return delivered;
  }

  function closeAll() {
    for (const client of [...clients]) drop(client);
    stopKeepAlive();
  }

  return {
    subscribe,
    emit,
    seed,
    closeAll,
    size: () => clients.size,
    inflightSaves: () => inflightSaves,
    droppedSaves: () => droppedSaves,
    maxClients,
  };
}

module.exports = {
  createFeed,
  DEFAULT_MAX_CLIENTS,
  DEFAULT_MAX_INFLIGHT_SAVES,
  KEEP_ALIVE_MS,
  DEFAULT_HISTORY,
};
