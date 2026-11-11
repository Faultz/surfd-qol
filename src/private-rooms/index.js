import { createRoomHost } from './host.js';
import { createRoomId, isPrivateRoomId, parseRoomCode } from './ids.js';
import { commandReply } from './commands.js';
import { CLOSE, DEFAULT_MAX_PLAYERS, MAX_ROOM_PLAYERS, ROOM_TEXTS, catalogEntry, createRoomControlReader, decodeControl, isGuestName, isMaxPlayers, isPlayerName, isRoomName, isUuid, normalizeRoomName, rankTable, roomNameProblem } from './protocol.js';
import { createClosedSocket, createLoopbackPair, createPeerSocket, listenRoom } from './socket.js';
import { connectSignal, newHostKey, relayServers, SIGNAL_URL } from './signal-client.js';
import { createRoomUi } from './ui.js';
import { createSharedSavelocs } from './shared-savelocs.js';
import { createRoomPaint } from './room-paint.js';
import { courseOf } from '../courses.js';

const CLOSED = ROOM_TEXTS.closed;
const SERVICE = "Couldn't reach the room service. Try again in a moment.";
const HOST_LEFT = ROOM_TEXTS.hostClosed;
const SIGN_IN = 'Sign in to host a room.';
const BAD_CODE = 'Check the room code.';
const DISCOVERY_TIMEOUT = 15000;
const DIRECTORY_SIZE = 200;
const DIRECTORY_TIMEOUT = 5000;
// Relay credentials: time to get an answer, lead time before expiry to renew, retry delay after a failed renewal.
const RELAY_TIMEOUT = 10000, RELAY_RENEW_MS = 15 * 60 * 1000, RELAY_RETRY_MS = 60000;
const DROP_WINDOW = 30000, MAX_DROPS = 3;
const VISIBILITY_KEY = 'surfd-qol-room-visibility';
const MAX_PLAYERS_KEY = 'surfd-qol-room-max-players';
const NAME_KEY = 'surfd-qol-room-guest-name';
const BROWSER_KEY = 'surfd-qol-room-browser';
// The game keeps at most six runs waiting for the site.
const PENDING_RUNS = 6;

