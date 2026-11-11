import {isPrivateRoomId} from './ids.js';
import {maskChat} from './chat-filter.js';
import {MAX_ROOM_SAVELOCS, SAVELOC_RING, sanitizeSaveloc} from './saveloc-validation.js';
import {acceptedPaint, appendPaint, erasePaint} from './room-paint.js';
import {CLOSE, RANKS, ROOM_TEXTS, VERSION, DEFAULT_MAX_PLAYERS, SNAPSHOT_HEADER_BYTES, SNAPSHOT_INTERVAL_MS,
  bannedNotice, catalogEntry, decodeControl, encodeControlFrames, isGuestName, isMaxPlayers, isPlayerName, isPoints, isUuid, kickedNotice,
  isStanding, normalizeAppearance, normalizeRoomName, rankFor, rankTable, relayPose, relaySpectator, roomNameProblem, runTime} from './protocol.js';

const ROSTER_INTERVAL_MS = 100;
const CHAT_LIMIT = {rate: 1, burst: 3}, SPECTATE_LIMIT = {rate: 2, burst: 4};
const SAVELOC_LIMIT = {rate: 1, burst: 3}, COURSE_LIMIT = {rate: 2, burst: 4};
// Guests send paint in batches of up to 32 dots every 250 ms, and erase at most every 125 ms.
const PAINT_LIMIT = {rate: 5, burst: 10}, ERASE_LIMIT = {rate: 10, burst: 20};
// Native allows frames 1ms early at 30Hz. Keep that cadence plus ~259ms of jitter.
const SPECTATOR_LIMIT = {rate: 1000 / (1000 / 30 - 1), burst: 8};
const BAN_MS = 60 * 60 * 1000;
const RESULT_INTERVAL_MS = 3000, VERIFIED_LIMIT = {rate: 1 / 3, burst: 3};
// Board reads for the whole room, so many players can't make the host flood the site.
const BOARD_LIMIT = {rate: 1 / 2, burst: 5};
// Earlier epochs a late claim may name, and verified runs remembered so none is announced twice.
const EPOCH_HISTORY = 9, ANNOUNCED_RUNS = 256;
const LOSSY_BACKLOG = 64 * 1024, RELIABLE_BACKLOG = 8 * 1024 * 1024, BACKLOG_GRACE_MS = 5000;

