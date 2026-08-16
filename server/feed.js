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
const KEEP_ALIVE_MS = 25000;

function createFeed(options = {}) {
  const maxClients = options.maxClients || DEFAULT_MAX_CLIENTS;
  const keepAliveMs = options.keepAliveMs || KEEP_ALIVE_MS;
  // Insertion-ordered, so the oldest connection is the first one dropped.
  const clients = new Set();
  let keepAlive = null;

  function startKeepAlive() {
    if (keepAlive) return;
    keepAlive = setInterval(() => {
      for (const client of clients) {
        try {
          client.write(': keep-alive\n\n');
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
  function subscribe(res) {
    if (clients.size >= maxClients) {
      const oldest = clients.values().next().value;
      if (oldest) drop(oldest);
    }
    clients.add(res);
    startKeepAlive();
    res.on('close', () => drop(res));
    res.write(': connected\n\n');
    return () => drop(res);
  }

  function emit(type, data) {
    if (clients.size === 0) return 0;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    let delivered = 0;
    for (const client of [...clients]) {
      try {
        client.write(frame);
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
    closeAll,
    size: () => clients.size,
    maxClients,
  };
}

module.exports = { createFeed, DEFAULT_MAX_CLIENTS, KEEP_ALIVE_MS };