export function createPrivateRooms({ getAdapter, getState = () => globalThis.__SURF__?.snapshot?.() ?? null, signalFactory = connectSignal,
  fetch: fetchRooms = (...args) => globalThis.fetch(...args), now = Date.now,
  timers = globalThis, events = globalThis, storage,
  socketFactory = createPeerSocket, listen = listenRoom, uiFactory = createRoomUi } = {}) {
  const document = events.document;
  const known = new Map(), directory = new Map(), guests = new Map(), gone = new Set(), drops = new Map();
  const sockets = new Map(), latestSockets = new Map();
  const roomStates = new WeakMap();
  let currentSocket = null;
  let sharedSaves = null, roomPaint = null;
  let uploadSamples = new WeakMap(), uploadTimer = null, showingDetails = false;
  let hosted = null, ui = null, heartbeat = null, destroyed = false, attached = false, listening = false;
  let lastDirectory = -Infinity, directoryRequest = null, directoryTimer = null, sampling = false;
  let directoryError = '';
  let browserVisible = null, menuVisible = null, directoryAbort = null, chosenName = null;
  let pendingJoin = null;
  // Finishes sent for verification, waiting on the site's verdict, by attempt id.
  const pendingRuns = new Map();
  let queuedRun, stopVerdicts = null;
  const stored = key => { try { return (storage ?? globalThis.localStorage)?.getItem(key); } catch { return null; } };
  const store = (key, value) => { try { (storage ?? globalThis.localStorage)?.setItem(key, value); } catch { /* Storage may be disabled. */ } };
  let visibility = stored(VISIBILITY_KEY) === 'private' ? 'private' : 'public';
  let name = stored(NAME_KEY);
  const savedMaxPlayers = Number(stored(MAX_PLAYERS_KEY));
  let maxPlayers = isMaxPlayers(savedMaxPlayers) ? savedMaxPlayers : DEFAULT_MAX_PLAYERS;

  function guestName() {
    if (!/^Guest_[0-9a-f]{5}$/.test(name ?? '')) {
      name = `Guest_${newHostKey().slice(0, 5)}`;
      store(NAME_KEY, name);
    }
    return name;
  }
  // Lets a host's ban outlast a rejoin.
  function browserId() {
    let id = stored(BROWSER_KEY);
    if (!isUuid(id)) {
      id = crypto.randomUUID();
      store(BROWSER_KEY, id);
    }
    return id;
  }
  function rooms() {
    if (destroyed) throw new Error(CLOSED);
    const adapter = getAdapter()?.rooms;
    if (!adapter) throw new Error('Private rooms are unavailable in this game build.');
    return adapter;
  }
  function directoryVisible() {
    if (document?.hidden) return false;
    const adapter = getAdapter()?.rooms;
    return !!(adapter?.browserOpen?.() || adapter?.menuOpen?.());
  }
  function mergeRooms(rows) {
    const community = new Map(directory);
    for (const [id, row] of known) {
      const listed = directory.get(id);
      if (id === hosted?.id || latestSockets.has(id) || guests.has(id)) community.set(id, row);
      else if (listed) community.set(id, {...listed, ping: row.ping ?? listed.ping});
    }
    for (const id of gone) community.delete(id);
    return [...rows.filter(row => !isPrivateRoomId(row.id)), ...community.values()];
  }
  function updateLobby(force = false) {
    const adapter = getAdapter()?.rooms;
    if (destroyed || (!force && !directoryVisible())) return;
    if (adapter) adapter.update(mergeRooms(adapter.rows()));
    ui?.refresh();
  }
  function normalizeRoster(players, limit = MAX_ROOM_PLAYERS, ownConnectionId = null) {
    if (!Array.isArray(players)) return [];
    const roster = [];
    for (const player of players.slice(0, limit)) {
      if (!player || !isPlayerName(player.name) || typeof player.guest !== 'boolean' ||
          (player.guest ? !isGuestName(player.name) || player.userId !== undefined
            : player.userId !== undefined && !isUuid(player.userId))) continue;
      roster.push({name: player.name, guest: player.guest,
        ...(!player.guest && player.userId !== undefined ? {userId: player.userId} : {}),
        ...(ownConnectionId !== null && player.connectionId === ownConnectionId ? {you: true} : {})});
    }
    return roster;
  }
  // Rows come from the host; map titles always come from the local catalog.
  function normalize(row, publicRoom = false, ownConnectionId = null) {
    const map = row && getAdapter()?.rooms?.maps().find(entry => entry.id === row.mapId);
    if (!map || !isPrivateRoomId(row.id) || !isRoomName(row.name) ||
        !isMaxPlayers(row.capacity) || !Number.isSafeInteger(row.players) ||
        row.players < 0 || row.players > MAX_ROOM_PLAYERS) return null;
    const publicVisibility = publicRoom || row.visibility === 'public';
    return {id: row.id, name: row.name, mapId: map.id, mapTitle: catalogEntry(map).title,
      players: row.players, capacity: row.capacity, visibility: publicVisibility ? 'public' : 'private',
      region: publicVisibility ? 'Public' : 'Private', endsAt: 0, untimed: true,
      online: true, epoch: Number.isSafeInteger(row.epoch) && row.epoch > 0 ? row.epoch : 1,
      ping: known.get(row.id)?.ping ?? directory.get(row.id)?.ping ?? null,
      roster: normalizeRoster(row.roster, publicRoom ? 24 : MAX_ROOM_PLAYERS, ownConnectionId)};
  }
  function hostRow() {
    const {state, players} = hosted.room;
    return {id: state.roomId, name: state.name, mapId: state.mapId, mapTitle: state.mapTitle.slice(0, 64),
      epoch: state.epoch, players: players.length, capacity: state.maxPlayers, visibility: hosted.visibility,
      roster: players};
  }
  function publish(force = false) {
    if (!hosted) return;
    updateHostTimers();
    const row = hostRow();
    known.set(row.id, normalize(row, false, hosted.ownConnectionId));
    const data = hosted.visibility === 'public'
      ? {name: row.name, mapId: row.mapId, players: row.players, capacity: row.capacity,
        roster: normalizeRoster(row.roster, 24)} : null;
    const serialized = JSON.stringify(data);
    if ((force || serialized !== hosted.listing) && hosted.signal?.send(null, 'listing', data)) {
      hosted.listing = serialized;
    }
    updateLobby();
  }
  function relay(signal, id, host) {
    const subscribers = new Set(), peers = new Set(), queued = [];
    if (host) {
      signal.on('peer-joined', peer => peers.add(peer));
      signal.on('peer-left', peer => {
        peers.delete(peer);
        for (const callback of subscribers) callback({roomId: id, peerId: peer, type: 'peer-left'});
      });
    }
    signal.on('message', message => {
      if (typeof message.from !== 'string' || (!host && message.from !== signal.host)) return;
      if (host) peers.add(message.from);
      for (const callback of subscribers) callback({roomId: id,
        peerId: host ? message.from : signal.id, type: message.type, payload: message.data});
    });
    signal.on('ready', () => {
      for (const message of queued.splice(0)) {
        if (!host || peers.has(message.peerId)) signal.send(host ? message.peerId : null, message.type, message.payload);
      }
    });
    return {
      send(message) {
        if (signal.state === 'closed' || (host && !peers.has(message.peerId))) return false;
        if (signal.state !== 'open') { queued.push(message); return false; }
        return signal.send(host ? message.peerId : null, message.type, message.payload);
      },
      subscribe(callback) { subscribers.add(callback); return () => subscribers.delete(callback); }
    };
  }
  function markGone(id) {
    gone.add(id);
    known.delete(id);
    directory.delete(id);
    updateLobby();
  }
  function finishDiscovery(session, error, row) {
    if (!session.waiting) return;
    timers.clearTimeout(session.timer);
    const waiting = session.waiting;
    session.waiting = null;
    if (error) waiting.reject(error);
    else waiting.resolve(row);
  }
  function closeGuest(session) {
    if (guests.get(session.id) === session) guests.delete(session.id);
    timers.clearTimeout(session.idleTimer);
    session.intentional = true;
    session.signal.close();
    finishDiscovery(session, new Error(CLOSED));
  }
  function guestSession(id) {
    const existing = guests.get(id);
    if (existing && existing.signal.state !== 'closed') return existing;
    const signal = signalFactory({url: SIGNAL_URL, roomId: id, role: 'guest'});
    const session = {id, signal, socket: null, waiting: null, intentional: false};
    guests.set(id, session);
    signal.on('ready', () => signal.send(null, 'room-info', null));
    session.signalling = relay(signal, id, false);
    signal.on('message', message => {
      if (message.from !== signal.host || message.type !== 'room-info' || message.data?.id !== id) return;
      if (message.data.online === false) {
        markGone(id);
        finishDiscovery(session, new Error(CLOSED));
        session.socket?.close(4004, CLOSED);
        closeGuest(session);
        return;
      }
      const row = normalize(message.data);
      if (!row) return;
      known.set(id, row);
      finishDiscovery(session, null, row);
      updateLobby();
    });
    signal.on('closed', reason => {
      if (session.intentional) return;
      if (guests.get(id) === session) guests.delete(id);
      timers.clearTimeout(session.idleTimer);
      const terminal = reason === 'no-room' || reason === 'room-closed';
      if (terminal) markGone(id);
      finishDiscovery(session, new Error(terminal ? CLOSED : SERVICE));
      if (session.socket?.readyState < 2) session.socket.close(terminal ? 4004 : 4000, terminal ? CLOSED : SERVICE);
    });
    if (signal.state === 'open') signal.send(null, 'room-info', null);
    return session;
  }
  function discover(id) {
    if (destroyed || gone.has(id)) return Promise.reject(new Error(CLOSED));
    if (id === hosted?.id) return Promise.resolve(known.get(id));
    const session = guestSession(id);
    if (session.waiting) return session.waiting.promise;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    session.waiting = {promise, resolve, reject};
    session.timer = timers.setTimeout(() => {
      finishDiscovery(session, new Error(SERVICE));
      closeGuest(session);
    }, DISCOVERY_TIMEOUT);
    if (session.signal.state === 'open') session.signal.send(null, 'room-info', null);
    return promise;
  }
  function hello() {
    const adapter = rooms();
    const name = adapter.displayName(), guest = adapter.guest();
    const profile = guest ? null : adapter.profile?.() ?? null;
    return {name: isPlayerName(name) ? name : guestName(), appearance: adapter.appearance(), guest,
      userId: guest ? null : adapter.userId?.() ?? null, browserId: browserId(),
      ...(profile ? {rank: profile.rank, points: profile.points} : {})};
  }
  const ranks = () => rankTable(getAdapter()?.rooms?.ranks?.());
  async function siteRead(query) {
    const response = await fetchRooms('/api/surf?' + new URLSearchParams(query), {credentials: 'omit', cache: 'no-store'});
    // Rate limits and outages say nothing about what was asked.
    if (response.status === 429 || response.status >= 500) throw new Error(SERVICE);
    return response.ok ? response.json() : null;
  }
  // The uncached board, as the game reads it right after a verified run.
  async function siteBoard(mapId, course = 0) {
    const boardId = getAdapter()?.rooms?.boardId?.(mapId, course);
    return typeof boardId === 'string' && boardId ? siteRead({action: 'leaderboard', boardId}) : null;
  }
  // Drops the runs waiting on a socket, or all of them, and stops watching verdicts once none wait.
  function forgetRuns(socket = null) {
    for (const [id, run] of pendingRuns) if (socket === null || run.socket === socket) pendingRuns.delete(id);
    if (!pendingRuns.size) { stopVerdicts?.(); stopVerdicts = null; }
  }
  // The site's verdict on a room finish: a verified run with its result goes to the host for checking;
  // a rejected one, or one without a result, gets the unverified announcement.
  function verdict(id, submission) {
    const run = pendingRuns.get(id), status = submission?.status;
    if (!run || (status !== 'verified' && status !== 'rejected')) return;
    pendingRuns.delete(id);
    if (!pendingRuns.size) forgetRuns();
    const {socket, claim} = run;
    if (destroyed || socket !== currentSocket || socket.readyState !== 1) return;
    socket.send(JSON.stringify(status === 'verified' && verifiedClaim(claim, submission.result) || claim));
  }
  function verifiedClaim(claim, result) {
    if (!result || typeof result !== 'object' || result.mapId !== claim.mapId) return null;
    const bonus = Number.isSafeInteger(result.bonus) && result.bonus > 0 ? result.bonus : 0;
    if (bonus !== claim.course) return null;
    const personalBest = result.personalBest === true, record = result.record === true, promoted = result.promoted === true;
    const ranked = Number.isSafeInteger(result.leaderboardRank) && Number.isSafeInteger(result.leaderboardTotal)
      && result.leaderboardRank > 0 && result.leaderboardTotal >= result.leaderboardRank;
    try {
      return decodeControl(JSON.stringify({type: 'verified', ...(isUuid(result.id) ? {id: result.id} : {}),
        mapId: claim.mapId, epoch: claim.epoch, course: claim.course, timeUs: result.timeUs, personalBest, record,
        previousBestUs: (personalBest || record) && Number.isSafeInteger(result.previousBestUs) && result.previousBestUs > result.timeUs
          ? result.previousBestUs : null,
        pointsDelta: Number.isSafeInteger(result.pointsDelta) && result.pointsDelta > 0 ? result.pointsDelta : 0, promoted,
        ...(promoted ? {rank: result.rank} : {}),
        ...(ranked ? {leaderboardRank: result.leaderboardRank, leaderboardTotal: result.leaderboardTotal} : {})}));
    } catch { return null; }
  }
  // The site's public profile for an account, read without credentials.
  async function siteProfile(userId) {
    return (await siteRead({action: 'progression', userId}))?.player ?? null;
  }
  const roomName = () => `${hello().name}'s room`;
  // TURN relay credentials, {config, ttl}, over a meeting point connection
  // that is open or opening. Rejects with the service copy.
  function askRelay(signal) {
    if (signal.state === 'closed') return Promise.reject(new Error(SERVICE));
    return new Promise((resolve, reject) => {
      const stops = [];
      const settle = (callback, value) => {
        for (const stop of stops.splice(0)) stop();
        timers.clearTimeout(timer);
        callback(value);
      };
      const timer = timers.setTimeout(() => settle(reject, new Error(SERVICE)), RELAY_TIMEOUT);
      // A host that reconnects asks again: an answer to its old socket is lost.
      const ask = () => signal.send(null, 'ice-servers', null);
      stops.push(signal.on('ice-servers', data => {
        const relay = relayServers(data);
        if (relay) settle(resolve, relay);
        else settle(reject, new Error(SERVICE));
      }));
      stops.push(signal.on('error', data => { if (data?.code === 'no-relay') settle(reject, new Error(SERVICE)); }));
      stops.push(signal.on('closed', () => settle(reject, new Error(SERVICE))));
      stops.push(signal.on('ready', ask));
      if (signal.state === 'open') ask();
    });
  }
  // A guest asks on a meeting point connection of its own, closed straight after.
  async function guestRelay(id) {
    const signal = signalFactory({url: SIGNAL_URL, roomId: id, role: 'guest'});
    try { return await askRelay(signal); } finally { signal.close(); }
  }
  // Renews credentials of ttl seconds before they expire, and again each
  // time, until the returned stop() is called.
  function keepRelay(ttl, renew, apply) {
    let timer = null, stopped = false;
    const wait = seconds => { timer = timers.setTimeout(attempt, Math.max(seconds * 500, seconds * 1000 - RELAY_RENEW_MS)); };
    async function attempt() {
      timer = null;
      try {
        const relay = await renew();
        if (stopped) return;
        apply(relay.config);
        wait(relay.ttl);
      } catch {
        if (!stopped) timer = timers.setTimeout(attempt, RELAY_RETRY_MS);
      }
    }
    wait(ttl);
    return () => { stopped = true; timers.clearTimeout(timer); };
  }
  function track(socket, id) {
    const ownHost = id === hosted?.id;
    sockets.set(socket, id);
    latestSockets.set(id, socket);
    sharedSaves?.close();
    const practice = getAdapter()?.practice;
    const shared = typeof practice?.shared === 'function' ? createSharedSavelocs({
      practice, now,
      send: message => { if (socket === currentSocket && socket.readyState === 1) socket.send(JSON.stringify(message)); },
      invalid: () => socket.close(CLOSE.invalid, ROOM_TEXTS.invalidData),
      notice: text => getAdapter()?.notice?.(text),
    }) : null;
    sharedSaves = shared;
    roomPaint?.close();
    const paint = roomPaint = createRoomPaint({
      timers,
      send: message => { if (socket === currentSocket && socket.readyState === 1) socket.send(JSON.stringify(message)); },
      invalid: () => socket.close(CLOSE.invalid, ROOM_TEXTS.invalidData),
    });
    currentSocket = socket;
    let pingAt = null, opened = false, ownConnectionId = null;
    const incoming = createRoomControlReader();
    socket.addEventListener('open', () => { opened = true; ui?.refresh(); }, {once: true});
    const send = socket.send.bind(socket);
    socket.send = data => {
      if (data === 'ping' && socket.readyState === 1) pingAt = now();
      return send(data);
    };
    socket.addEventListener('message', event => {
      if (latestSockets.get(id) !== socket) return;
      const previous = known.get(id) ?? directory.get(id);
      if (event.data === 'pong' && pingAt !== null) {
        const elapsed = now() - pingAt;
        pingAt = null;
        if (previous && elapsed >= 0 && Number.isFinite(elapsed)) { previous.ping = elapsed; updateLobby(); }
        return;
      }
      if (typeof event.data !== 'string' || event.data === 'pong') return;
      let message;
      try {
        const text = incoming.read(event.data);
        if (text === null) return;
        message = JSON.parse(text);
      } catch { return; }
      if (typeof message?.type !== 'string') return;
      if (message.type.startsWith('saveloc-')) {
        if (socket === currentSocket) shared?.receive(message);
        return;
      }
      if (message.type.startsWith('paint-')) {
        if (socket === currentSocket) paint.receive(message);
        return;
      }
      if (!['welcome', 'state', 'roster'].includes(message.type)) return;
      if (message.type === 'welcome' && ownConnectionId === null && isUuid(message.player?.connectionId)) {
        ownConnectionId = message.player.connectionId;
        if (ownHost && id === hosted?.id) {
          hosted.ownConnectionId = ownConnectionId;
          publish();
        }
      }
      if (message.type === 'welcome' || message.type === 'state') {
        const state = message.state, accepted = roomStates.get(socket);
        if (state?.roomId === id && Number.isInteger(state.epoch) && state.epoch > 0 && state.epoch <= 0xffffffff &&
            getAdapter()?.rooms?.maps().some(map => map.id === state.mapId) &&
            (!accepted || state.epoch > accepted.epoch || state.epoch === accepted.epoch && state.mapId === accepted.mapId)) {
          roomStates.set(socket, {mapId: state.mapId, epoch: state.epoch});
          if (socket === currentSocket) { shared?.state(state); paint.state(state); }
        }
      }
      if (ownHost || !previous) return;
      const state = message.state;
      const players = message.players;
      const row = normalize({...previous,
        ...(state ? {name: state.name ?? previous.name, mapId: state.mapId ?? previous.mapId,
          epoch: state.epoch ?? previous.epoch, visibility: state.visibility ?? previous.visibility,
          capacity: state.maxPlayers ?? previous.capacity} : {}),
        ...(Array.isArray(players) ? {players: players.length, roster: players} : {})}, false, ownConnectionId);
      if (row) {
        if (!Array.isArray(players)) row.roster = previous.roster;
        known.set(id, row);
        updateLobby();
      }
    });
    socket.addEventListener('close', event => {
      incoming.clear();
      sockets.delete(socket);
      forgetRuns(socket);
      if (currentSocket === socket) {
        currentSocket = null;
        shared?.close();
        if (sharedSaves === shared) sharedSaves = null;
        paint.close();
        if (roomPaint === paint) roomPaint = null;
      }
      if (latestSockets.get(id) !== socket) return;
      latestSockets.delete(id);
      if (opened && !ownHost) drops.set(id, [...recentDrops(id), now()]);
      if (event.code === 4004) {
        markGone(id);
        if (!ownHost && !destroyed) getAdapter()?.rooms?.notice?.(event.reason === HOST_LEFT ? HOST_LEFT : CLOSED);
      } else if (!ownHost && !destroyed && event.reason &&
          (event.code === 1006 || event.code === CLOSE.refused || event.reason === SERVICE)) {
        getAdapter()?.rooms?.notice?.(event.reason);
      }
      if (!ownHost) known.delete(id);
      updateLobby();
      ui?.refresh();
    }, {once: true});
    // Entering a room marks the page for the room's CSS before the game connects.
    ui?.refresh();
    return socket;
  }
  function recentDrops(id) {
    const recent = (drops.get(id) ?? []).filter(time => now() - time < DROP_WINDOW);
    if (recent.length) drops.set(id, recent);
    else drops.delete(id);
    return recent;
  }
  function closeHost() {
    const closing = hosted;
    if (!closing) return;
    cancelJoin(closing.id);
    hosted = null;
    timers.clearInterval(heartbeat);
    heartbeat = null;
    timers.clearInterval(uploadTimer);
    uploadTimer = null; showingDetails = false;
    uploadSamples = new WeakMap();
    markGone(closing.id);
    closing.signal?.send(null, 'listing', null);
    closing.room.close();
    closing.stop?.();
    closing.stopAccount?.();
    closing.stopRelay?.();
    closing.signal?.close();
  }
  async function sampleUpload() {
    const current = hosted, samples = uploadSamples;
    if (!current || sampling || !showingDetails || !getAdapter()?.rooms?.browserOpen?.()) return;
    sampling = true;
    try {
      let total = 0, measured = false;
      await Promise.all([...current.sockets].map(async socket => {
        const report = await socket.getStats();
        let transport = 0, channels = 0, hasTransport = false;
        for (const stat of report.values()) {
          if (!Number.isFinite(stat.bytesSent)) continue;
          if (stat.type === 'transport') { transport += stat.bytesSent; hasTransport = true; }
          else if (stat.type === 'data-channel') channels += stat.bytesSent;
        }
        const bytes = hasTransport ? transport : channels, time = now();
        const previous = samples.get(socket);
        samples.set(socket, {bytes, time});
        if (previous && time > previous.time && bytes >= previous.bytes) {
          total += (bytes - previous.bytes) * 8 / ((time - previous.time) * 1000);
          measured = true;
        }
      }));
      if (hosted === current && samples === uploadSamples && showingDetails) {
        current.uploadMbps = measured ? total : null; ui?.refresh();
      }
    } catch { /* A peer may close while its stats are being collected. */ }
    finally { sampling = false; }
  }
  function setup() {
    if (listening) return;
    listening = true;
    events.addEventListener?.('pagehide', pagehide);
    document?.addEventListener?.('visibilitychange', pageVisibility);
  }
  function updateHostTimers() {
    if (hosted?.visibility === 'public') {
      heartbeat ??= timers.setInterval(() => publish(true), 30000);
    } else {
      timers.clearInterval(heartbeat);
      heartbeat = null;
    }
    if (hosted && showingDetails) {
      uploadTimer ??= timers.setInterval(() => void sampleUpload(), 5000);
    } else {
      timers.clearInterval(uploadTimer);
      uploadTimer = null;
    }
  }
  function pagehide() { api.destroy(); }
  function cancelJoin(id) {
    if (!pendingJoin || (id != null && pendingJoin.id !== id)) return;
    const joining = pendingJoin;
    pendingJoin = null;
    const session = guests.get(joining.id);
    if (session && !session.socket) closeGuest(session);
  }
  async function join(id) {
    const adapter = rooms();
    if (!isPrivateRoomId(id)) throw new Error('Invalid private room identifier.');
    setup();
    cancelJoin();
    const attempt = pendingJoin = {id};
    let session;
    try {
      const discovery = discover(id);
      session = guests.get(id);
      await discovery;
      rooms();
      if (pendingJoin !== attempt) throw new Error(CLOSED);
      updateLobby(true);
      await adapter.join(id);
      if (pendingJoin !== attempt) throw new Error(CLOSED);
      return id;
    } catch (error) {
      if (session && guests.get(id) === session && !session.socket) closeGuest(session);
      throw error;
    } finally {
      if (pendingJoin === attempt) pendingJoin = null;
    }
  }
  async function refreshDirectory() {
    if (destroyed || !directoryVisible()) return;
    if (directoryRequest) {
      if (!directoryAbort?.signal.aborted) return directoryRequest;
      await directoryRequest;
      return refreshDirectory();
    }
    if (now() - lastDirectory < 10000) return;
    lastDirectory = now();
    directoryRequest = (async () => {
      const controller = directoryAbort = new AbortController();
      let timedOut = false, stop;
      const cancelled = new Promise((_, reject) => {
        stop = () => reject(new Error(SERVICE));
        controller.signal.addEventListener('abort', stop, {once: true});
      });
      const deadline = timers.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, DIRECTORY_TIMEOUT);
      try {
        const body = await Promise.race([cancelled, (async () => {
          const response = await fetchRooms(new URL('/rooms', SIGNAL_URL).href, {signal: controller.signal, cache: 'no-store'});
          if (controller.signal.aborted) return;
          if (!response.ok) throw new Error(SERVICE);
          return response.json();
        })()]);
        if (destroyed || controller.signal.aborted) return;
        const rows = body?.rooms;
        if (!Array.isArray(rows)) throw new Error(SERVICE);
        const next = new Map();
        // Rows this browser can't show are skipped, so one bad listing never hides the others.
        for (const value of rows.slice(0, DIRECTORY_SIZE)) {
          const row = normalize(value, true);
          if (row && !gone.has(row.id)) next.set(row.id, row);
        }
        directory.clear();
        for (const [id, row] of next) directory.set(id, row);
        directoryError = '';
        updateLobby();
      } catch {
        if (!destroyed && (timedOut || !controller.signal.aborted)) {
          directoryError = SERVICE;
          ui?.refresh();
        }
      } finally {
        timers.clearTimeout(deadline);
        controller.signal.removeEventListener('abort', stop);
        if (directoryAbort === controller) {
          if (controller.signal.aborted && !timedOut) lastDirectory = -Infinity;
          directoryRequest = null; directoryAbort = null;
        }
      }
    })();
    return directoryRequest;
  }
  function updateDirectoryActivity() {
    if (directoryVisible()) {
      directoryTimer ??= timers.setInterval(() => void refreshDirectory(), 10000);
      void refreshDirectory();
    } else {
      timers.clearInterval(directoryTimer);
      directoryTimer = null;
      directoryAbort?.abort();
    }
  }
  function pageVisibility() {
    if (destroyed) return;
    if (!document.hidden) {
      lastDirectory = -Infinity;
      updateLobby();
    }
    updateDirectoryActivity();
  }
  function browserVisibility(open) {
    if (destroyed || browserVisible === open) return;
    browserVisible = open;
    if (open) updateLobby();
    else {
      directoryError = '';
      ui?.refresh();
    }
    updateDirectoryActivity();
  }
  function menuVisibility(open) {
    if (destroyed || menuVisible === open) return;
    menuVisible = open;
    if (directoryVisible()) updateLobby();
    updateDirectoryActivity();
  }
  function joinInvite(id) {
    Promise.resolve().then(() => {
      if (!destroyed) return join(id);
    }).catch(error => {
      if (!destroyed) getAdapter()?.rooms?.notice?.(error.message);
    });
  }
  const api = {
    directoryError: () => directoryError,
    // The current room's paint while connected, for the world paint layer.
    get paint() { return roomPaint?.ready ? roomPaint : null; },
    // Whether this browser hosts the room it's in, so its Clear empties the whole room.
    get hostingCurrent() { return !!currentSocket && sockets.get(currentSocket) === hosted?.id; },
    // Called by the game as it handles each finish: the attempt id it sends for verification, or null.
    finishQueued(id) { queuedRun = typeof id === 'string' ? id : null; },
    async observeFinish(live, history) {
      // The game reports this finish's attempt only after this tick, so an earlier report is cleared first.
      queuedRun = undefined;
      const socket = currentSocket, id = sockets.get(socket), state = roomStates.get(socket);
      if (destroyed || !id || latestSockets.get(id) !== socket || socket.readyState !== 1 || !state) return false;
      const adapter = getAdapter(), timer = live?.timer?.state;
      if (adapter?.getSession?.() !== live || !live?.state || live.practice || !timer ||
          timer.phase !== 'finished' || timer.untimed || timer.invalidReason || !Number.isFinite(timer.elapsed) ||
          live.map?.id !== state.mapId) return false;
      const snapshot = getState();
      if (snapshot?.playback || snapshot?.spectator?.target != null || adapter.getView?.()?.target != null) return false;
      const timeUs = Math.round(timer.elapsed * 1e6);
      if (!Number.isSafeInteger(timeUs) || timeUs <= 0 || timeUs > 86400000000) return false;
      const best = await history.bestTime(live.map);
      if (destroyed || currentSocket !== socket || latestSockets.get(id) !== socket || socket.readyState !== 1 ||
          roomStates.get(socket)?.epoch !== state.epoch || roomStates.get(socket)?.mapId !== state.mapId ||
          adapter.getSession() !== live || live.map?.id !== state.mapId) return false;
      const bestUs = best === null ? null : Math.round(best * 1e6);
      if (bestUs !== null && (!Number.isSafeInteger(bestUs) || bestUs <= 0 || bestUs > 86400000000)) return false;
      const personalBest = bestUs === null || timeUs < bestUs;
      const claim = {type: 'finish', mapId: state.mapId, epoch: state.epoch, course: courseOf(live.map), timeUs,
        personalBest, previousBestUs: personalBest ? bestUs : null};
      const attempt = queuedRun, onVerdict = adapter.rooms?.onVerdict;
      queuedRun = undefined;
      if (typeof attempt === 'string' && typeof onVerdict === 'function') {
        if (pendingRuns.size >= PENDING_RUNS) pendingRuns.delete(pendingRuns.keys().next().value);
        pendingRuns.set(attempt, {socket, claim});
        stopVerdicts ??= onVerdict(verdict);
        return true;
      }
      socket.send(JSON.stringify(claim));
      return true;
    },
    async host({visibility: choice = visibility, mapId = getAdapter()?.rooms?.currentMap()?.id,
      name, maxPlayers: limit = maxPlayers} = {}) {
      const adapter = rooms();
      if (adapter.guest()) throw new Error(SIGN_IN);
      if (choice !== 'public' && choice !== 'private') throw new Error('Invalid room visibility.');
      if (!isMaxPlayers(limit)) throw new Error('Room capacity must be an integer from 2 to 64.');
      const maps = adapter.maps();
      if (!mapId || !maps.some(map => map.id === mapId)) throw new Error('Select a map before hosting a room.');
      name = normalizeRoomName(name === undefined ? api.roomName() : name);
      const problem = roomNameProblem(name);
      if (problem) throw new Error(problem);
      setup();
      closeHost();
      visibility = choice;
      store(VISIBILITY_KEY, visibility);
      maxPlayers = limit;
      store(MAX_PLAYERS_KEY, String(limit));
      const id = createRoomId();
      const current = {id, visibility, sockets: new Set(), uploadMbps: null, listing: undefined};
      current.room = createRoomHost({roomId: id, mapId, maps, visibility, maxPlayers: limit,
        name, ranks: ranks(), lookupProfile: siteProfile, lookupBoard: siteBoard,
        // Shared savelocs are for the room map's main course, even while the host plays a bonus.
        getMap: () => getAdapter()?.loadedMap?.() ?? getAdapter()?.practice?.destination?.()?.map ?? null,
        onChange: () => { if (hosted === current) publish(); }});
      hosted = current;
      // Hosting needs an account, so signing out ends the room for everyone.
      current.stopAccount = adapter.onAccountChange?.(() => {
        if (hosted === current && getAdapter()?.rooms?.guest()) closeHost();
      });
      try {
        const signal = current.signal = signalFactory({url: SIGNAL_URL, roomId: id, role: 'host', key: newHostKey()});
        const signalling = relay(signal, id, true);
        const infoReplies = new Map();
        signal.on('peer-left', peer => infoReplies.delete(peer));
        current.stop = listen({roomId: id, signalling, rtcConfig: () => current.relayConfig, onSocket: (socket, identity) => {
          if (hosted !== current) { socket.close(4004, HOST_LEFT); return; }
          current.sockets.add(socket);
          socket.addEventListener('close', () => current.sockets.delete(socket), {once: true});
          // A guest that connected while the host renewed its credentials catches up.
          if (socket.relayConfig !== current.relayConfig) socket.renewRelay?.(current.relayConfig);
          current.room.addClient(socket, identity);
        }});
        signal.on('message', message => {
          if (hosted === current && message.type === 'room-info' && message.data === null && typeof message.from === 'string') {
            const time = now();
            if (time - (infoReplies.get(message.from) ?? -Infinity) < 5000) return;
            infoReplies.set(message.from, time);
            // Rosters travel over the peer connection; the relay has a 16KB message limit.
            const {roster, ...row} = hostRow();
            signal.send(message.from, 'room-info', row);
          }
        });
        await new Promise((resolve, reject) => {
          const timer = timers.setTimeout(() => reject(new Error(SERVICE)), DISCOVERY_TIMEOUT);
          signal.on('ready', () => {
            if (hosted !== current) return;
            timers.clearTimeout(timer);
            if (current.relayConfig) publish(true);
            resolve();
          });
          signal.on('closed', () => {
            timers.clearTimeout(timer);
            reject(new Error(SERVICE));
            if (hosted === current) closeHost();
          });
          if (signal.state === 'open') { timers.clearTimeout(timer); resolve(); }
        });
        if (hosted !== current) throw new Error(CLOSED);
        const issued = await askRelay(signal);
        if (hosted !== current) throw new Error(CLOSED);
        current.relayConfig = issued.config;
        current.stopRelay = keepRelay(issued.ttl, () => askRelay(signal), config => {
          current.relayConfig = config;
          for (const socket of current.sockets) socket.renewRelay?.(config);
        });
        publish(true);
        await join(id);
        return id;
      } catch (error) {
        if (hosted === current) closeHost();
        throw error;
      }
    },
    join, guestName, mergeRooms, refreshDirectory, browserVisibility, menuVisibility, commandReply,
    joinCode(value) {
      const id = parseRoomCode(value);
      return id ? join(id) : Promise.reject(new Error(BAD_CODE));
    },
    roomInfo: id => known.get(id) ?? directory.get(id) ?? null,
    roomName: () => hosted?.room.state.name ?? chosenName ?? roomName(),
    async rename(value) {
      value = normalizeRoomName(value);
      const problem = roomNameProblem(value);
      if (problem) throw new Error(problem);
      chosenName = value;
      hosted?.room.setName(value);
    },
    maxPlayers: () => maxPlayers,
    async setMaxPlayers(value) {
      if (!isMaxPlayers(value)) throw new Error('Room capacity must be an integer from 2 to 64.');
      maxPlayers = value;
      store(MAX_PLAYERS_KEY, String(value));
      if (hosted) hosted.room.setMaxPlayers(value);
      else ui?.refresh();
    },
    hosting: () => hosted ? {id: hosted.id, visibility: hosted.visibility, name: hosted.room.state.name,
      mapId: hosted.room.state.mapId, maxPlayers: hosted.room.state.maxPlayers,
      players: hosted.room.players.length, uploadMbps: hosted.uploadMbps} : null,
    ownRoom: () => !!hosted && api.currentRoom() === hosted.id,
    openRoom: () => ui?.openRoom?.(),
    // Ends the room through the game's own Leave when the host is in it, so the game returns to solo.
    end() {
      const id = hosted?.id;
      if (!id) return;
      if (api.currentRoom() === id) getAdapter()?.rooms?.leaveRoom?.();
      if (hosted?.id === id) api.leave(id);
    },
    showHostDetails(visible) {
      visible = !!visible && !!hosted;
      if (showingDetails === visible) return;
      showingDetails = visible;
      uploadSamples = new WeakMap();
      if (hosted) hosted.uploadMbps = null;
      updateHostTimers();
    },
    visibility: () => visibility,
    setVisibility(value) {
      if (value !== 'public' && value !== 'private') throw new Error('Invalid room visibility.');
      const problem = value === 'public' ? roomNameProblem(api.roomName(), value) : null;
      if (problem) throw new Error(problem);
      visibility = value;
      store(VISIBILITY_KEY, value);
      if (hosted) { hosted.visibility = value; hosted.room.setVisibility(value); }
      else ui?.refresh();
    },
    ticket: id => isPrivateRoomId(id) ? 'private-room' : null,
    measure: id => isPrivateRoomId(id) ? Promise.resolve(known.get(id)?.ping ?? directory.get(id)?.ping ?? null) : null,
    currentRoom: () => {
      for (const [socket, id] of sockets) if (socket.readyState < 2) return id;
      return null;
    },
    roomSocket(id) {
      if (!isPrivateRoomId(id)) return null;
      if (destroyed || gone.has(id)) return createClosedSocket(4004, CLOSED);
      rooms();
      setup();
      if (id === hosted?.id) {
        const current = hosted;
        const [client, host] = createLoopbackPair({roomId: id, maps: rooms().maps(), ranks: ranks()});
        current.room.addClient(host, hello(), {host: true});
        return track(client, id);
      }
      // A host that keeps dropping its guests would otherwise have the game reconnect forever.
      if (recentDrops(id).length > MAX_DROPS) return createClosedSocket(4004, CLOSED);
      const previous = guests.get(id);
      if (previous?.socket) {
        closeGuest(previous);
        previous.socket.close(1000, '');
      }
      const session = guestSession(id);
      timers.clearTimeout(session.idleTimer);
      let stopRelay = null;
      const socket = session.socket = socketFactory({roomId: id,
        peerId: () => session.signal.id, signalling: session.signalling, hello: hello(), maps: rooms().maps(), ranks: ranks(),
        async rtcConfig() {
          const issued = await askRelay(session.signal);
          if (socket.readyState < 2) stopRelay = keepRelay(issued.ttl, () => guestRelay(id), config => socket.renewRelay?.(config));
          return issued.config;
        },
        async onFailure() {
          if (destroyed || latestSockets.get(id) !== socket) return null;
          // A closing tab can destroy SCTP before its final control frame arrives.
          try {
            await discover(id);
            if (destroyed || latestSockets.get(id) !== socket) return null;
            const retry = guests.get(id);
            if (retry && !retry.socket) retry.idleTimer = timers.setTimeout(() => closeGuest(retry), 30000);
          } catch {
            if (gone.has(id)) return {code: 4004, reason: HOST_LEFT};
          }
          return null;
        }});
      socket.addEventListener('open', () => closeGuest(session), {once: true});
      socket.addEventListener('close', () => { closeGuest(session); stopRelay?.(); }, {once: true});
      return track(socket, id);
    },
    leave(id) {
      cancelJoin(id);
      if (id == null || sockets.get(currentSocket) === id) {
        sharedSaves?.close();
        sharedSaves = null;
      }
      if (hosted && (id == null || id === hosted.id)) closeHost();
      for (const [roomId, session] of guests) if (id == null || id === roomId) closeGuest(session);
      // A departed connection's snapshot is no longer authoritative, even if
      // the directory still has a cached copy from before the departure.
      for (const roomId of known.keys()) if (id == null || id === roomId) {
        known.delete(roomId);
        directory.delete(roomId);
      }
      // The directory can contain a public row even when no peer snapshot was received.
      if (id != null) directory.delete(id);
      for (const [socket, roomId] of sockets) if (id == null || id === roomId) {
        sockets.delete(socket);
        if (latestSockets.get(roomId) === socket) latestSockets.delete(roomId);
        socket.close(1000, '');
      }
      lastDirectory = -Infinity;
      directoryAbort?.abort();
      updateLobby();
      ui?.refresh();
    },
    attach() {
      if (!getAdapter()?.rooms || destroyed || attached) return;
      attached = true;
      setup();
      const invite = new URLSearchParams(globalThis.location?.search ?? '').get('join');
      const roomId = parseRoomCode(invite);
      ui = uiFactory({rooms: api, getAdapter});
      browserVisibility(!!getAdapter()?.rooms?.browserOpen?.());
      if (getAdapter()?.rooms?.menuOpen?.()) menuVisibility(true);
      if (roomId) joinInvite(roomId);
    },
    destroy() {
      if (destroyed) return;
      cancelJoin();
      closeHost();
      sharedSaves?.close();
      sharedSaves = null;
      roomPaint?.close();
      roomPaint = null;
      forgetRuns();
      destroyed = true;
      directoryAbort?.abort();
      timers.clearInterval(directoryTimer);
      directoryTimer = null;
      timers.clearInterval(heartbeat);
      events.removeEventListener?.('pagehide', pagehide);
      document?.removeEventListener?.('visibilitychange', pageVisibility);
      ui?.destroy();
      for (const session of guests.values()) closeGuest(session);
      for (const socket of sockets.keys()) socket.close(4004, HOST_LEFT);
      sockets.clear();
      latestSockets.clear();
      known.clear();
      directory.clear();
      drops.clear();
    }
  };
  return api;
}