const guestName = () => 'Guest_' + crypto.randomUUID().slice(0, 5);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// lookupProfile(userId) resolves to the site's public profile ({username, rank, points}), null when the
// site has no such player, or rejects when it can't answer. lookupBoard(mapId, course) resolves to the
// leaderboard of the map's main course (0) or bonus ({entries: [{rank, userId, timeUs}], total}) or null.
export function createRoomHost({roomId, mapId, maps = [{id: mapId, title: mapId}], name = "Host's room", visibility = 'private', maxPlayers = DEFAULT_MAX_PLAYERS, onChange = () => {}, now = Date.now, getMap = () => null,
  ranks = RANKS, lookupProfile = null, lookupBoard = null}) {
  if (!isPrivateRoomId(roomId)) throw new Error('Invalid private room ID');
  ranks = rankTable(ranks);
  const titles = new Set(ranks.map(rank => rank.title));
  if (!isMaxPlayers(maxPlayers)) throw new Error('Choose a player limit from 2 to 64.');
  name = normalizeRoomName(name);
  const problem = roomNameProblem(name);
  if (problem) throw new Error(problem);
  if (!Array.isArray(maps)) throw new Error('Invalid map catalog');
  const catalog = new Map();
  for (const map of maps) {
    if (!map || typeof map.id !== 'string' || !map.id) throw new Error('Invalid map catalog');
    catalog.set(map.id, catalogEntry(map));
  }
  if (!catalog.has(mapId)) throw new Error('Map is not in the catalog');
  let state = {
    roomId, name, visibility, maxPlayers, mapId, mapTitle: catalog.get(mapId).title,
    epoch: 1, startedAt: Date.now(), endsAt: 0, untimed: true,
    recent: [], nominations: {}, rtv: [], vote: null, nextMap: null,
  };
  const clients = new Set();
  const slots = new Set(), pending = new Map(), bans = new Map();
  const records = new Map(), epochs = new Map([[1, mapId]]), announced = new Set();
  const boardReads = {tokens: BOARD_LIMIT.burst, at: now()};
  const owners = new Map(), savelocs = new Map();
  let nextSavelocId = 1;
  let nextSlot = 0, hostClient = null, flushTimer = null, rosterTimer = null;
  let flushAt = 0;
  let closed = false;

  const players = () => [...clients].filter(client => client.open).map(client => client.player);
  function sendFrames(client, frames) {
    if (!client.open || client.socket.readyState !== 1) return;
    const lossy = frames[0] instanceof ArrayBuffer;
    // The next snapshot or spectator frame supersedes this one, so a congested player just skips it.
    if (lossy && client.socket.bufferedAmount > LOSSY_BACKLOG) return;
    try {
      for (const frame of frames) client.socket.send(frame);
    } catch {
      client.socket.close(CLOSE.gone, ROOM_TEXTS.connectionLost);
      leave(client);
      return;
    }
    if (!lossy) checkBacklog(client);
  }
  function checkBacklog(client) {
    if (!(client.socket.bufferedAmount > RELIABLE_BACKLOG)) {
      client.backlogSince = null;
      return;
    }
    client.backlogSince ??= now();
    if (now() - client.backlogSince < BACKLOG_GRACE_MS) return;
    client.socket.close(CLOSE.congested, ROOM_TEXTS.congested);
    leave(client);
  }
  function send(client, message) {
    sendFrames(client, message instanceof ArrayBuffer ? [message] : encodeControlFrames(message));
  }
  function broadcast(message, except) {
    const frames = message instanceof ArrayBuffer ? [message] : encodeControlFrames(message);
    for (const client of clients) if (client !== except) sendFrames(client, frames);
  }
  // Roster-visible changes share one broadcast per interval to keep output bounded.
  function roster() {
    rosterTimer ??= setTimeout(() => {
      rosterTimer = null;
      if (!closed) broadcast({type: 'roster', players: players()});
    }, ROSTER_INTERVAL_MS);
    onChange();
  }
  function take(bucket, {rate, burst}) {
    const time = now();
    bucket.tokens = Math.min(burst, bucket.tokens + Math.max(0, time - bucket.at) * rate / 1000);
    bucket.at = time;
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }
  // count is how many retained saves follow directly, so a joiner can apply them as one batch.
  function initSavelocs(client) {
    send(client, {type: 'saveloc-init', mapId: state.mapId, epoch: state.epoch, ownerId: client.owner.id, count: savelocs.size});
  }
  function removeSaveloc(id) {
    const owner = savelocs.get(id).owner;
    owner.entries.splice(owner.entries.indexOf(id), 1);
    savelocs.delete(id);
    broadcast({type: 'saveloc-remove', mapId: state.mapId, epoch: state.epoch, id});
  }
  function saveSaveloc(client, message) {
    if (message.mapId !== state.mapId || message.epoch !== state.epoch || !take(client.owner.bucket, SAVELOC_LIMIT)) return;
    const map = getMap();
    // Savelocs are checked against the native map, which a bare catalog entry can't stand in for.
    if (!map || map.id !== state.mapId || !Number.isSafeInteger(nextSavelocId)) return;
    let snapshot;
    // Malformed snapshots already closed the connection in the decoder. One that only
    // disagrees with the host's map, as from another map version, is dropped.
    try { snapshot = sanitizeSaveloc(message.snapshot, map); } catch { return; }
    const owner = client.owner;
    if (owner.entries.length === SAVELOC_RING) removeSaveloc(owner.entries[0]);
    else if (savelocs.size >= MAX_ROOM_SAVELOCS) {
      const present = new Set([...clients].map(peer => peer.owner));
      // At most 64 owners are present and the saver holds fewer than 20, so a departed owner's save exists.
      for (const [id, save] of savelocs) if (!present.has(save.owner)) { removeSaveloc(id); break; }
    }
    const entry = {id: nextSavelocId++, ownerId: owner.id, name: client.player.name, snapshot};
    owner.entries.push(entry.id);
    savelocs.set(entry.id, {entry, owner});
    broadcast({type: 'saveloc-add', mapId: state.mapId, epoch: state.epoch, entry});
  }
  // Paint stays with the browser that drew it, like savelocs, until the map changes.
  const paintCount = () => { let count = 0; for (const owner of owners.values()) count += owner.paint.length; return count; };
  function initPaint(client) {
    send(client, {type: 'paint-init', mapId: state.mapId, epoch: state.epoch, ownerId: client.owner.id});
    for (const owner of owners.values()) {
      if (owner.paint.length) send(client, {type: 'paint-add', mapId: state.mapId, epoch: state.epoch, ownerId: owner.id, dots: owner.paint});
    }
  }
  function addPaint(client, message) {
    const owner = client.owner;
    if (message.mapId !== state.mapId || message.epoch !== state.epoch || !take(owner.paintBucket, PAINT_LIMIT)) return;
    const dots = message.dots.slice(0, acceptedPaint(owner.paint.length, paintCount(), message.dots.length));
    if (!dots.length) return;
    owner.paint = appendPaint(owner.paint, dots);
    broadcast({type: 'paint-add', mapId: state.mapId, epoch: state.epoch, ownerId: owner.id, dots});
  }
  function erasePaintAt(client, message) {
    const owner = client.owner;
    if (message.mapId !== state.mapId || message.epoch !== state.epoch || !take(owner.eraseBucket, ERASE_LIMIT)) return;
    const kept = erasePaint(owner.paint, message.point, message.radius);
    if (kept.length === owner.paint.length) return;
    owner.paint = kept;
    broadcast({type: 'paint-erase', mapId: state.mapId, epoch: state.epoch, ownerId: owner.id, point: message.point, radius: message.radius});
  }
  function clearPaint(owner) {
    if (owner) {
      if (!owner.paint.length) return;
      owner.paint = [];
    } else for (const each of owners.values()) each.paint = [];
    broadcast({type: 'paint-clear', mapId: state.mapId, epoch: state.epoch, ownerId: owner?.id ?? null});
  }
  function clearPending() {
    clearTimeout(flushTimer);
    flushTimer = null;
    pending.clear();
  }
  function flushPoses() {
    clearTimeout(flushTimer);
    flushTimer = null;
    const batches = [...pending];
    pending.clear();
    for (const recipient of clients) {
      if (!recipient.open || recipient.socket.readyState !== 1 || recipient.socket.bufferedAmount > LOSSY_BACKLOG) continue;
      const blocks = [];
      let length = SNAPSHOT_HEADER_BYTES;
      for (const [sender, packet] of batches) {
        if (sender === recipient || !sender.open || packet.epoch !== state.epoch) continue;
        blocks.push(packet.buffer);
        length += packet.buffer.byteLength - SNAPSHOT_HEADER_BYTES;
      }
      if (!blocks.length) continue;
      const buffer = new ArrayBuffer(length), view = new DataView(buffer);
      view.setUint8(0, VERSION);
      view.setUint8(1, 2);
      view.setUint16(2, blocks.length, true);
      let offset = SNAPSHOT_HEADER_BYTES;
      for (const block of blocks) {
        const bytes = new Uint8Array(block, SNAPSHOT_HEADER_BYTES);
        new Uint8Array(buffer, offset, bytes.length).set(bytes);
        offset += bytes.length;
      }
      send(recipient, buffer);
    }
  }
  function demand(client) {
    send(client, {type: 'spectator-demand', active: client.watchers.size > 0, count: client.watchers.size});
  }
  function unwatch(client) {
    if (!client.target) return;
    const target = client.target;
    client.target = null;
    client.player.spectating = false;
    target.watchers.delete(client);
    demand(target);
  }
  function releaseWatchers(client) {
    for (const watcher of [...client.watchers]) {
      unwatch(watcher);
      send(watcher, {type: 'error', text: ROOM_TEXTS.noLongerAvailable, spectatorRequest: watcher.request});
    }
  }
  function detach(client) {
    client.socket.removeEventListener('open', client.onOpen);
    client.socket.removeEventListener('message', client.onMessage);
    client.socket.removeEventListener('close', client.onClose);
  }
  function leave(client) {
    if (!clients.delete(client)) return;
    detach(client);
    client.open = false;
    slots.delete(client.player.slot);
    nextSlot = Math.min(nextSlot, client.player.slot);
    if (hostClient === client) hostClient = null;
    pending.delete(client);
    if (!pending.size) clearPending();
    unwatch(client);
    releaseWatchers(client);
    if (!closed) roster();
  }
  function close() {
    if (closed) return;
    closed = true;
    clearPending();
    clearTimeout(rosterTimer);
    rosterTimer = null;
    for (const client of clients) {
      detach(client);
      client.open = false;
      client.socket.close(CLOSE.gone, ROOM_TEXTS.hostClosed);
    }
    clients.clear();
    slots.clear();
    owners.clear();
    savelocs.clear();
    hostClient = null;
    onChange();
  }
  function spectate(client, message) {
    if (message.connectionId === (client.target?.player.connectionId ?? null)) {
      client.request = message.request;
      return;
    }
    // Stopping and redundant requests do not subscribe to a stream or consume its flood budget.
    if (message.connectionId !== null && !take(client.spectate, SPECTATE_LIMIT)) return;
    const target = message.connectionId === null ? null
      : [...clients].find(peer => peer.open && peer.player.connectionId === message.connectionId);
    if (message.connectionId !== null && (!target || target === client || target.player.spectating)) {
      send(client, {type: 'error', text: ROOM_TEXTS.unavailable, spectatorRequest: message.request});
      return;
    }
    const rosterChanged = client.player.spectating !== Boolean(target) || client.watchers.size > 0;
    client.request = message.request;
    unwatch(client);
    if (target) {
      releaseWatchers(client);
      client.target = target;
      client.player.spectating = true;
      target.watchers.add(client);
      demand(target);
    }
    if (rosterChanged) roster();
  }
  // verified is null for a run the site didn't verify, else the leaderboard place to show. An unverified
  // record is the room's; the finisher's own game already shows the site's result for a verified run.
  function announce(client, claim, verified = null) {
    const player = client.player;
    const course = claim.mapId + ':' + claim.course, previous = records.get(course) ?? null;
    const roomRecord = previous === null || claim.timeUs < previous;
    if (roomRecord) records.set(course, claim.timeUs);
    const siteRecord = !!verified && claim.record;
    let promoted = false;
    if (verified) {
      const rank = ranks.findIndex(entry => entry.title === claim.rank);
      promoted = claim.promoted && rank > ranks.findIndex(entry => entry.title === player.rank);
      const points = Math.min(1e9, player.points + claim.pointsDelta);
      if (promoted || points !== player.points) {
        if (promoted) player.rank = claim.rank;
        player.points = points;
        roster();
      }
    }
    broadcast({type: 'result', result: {
      id: claim.id ?? crypto.randomUUID(), userId: player.userId ?? player.id, name: player.name, rank: player.rank,
      mapId: claim.mapId, mapTitle: catalog.get(claim.mapId).title, ...(claim.course ? {bonus: claim.course} : {}), timeUs: claim.timeUs,
      record: siteRecord || roomRecord, ...(roomRecord && !siteRecord ? {roomRecord: true} : {}),
      personalBest: claim.personalBest,
      previousBestUs: roomRecord && !siteRecord ? previous : claim.personalBest || siteRecord ? claim.previousBestUs : null,
      pointsDelta: verified ? claim.pointsDelta : 0, promoted,
      ...(verified?.leaderboardRank ? {leaderboardRank: verified.leaderboardRank, leaderboardTotal: verified.leaderboardTotal} : {}),
      verified: !!verified,
    }}, claim.type === 'verified' ? client : undefined);
  }
  // A run the site verified, as the finisher's game reports it. A personal best must show on the board
  // with its time and place, or it is announced as unverified. A slower run is announced either way and
  // keeps a leaderboard place only if the board agrees.
  function verify(client, claim) {
    const player = client.player;
    if (player.guest || !player.userId || epochs.get(claim.epoch) !== claim.mapId || announced.has(claim.id)
      || !take(client.verified, VERIFIED_LIMIT)) return;
    if (claim.id) {
      announced.add(claim.id);
      if (announced.size > ANNOUNCED_RUNS) announced.delete(announced.values().next().value);
    }
    const best = claim.personalBest || claim.record;
    // Points come from a map's best time, so a slower run earns none.
    if (!best) claim = {...claim, pointsDelta: 0, promoted: false};
    if (!best && claim.leaderboardRank === undefined) {
      announce(client, claim, {});
      return;
    }
    const read = take(boardReads, BOARD_LIMIT) ? () => lookupBoard?.(claim.mapId, claim.course) : () => null;
    Promise.resolve().then(read).catch(() => null).then(board => {
      if (closed || !clients.has(client)) return;
      const place = standing(board, claim, player.userId);
      if (best && !place) announce(client, claim);
      else announce(client, claim, place && claim.leaderboardRank !== undefined
        ? {leaderboardRank: place.rank, leaderboardTotal: place.total} : {});
    });
  }
  function standing(board, claim, userId) {
    if (!record(board) || !Array.isArray(board.entries) || board.entries.length > 1000 || !Number.isSafeInteger(board.total)
      || board.total < board.entries.length || !board.entries.every(entry => record(entry) && Number.isSafeInteger(entry.rank)
        && entry.rank > 0 && typeof entry.userId === 'string' && runTime(entry.timeUs))) return null;
    const best = claim.personalBest || claim.record;
    const own = board.entries.find(entry => entry.userId === userId);
    if (own) {
      if (best ? own.timeUs !== claim.timeUs : own.timeUs > claim.timeUs) return null;
      if (claim.record && own.rank !== 1) return null;
      return isStanding(own.rank, board.total) ? {rank: own.rank, total: board.total} : null;
    }
    // The board lists only its top places; an unlisted place must fall below them.
    const last = board.entries.at(-1);
    if (claim.record || board.entries.length >= board.total || (best && last && claim.timeUs < last.timeUs)) return null;
    if (claim.leaderboardRank === undefined) return {};
    return claim.leaderboardRank > (last?.rank ?? 0) && isStanding(claim.leaderboardRank, board.total)
      ? {rank: claim.leaderboardRank, total: board.total} : null;
  }
  function moderate(client, {playerId, action}) {
    const target = [...clients].find(peer => peer.player.id === playerId);
    if (!client.host || !target || target.host) return;
    // A ban covers this browser only: clearing its site data gives it a new id.
    if (action === 'ban') bans.set(target.browserId, now() + BAN_MS);
    target.socket.close(CLOSE.refused, action === 'ban' ? ROOM_TEXTS.banned : ROOM_TEXTS.kicked);
    leave(target);
    clearPaint(target.owner);
    broadcast({type: 'notice', text: action === 'ban' ? bannedNotice(target.player.name) : kickedNotice(target.player.name)});
  }
  function banned(browserId) {
    for (const [id, until] of bans) if (until <= now()) bans.delete(id);
    return bans.has(browserId);
  }
  function receive(client, data) {
    if (!client.open || closed) return;
    try {
      if (data instanceof ArrayBuffer) {
        const type = data.byteLength >= 2 ? new Uint8Array(data)[1] : 0;
        if (type === 1) {
          const packet = relayPose(data, client.player.slot);
          if (packet.epoch !== state.epoch) return;
          if (client.sequence !== null) {
            const distance = (packet.sequence - client.sequence) >>> 0;
            if (distance === 0 || distance >= 0x80000000) return;
          }
          client.sequence = packet.sequence;
          pending.set(client, packet);
          // Hidden tabs delay timers to a second; uploads still arrive on the data channel.
          if (flushTimer !== null && now() >= flushAt) flushPoses();
          if (flushTimer === null && pending.size) {
            flushAt = now() + SNAPSHOT_INTERVAL_MS;
            flushTimer = setTimeout(flushPoses, SNAPSHOT_INTERVAL_MS);
          }
        } else if (type === 3) {
          const packet = relaySpectator(data, client.player.slot);
          if (packet.epoch !== state.epoch) return;
          if (client.spectatorSequence !== null) {
            const distance = (packet.sequence - client.spectatorSequence) >>> 0;
            if (distance === 0 || distance >= 0x80000000) return;
          }
          client.spectatorSequence = packet.sequence;
          if (!client.watchers.size || client.player.spectating || !take(client.spectator, SPECTATOR_LIMIT)) return;
          for (const watcher of client.watchers) send(watcher, packet.buffer);
        } else throw new Error('Invalid packet type');
        return;
      }
      const message = decodeControl(data);
      switch (message.type) {
        case 'saveloc-save':
          saveSaveloc(client, message);
          break;
        case 'saveloc-delete':
          if (message.mapId === state.mapId && message.epoch === state.epoch
            && savelocs.get(message.id)?.owner === client.owner) removeSaveloc(message.id);
          break;
        case 'paint-add':
          addPaint(client, message);
          break;
        case 'paint-erase':
          erasePaintAt(client, message);
          break;
        case 'paint-clear':
          if (message.mapId === state.mapId && message.epoch === state.epoch) clearPaint(client.host ? null : client.owner);
          break;
        case 'ping':
          send(client, 'pong');
          break;
        case 'chat':
          if (client.player.guest) {
            send(client, {type: 'error', text: ROOM_TEXTS.signInToChat});
            break;
          }
          if (!take(client.chat, CHAT_LIMIT)) {
            if (!client.chat.limited) send(client, {type: 'error', text: ROOM_TEXTS.tooFast});
            client.chat.limited = true;
            break;
          }
          client.chat.limited = false;
          broadcast({type: 'chat', playerId: client.player.id, name: client.player.name,
            rank: client.player.rank, appearance: client.player.appearance, text: maskChat(message.text)});
          break;
        case 'finish':
          if (epochs.get(message.epoch) !== message.mapId || now() < client.nextResultAt) break;
          client.nextResultAt = now() + RESULT_INTERVAL_MS;
          announce(client, message);
          break;
        case 'verified':
          verify(client, message);
          break;
        case 'course':
          if (message.course !== client.player.course && take(client.course, COURSE_LIMIT)) {
            client.player.course = message.course;
            roster();
          }
          break;
        case 'change-map':
          if (!client.host) {
            send(client, {type: 'error', text: ROOM_TEXTS.hostChangesMaps});
          } else if (!catalog.has(message.mapId)) {
            send(client, {type: 'error', text: ROOM_TEXTS.unknownMap});
          } else if (message.mapId !== state.mapId) {
            state = {...state, mapId: message.mapId, mapTitle: catalog.get(message.mapId).title,
              epoch: state.epoch + 1, startedAt: Date.now(), recent: [state.mapId, ...state.recent].slice(0, 8)};
            epochs.set(state.epoch, state.mapId);
            epochs.delete(state.epoch - EPOCH_HISTORY);
            clearPending();
            savelocs.clear();
            for (const owner of owners.values()) { owner.entries.length = 0; owner.paint = []; }
            // A new map starts everyone on its main course.
            let courses = false;
            for (const peer of clients) {
              peer.sequence = null;
              peer.spectatorSequence = null;
              courses ||= peer.player.course !== 0;
              peer.player.course = 0;
            }
            broadcast({type: 'state', state, serverTime: Date.now()});
            if (courses) roster();
            for (const peer of clients) { initSavelocs(peer); initPaint(peer); }
            // The native client clears its viewer count on each epoch, not its demand flag.
            for (const peer of clients) demand(peer);
            onChange();
          }
          break;
        case 'spectate':
          spectate(client, message);
          break;
        case 'context':
          // The game waits for this when a map starts. Without a token it submits runs like solo runs, which the site still verifies.
          send(client, {type: 'context', epoch: state.epoch, token: null});
          break;
        case 'moderate':
          moderate(client, message);
          break;
        // Votes, refreshes, activity and reports belong to official servers.
      }
    } catch {
      client.socket.close(CLOSE.invalid, ROOM_TEXTS.invalidData);
      leave(client);
    }
  }
  function addClient(socket, hello, {host = false} = {}) {
    socket.binaryType = 'arraybuffer';
    if (closed) {
      socket.close(CLOSE.gone, ROOM_TEXTS.closed);
      return;
    }
    if (!hello || typeof hello !== 'object' || typeof hello.guest !== 'boolean' || !isUuid(hello.browserId)) {
      socket.close(CLOSE.invalid, ROOM_TEXTS.invalidHello);
      return;
    }
    if (!host && banned(hello.browserId)) {
      socket.close(CLOSE.refused, ROOM_TEXTS.stillBanned);
      return;
    }
    // One place stays free for the host's own connection.
    if (!host && [...clients].filter(client => !client.host).length >= state.maxPlayers - 1) {
      socket.close(CLOSE.refused, ROOM_TEXTS.full);
      return;
    }
    if (hostClient && host) {
      const stale = hostClient;
      leave(stale);
      stale.socket.close(1000, 'Host connection replaced');
    }
    while (slots.has(nextSlot)) nextSlot++;
    const slot = nextSlot++;
    slots.add(slot);
    const connectionId = crypto.randomUUID();
    // Signed-in players are taken at their word; a hello that can't be one becomes a guest.
    const guest = hello.guest || !isPlayerName(hello.name);
    const userId = !guest && isUuid(hello.userId) ? hello.userId : undefined;
    const claimed = !guest && titles.has(hello.rank) && isPoints(hello.points);
    let owner = owners.get(hello.browserId);
    if (!owner) {
      owner = {id: crypto.randomUUID(), entries: [], bucket: {tokens: SAVELOC_LIMIT.burst, at: now()},
        paint: [], paintBucket: {tokens: PAINT_LIMIT.burst, at: now()}, eraseBucket: {tokens: ERASE_LIMIT.burst, at: now()}};
      owners.set(hello.browserId, owner);
    }
    const client = {socket, host, owner, browserId: hello.browserId, open: false, sequence: null, target: null, request: 0, watchers: new Set(),
      spectatorSequence: null, spectator: {tokens: SPECTATOR_LIMIT.burst, at: now()},
      chat: {tokens: CHAT_LIMIT.burst, at: now(), limited: false}, spectate: {tokens: SPECTATE_LIMIT.burst, at: now()},
      course: {tokens: COURSE_LIMIT.burst, at: now()},
      nextResultAt: -Infinity, verified: {tokens: VERIFIED_LIMIT.burst, at: now()},
      backlogSince: null, player: {
      id: 'private-' + connectionId, connectionId, slot,
      name: guest ? (isGuestName(hello.name) ? hello.name : guestName()) : hello.name,
      appearance: normalizeAppearance(hello.appearance), guest, ...(userId ? {userId} : {}),
      rank: guest ? 'Guest' : claimed ? hello.rank : ranks[0].title, points: claimed ? hello.points : 0,
      moderator: host, spectating: false, course: 0,
    }};
    client.onOpen = () => {
      if (client.open || closed || !clients.has(client)) return;
      client.open = true;
      send(client, {type: 'welcome', state, player: client.player, players: players(), maps: [...catalog.values()],
        serverTime: Date.now(), spectatorStream: true, playtime: false, courses: true, activityTracking: false,
        recentResults: [], chatMute: null});
      initSavelocs(client);
      for (const {entry} of savelocs.values()) send(client, {type: 'saveloc-add', mapId: state.mapId, epoch: state.epoch, entry});
      initPaint(client);
      roster();
    };
    client.onMessage = event => receive(client, event.data);
    client.onClose = () => leave(client);
    clients.add(client);
    if (host) hostClient = client;
    socket.addEventListener('open', client.onOpen);
    socket.addEventListener('message', client.onMessage);
    socket.addEventListener('close', client.onClose);
    if (userId && lookupProfile) confirmProfile(client);
    if (socket.readyState === 1) client.onOpen();
  }
  // Rank and points follow the site's profile for the claimed account. A profile under another
  // name, or none, means the claim isn't that player's; a check that fails keeps the claim.
  function confirmProfile(client) {
    const player = client.player;
    Promise.resolve().then(() => lookupProfile(player.userId)).then(profile => {
      if (closed || !clients.has(client)) return;
      let rank = ranks[0].title, points = 0;
      if (record(profile) && profile.username === player.name) {
        points = isPoints(profile.points) ? profile.points : 0;
        rank = titles.has(profile.rank) ? profile.rank : rankFor(points, ranks);
      }
      if (rank === player.rank && points === player.points) return;
      player.rank = rank;
      player.points = points;
      if (client.open) roster();
    }, () => {});
  }
  function setVisibility(value) {
    if (value !== 'private' && value !== 'public') throw new Error('Invalid room visibility.');
    const problem = roomNameProblem(state.name);
    if (problem) throw new Error(problem);
    if (closed || state.visibility === value) return;
    state = {...state, visibility: value};
    broadcast({type: 'state', state, serverTime: Date.now()});
    onChange();
  }
  function setName(name) {
    name = normalizeRoomName(name);
    const problem = roomNameProblem(name);
    if (problem) throw new Error(problem);
    if (closed || state.name === name) return;
    state = {...state, name};
    broadcast({type: 'state', state, serverTime: Date.now()});
    onChange();
  }
  function setMaxPlayers(value) {
    if (!isMaxPlayers(value)) throw new Error('Choose a player limit from 2 to 64.');
    if (closed || state.maxPlayers === value) return;
    state = {...state, maxPlayers: value};
    broadcast({type: 'state', state, serverTime: Date.now()});
    onChange();
  }
  return {addClient, close, setVisibility, setName, setMaxPlayers, get state() { return state; }, get players() { return players(); }};
}
