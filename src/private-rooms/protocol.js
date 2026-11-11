import {MAX_ROOM_SAVELOCS, sanitizeSaveloc} from './saveloc-validation.js';
import {MAX_OWNER_PAINT, MAX_PAINT_BATCH, isEraseRadius, isPaintDot, isPaintPoint} from './room-paint.js';

export const VERSION = 1;
export const CLOSE = Object.freeze({invalid: 4002, gone: 4004, refused: 4008, congested: 4013});
// Everything a host may show its players. Guests replace or drop any other notice or close text.
export const ROOM_TEXTS = Object.freeze({
  closed: 'This private room has closed.',
  hostClosed: 'The host closed the private room.',
  connectionLost: 'Private room connection lost',
  cancelled: 'Room connection cancelled',
  invalidData: 'Invalid private room data',
  invalidHello: 'Invalid private room hello',
  full: 'This room is full.',
  congested: "Your connection couldn't keep up with the room.",
  unavailable: 'That player is not available to spectate.',
  noLongerAvailable: 'That player is no longer available to spectate.',
  hostChangesMaps: 'Only the private room host can change maps.',
  unknownMap: 'Map is not in the catalog.',
  tooFast: "You're sending messages too fast.",
  signInToChat: 'Sign in to send chat messages. You can still read chat.',
  kicked: 'You were kicked from this room.',
  banned: 'You were banned from this room for 1 hour.',
  stillBanned: "You're banned from this room for now.",
});
const roomTexts = new Set(Object.values(ROOM_TEXTS));
export const kickedNotice = name => `${name} was kicked.`;
export const bannedNotice = name => `${name} was banned for 1 hour.`;
const isRoomText = text => roomTexts.has(text) || /^[A-Za-z0-9_-]{3,24} was (kicked|banned for 1 hour)\.$/.test(text);
export function roomCloseReason(code, reason) {
  if (isRoomText(reason)) return reason;
  return code === CLOSE.gone ? ROOM_TEXTS.closed : code === CLOSE.invalid ? ROOM_TEXTS.invalidData : '';
}
export const MAX_CONTROL_BYTES = 65536;
export const MAX_ROOM_PLAYERS = 64;
export const DEFAULT_MAX_PLAYERS = 16;
export const isMaxPlayers = value => Number.isInteger(value) && value >= 2 && value <= MAX_ROOM_PLAYERS;
// A player's JSON stays under 512 characters; the rest leaves room for the map catalog.
export const MAX_ROOM_MESSAGE_CHARS = MAX_ROOM_PLAYERS * 4096;
export const ROOM_CHUNK_CHARS = 4000;
export const MAX_ROOM_CHUNKS = Math.ceil(MAX_ROOM_MESSAGE_CHARS / ROOM_CHUNK_CHARS);
export const MAX_SNAPSHOT_BLOCKS = Math.min(100, MAX_ROOM_PLAYERS);
export const POSE_HEADER_BYTES = 12;
export const POSE_SAMPLE_BYTES = 32;
export const SNAPSHOT_HEADER_BYTES = 4;
export const SNAPSHOT_BLOCK_BYTES = 14;
export const SPECTATOR_BYTES = 56;
const MAX_SNAPSHOT_BYTES = SNAPSHOT_HEADER_BYTES + MAX_SNAPSHOT_BLOCKS * (SNAPSHOT_BLOCK_BYTES + 2 * POSE_SAMPLE_BYTES);
export const SNAPSHOT_INTERVAL_MS = 50;
const encoder = new TextEncoder();
export const FLAGS = Object.freeze({grounded: 1, crouched: 2, teleport: 4, practice: 8, idle: 16, finished: 32});
export const DEFAULT_APPEARANCE = Object.freeze({title: '', titleColor: null, nameColor: null, revision: 0});
const PHASES = ['ready', 'running', 'finished'];
const uint = (value, max = 0xffffffff) => Number.isInteger(value) && value >= 0 && value <= max;
// A course is the main course (0) or a bonus number, as in the game's bonus versions.
export const MAX_COURSE = 99;
const course = value => value === undefined || uint(value, MAX_COURSE);
const bounded = (value, max) => Number.isFinite(value) && Math.abs(value) <= max;

function requireValid(valid, message) {
  if (!valid) throw new Error(message);
}

function validAppearance(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && typeof value.title === 'string' && value.title.length <= 24 && value.title === value.title.trim()
    && /^[\p{L}\p{N} _.'!?-]*$/u.test(value.title)
    && [value.titleColor, value.nameColor].every(color => color === null || typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))
    && Number.isSafeInteger(value.revision) && value.revision >= 0;
}

export function normalizeAppearance(value) {
  const valid = validAppearance(value);
  const appearance = valid ? value : DEFAULT_APPEARANCE;
  return {title: appearance.title, titleColor: appearance.titleColor, nameColor: appearance.nameColor, revision: appearance.revision};
}

export function validPose(pose) {
  return !!pose && uint(pose.time)
    && bounded(pose.x, 131072) && bounded(pose.y, 131072) && bounded(pose.z, 131072)
    && bounded(pose.vx, 32767) && bounded(pose.vy, 32767) && bounded(pose.vz, 32767)
    && bounded(pose.yaw, 360) && bounded(pose.pitch, 90) && uint(pose.flags, 63)
    && Number.isFinite(pose.seconds) && pose.seconds >= 0 && pose.seconds <= 86400;
}

function writePose(view, offset, pose) {
  requireValid(validPose(pose), 'Invalid pose');
  view.setUint32(offset, pose.time, true);
  view.setFloat32(offset + 4, pose.x, true);
  view.setFloat32(offset + 8, pose.y, true);
  view.setFloat32(offset + 12, pose.z, true);
  view.setInt16(offset + 16, Math.round(pose.vx), true);
  view.setInt16(offset + 18, Math.round(pose.vy), true);
  view.setInt16(offset + 20, Math.round(pose.vz), true);
  view.setUint16(offset + 22, Math.round((pose.yaw % 360 + 360) % 360 / 360 * 65535), true);
  view.setInt16(offset + 24, Math.round(pose.pitch / 90 * 32767), true);
  view.setUint8(offset + 26, pose.flags);
  view.setFloat32(offset + 28, pose.seconds, true);
}

function readPose(view, offset) {
  const pose = {
    time: view.getUint32(offset, true),
    x: view.getFloat32(offset + 4, true), y: view.getFloat32(offset + 8, true), z: view.getFloat32(offset + 12, true),
    vx: view.getInt16(offset + 16, true), vy: view.getInt16(offset + 18, true), vz: view.getInt16(offset + 20, true),
    yaw: view.getUint16(offset + 22, true) / 65535 * 360,
    pitch: view.getInt16(offset + 24, true) / 32767 * 90,
    flags: view.getUint8(offset + 26), seconds: view.getFloat32(offset + 28, true),
  };
  requireValid(validPose(pose) && view.getUint8(offset + 27) === 0, 'Invalid pose');
  return pose;
}

function validateBatch(batch) {
  requireValid(batch && uint(batch.sequence) && uint(batch.epoch)
    && Array.isArray(batch.samples) && batch.samples.length >= 1 && batch.samples.length <= 2, 'Invalid batch');
}

function dataView(buffer, min, max = min) {
  requireValid(buffer instanceof ArrayBuffer && buffer.byteLength >= min && buffer.byteLength <= max, 'Invalid packet size');
  return new DataView(buffer);
}

export function encodePoseBatch(batch) {
  validateBatch(batch);
  const buffer = new ArrayBuffer(POSE_HEADER_BYTES + POSE_SAMPLE_BYTES * batch.samples.length), view = new DataView(buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, 1);
  view.setUint8(2, batch.samples.length);
  view.setUint32(4, batch.sequence, true);
  view.setUint32(8, batch.epoch, true);
  batch.samples.forEach((pose, index) => writePose(view, 12 + index * 32, pose));
  return buffer;
}

export function decodePoseBatch(buffer) {
  const view = dataView(buffer, 12, 76), count = view.getUint8(2);
  requireValid(view.getUint8(0) === VERSION && view.getUint8(1) === 1 && view.getUint8(3) === 0
    && count >= 1 && count <= 2 && buffer.byteLength === 12 + count * 32, 'Invalid pose header');
  const samples = [];
  for (let index = 0; index < count; index++) samples.push(readPose(view, 12 + index * 32));
  return {sequence: view.getUint32(4, true), epoch: view.getUint32(8, true), samples};
}

export function encodeSnapshot(blocks) {
  requireValid(Array.isArray(blocks) && blocks.length <= MAX_SNAPSHOT_BLOCKS, 'Invalid snapshot');
  let length = SNAPSHOT_HEADER_BYTES;
  const slots = new Set();
  for (const block of blocks) {
    validateBatch(block);
    requireValid(uint(block.slot, MAX_ROOM_PLAYERS - 1) && !slots.has(block.slot), 'Invalid snapshot slot');
    slots.add(block.slot);
    length += SNAPSHOT_BLOCK_BYTES + block.samples.length * POSE_SAMPLE_BYTES;
  }
  const buffer = new ArrayBuffer(length), view = new DataView(buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, 2);
  view.setUint16(2, blocks.length, true);
  let offset = 4;
  for (const block of blocks) {
    view.setUint16(offset, block.slot, true);
    view.setUint32(offset + 2, block.sequence, true);
    view.setUint32(offset + 6, block.epoch, true);
    view.setUint8(offset + 10, block.samples.length);
    offset += 14;
    for (const pose of block.samples) {
      writePose(view, offset, pose);
      offset += 32;
    }
  }
  return buffer;
}

export function decodeSnapshot(buffer) {
  const view = dataView(buffer, SNAPSHOT_HEADER_BYTES, MAX_SNAPSHOT_BYTES), count = view.getUint16(2, true);
  requireValid(view.getUint8(0) === VERSION && view.getUint8(1) === 2 && count <= MAX_SNAPSHOT_BLOCKS, 'Invalid snapshot header');
  const blocks = [], slots = new Set();
  let offset = 4;
  for (let index = 0; index < count; index++) {
    requireValid(offset + 14 <= buffer.byteLength, 'Truncated block');
    const slot = view.getUint16(offset, true), sequence = view.getUint32(offset + 2, true);
    const epoch = view.getUint32(offset + 6, true), size = view.getUint8(offset + 10);
    requireValid(uint(slot, MAX_ROOM_PLAYERS - 1) && !slots.has(slot) && size >= 1 && size <= 2
      && view.getUint8(offset + 11) === 0 && view.getUint16(offset + 12, true) === 0, 'Invalid block');
    slots.add(slot);
    offset += 14;
    requireValid(offset + size * 32 <= buffer.byteLength, 'Truncated samples');
    const samples = [];
    for (let sample = 0; sample < size; sample++) samples.push(readPose(view, offset + sample * 32));
    offset += size * 32;
    blocks.push({slot, sequence, epoch, samples});
  }
  requireValid(offset === buffer.byteLength, 'Trailing snapshot data');
  return blocks;
}

function validSpectator(packet) {
  const pose = packet?.pose;
  return pose && uint(packet.slot, MAX_ROOM_PLAYERS - 1) && uint(packet.sequence) && uint(packet.epoch) && validPose(pose)
    && Number.isFinite(pose.eyeHeight) && pose.eyeHeight >= 0 && pose.eyeHeight <= 128
    && (pose.inputs === undefined || uint(pose.inputs, 63))
    && (pose.inputPresses === undefined || pose.inputs !== undefined && uint(pose.inputPresses, 63))
    && PHASES.includes(pose.phase) && typeof pose.untimed === 'boolean'
    && uint(pose.checkpoints, 1024) && uint(pose.stage, 1024);
}

export function encodeSpectator(packet, forwarded = false) {
  requireValid(validSpectator(packet), 'Invalid spectator state');
  const buffer = new ArrayBuffer(SPECTATOR_BYTES), view = new DataView(buffer), pose = packet.pose;
  view.setUint8(0, VERSION);
  view.setUint8(1, forwarded ? 4 : 3);
  view.setUint16(2, packet.slot, true);
  view.setUint32(4, packet.sequence, true);
  view.setUint32(8, packet.epoch, true);
  writePose(view, 12, pose);
  view.setFloat32(44, pose.eyeHeight, true);
  view.setUint8(48, PHASES.indexOf(pose.phase));
  view.setUint8(49, Number(pose.untimed));
  view.setUint16(50, pose.checkpoints, true);
  view.setUint16(52, pose.stage, true);
  if (pose.inputs !== undefined) {
    view.setUint8(54, 128 | pose.inputs);
    view.setUint8(55, pose.inputPresses ?? 0);
  }
  return buffer;
}

export function decodeSpectator(buffer, forwarded = false) {
  const view = dataView(buffer, 56), inputs = view.getUint8(54), presses = view.getUint8(55);
  requireValid(view.getUint8(0) === VERSION && view.getUint8(1) === (forwarded ? 4 : 3)
    && view.getUint8(48) <= 2 && view.getUint8(49) <= 1
    && (inputs === 0 || (inputs & 128) !== 0) && !(inputs & 64)
    && presses <= 63 && (inputs !== 0 || presses === 0), 'Invalid spectator header');
  const packet = {slot: view.getUint16(2, true), sequence: view.getUint32(4, true), epoch: view.getUint32(8, true), pose: {
    ...readPose(view, 12), eyeHeight: view.getFloat32(44, true), phase: PHASES[view.getUint8(48)],
    untimed: !!view.getUint8(49), checkpoints: view.getUint16(50, true), stage: view.getUint16(52, true),
    ...(inputs & 128 ? {inputs: inputs & 63, inputPresses: presses} : {}),
  }};
  requireValid(validSpectator(packet), 'Invalid spectator state');
  return packet;
}

// The sender's bytes go on unchanged (no second rounding); only the slot is the host's.
export function relayPose(buffer, slot) {
  const batch = decodePoseBatch(buffer);
  requireValid(uint(slot, MAX_ROOM_PLAYERS - 1), 'Invalid slot');
  const output = new ArrayBuffer(buffer.byteLength + 6), view = new DataView(output);
  view.setUint8(0, VERSION);
  view.setUint8(1, 2);
  view.setUint16(2, 1, true);
  view.setUint16(4, slot, true);
  view.setUint32(6, batch.sequence, true);
  view.setUint32(10, batch.epoch, true);
  view.setUint8(14, batch.samples.length);
  new Uint8Array(output, 18).set(new Uint8Array(buffer, 12));
  return {buffer: output, epoch: batch.epoch, sequence: batch.sequence};
}

export function relaySpectator(buffer, slot) {
  const packet = decodeSpectator(buffer);
  requireValid(uint(slot, MAX_ROOM_PLAYERS - 1), 'Invalid slot');
  const output = buffer.slice(0), view = new DataView(output);
  view.setUint8(1, 4);
  view.setUint16(2, slot, true);
  return {buffer: output, epoch: packet.epoch, sequence: packet.sequence};
}

export function encodeControlFrames(message) {
  const text = typeof message === 'string' ? message : JSON.stringify(message);
  if (text.length <= MAX_CONTROL_BYTES && controlWireSize(text) <= MAX_CONTROL_BYTES) return [text];
  const frames = [];
  // Bound chunks even when JSON escaping expands every character.
  for (let offset = 0; offset < text.length; offset += ROOM_CHUNK_CHARS) {
    frames.push(JSON.stringify({type: 'room-chunk', data: text.slice(offset, offset + ROOM_CHUNK_CHARS),
      final: offset + ROOM_CHUNK_CHARS >= text.length}));
  }
  return frames;
}

export function decodeControl(text) {
  requireValid(typeof text === 'string' && text.length <= MAX_CONTROL_BYTES
    && encoder.encode(text).byteLength <= MAX_CONTROL_BYTES, 'Invalid room data');
  if (text === 'ping') return {type: 'ping'};
  const message = JSON.parse(text);
  requireValid(message && typeof message === 'object' && !Array.isArray(message) && typeof message.type === 'string', 'Invalid room message');
  switch (message.type) {
    case 'saveloc-save': {
      requireValid(identifier(message.mapId) && uint(message.epoch) && message.epoch > 0, 'Invalid saveloc map');
      const snapshot = sanitizeSaveloc(message.snapshot);
      requireValid(JSON.parse(snapshot.key)[0] === message.mapId, 'Invalid saveloc key');
      return {type: 'saveloc-save', mapId: message.mapId, epoch: message.epoch, snapshot};
    }
    case 'saveloc-delete':
      requireValid(identifier(message.mapId) && uint(message.epoch) && message.epoch > 0
        && Number.isSafeInteger(message.id) && message.id > 0, 'Invalid saveloc deletion');
      return {type: 'saveloc-delete', mapId: message.mapId, epoch: message.epoch, id: message.id};
    case 'paint-add':
    case 'paint-erase':
    case 'paint-clear': {
      requireValid(identifier(message.mapId) && uint(message.epoch) && message.epoch > 0, 'Invalid paint map');
      const envelope = {type: message.type, mapId: message.mapId, epoch: message.epoch};
      if (message.type === 'paint-add') {
        requireValid(paintDots(message.dots, MAX_PAINT_BATCH), 'Invalid paint');
        return {...envelope, dots: message.dots.map(dot => dot.slice())};
      }
      if (message.type === 'paint-erase') {
        requireValid(isPaintPoint(message.point) && isEraseRadius(message.radius), 'Invalid paint erase');
        return {...envelope, point: message.point.slice(), radius: message.radius};
      }
      return envelope;
    }
    case 'chat':
      requireValid(typeof message.text === 'string' && message.text.trim().length > 0, 'Invalid chat');
      return {type: 'chat', text: message.text.trim().slice(0, 240)};
    case 'course':
      requireValid(uint(message.course, MAX_COURSE), 'Invalid course');
      return {type: 'course', course: message.course};
    case 'finish':
      requireValid(identifier(message.mapId) && uint(message.epoch) && message.epoch > 0 && course(message.course)
        && runTime(message.timeUs) && typeof message.personalBest === 'boolean'
        && (message.previousBestUs === null || message.personalBest && runTime(message.previousBestUs)
          && message.previousBestUs > message.timeUs), 'Invalid room finish');
      return {type: 'finish', mapId: message.mapId, epoch: message.epoch, course: message.course ?? 0, timeUs: message.timeUs,
        personalBest: message.personalBest, previousBestUs: message.previousBestUs};
    case 'verified': {
      const ranked = message.leaderboardRank !== undefined || message.leaderboardTotal !== undefined;
      requireValid((message.id === undefined || isUuid(message.id)) && identifier(message.mapId) && uint(message.epoch) && message.epoch > 0
        && course(message.course) && runTime(message.timeUs) && typeof message.personalBest === 'boolean' && typeof message.record === 'boolean'
        && (message.previousBestUs === null || (message.personalBest || message.record) && runTime(message.previousBestUs)
          && message.previousBestUs > message.timeUs)
        && isPointsDelta(message.pointsDelta) && typeof message.promoted === 'boolean'
        && (message.rank === undefined || message.promoted && textValue(message.rank, 32))
        && (!ranked || isStanding(message.leaderboardRank, message.leaderboardTotal)), 'Invalid room finish');
      return {type: 'verified', ...(message.id === undefined ? {} : {id: message.id}), mapId: message.mapId, epoch: message.epoch,
        course: message.course ?? 0, timeUs: message.timeUs, personalBest: message.personalBest, previousBestUs: message.previousBestUs, record: message.record,
        pointsDelta: message.pointsDelta, promoted: message.promoted, ...(message.rank === undefined ? {} : {rank: message.rank}),
        ...(ranked ? {leaderboardRank: message.leaderboardRank, leaderboardTotal: message.leaderboardTotal} : {})};
    }
    case 'change-map':
      requireValid(typeof message.mapId === 'string' && message.mapId.length > 0, 'Invalid map');
      return {type: 'change-map', mapId: message.mapId};
    case 'spectate':
      requireValid((message.connectionId === null || typeof message.connectionId === 'string')
        && Number.isSafeInteger(message.request) && message.request >= 0, 'Invalid spectator request');
      return {type: 'spectate', connectionId: message.connectionId, request: message.request};
    case 'moderate':
      requireValid(typeof message.playerId === 'string' && (message.action === 'kick' || message.action === 'ban'), 'Invalid moderation');
      return {type: 'moderate', playerId: message.playerId, action: message.action};
  }
  return {type: message.type};
}

export function controlWireSize(text) {
  return 1 + encoder.encode(text).byteLength;
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const textValue = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
const identifier = value => textValue(value, 256);
const paintDots = (dots, max) => Array.isArray(dots) && dots.length > 0 && dots.length <= max && dots.every(isPaintDot);
const timestamp = value => Number.isSafeInteger(value) && value >= 0;
export const runTime = value => Number.isSafeInteger(value) && value > 0 && value <= 86400000000;
const isPointsDelta = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e6;
// A leaderboard place the game would print: 0 < rank <= total.
export const isStanding = (rank, total) => Number.isSafeInteger(rank) && Number.isSafeInteger(total) && rank > 0 && total >= rank && total <= 1e9;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The site's username rules, which Guest_ names also meet.
export const isPlayerName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{3,24}$/.test(value);
export const isGuestName = value => typeof value === 'string' && /^Guest_[0-9a-f]{5}$/.test(value);
export const isUuid = value => typeof value === 'string' && UUID.test(value);
// The game's rank table, for a game build whose own table can't be read.
export const RANKS = Object.freeze([[0, 'Unranked'], [100, 'Rookie'], [500, 'Surfer'], [2000, 'Regular'],
  [4000, 'Skilled'], [7000, 'Expert'], [11000, 'Master'], [20000, 'Legend']].map(([points, title]) => Object.freeze({points, title})));
export const isPoints = value => Number.isSafeInteger(value) && value >= 0 && value <= 1e9;
export function rankTable(value) {
  if (!Array.isArray(value) || !value.length || value.length > 32 || value[0]?.points !== 0) return RANKS;
  const titles = new Set();
  for (const [index, rank] of value.entries()) {
    if (!record(rank) || !isPoints(rank.points) || (index > 0 && rank.points <= value[index - 1].points)
      || typeof rank.title !== 'string' || !/^[A-Za-z][A-Za-z ]{0,23}$/.test(rank.title)
      || rank.title === 'Guest' || titles.has(rank.title)) return RANKS;
    titles.add(rank.title);
  }
  return value.map(({points, title}) => ({points, title}));
}
export const rankFor = (points, ranks) => ranks.findLast(rank => points >= rank.points).title;
export const normalizeRoomName = value => typeof value === 'string' ? value.trim().replace(/ +/g, ' ') : '';
export function roomNameProblem(value) {
  const name = normalizeRoomName(value);
  if (name.length < 3 || name.length > 32) return 'Room names need 3–32 characters.';
  if (!/^[A-Za-z0-9 '\-_.!?&#:()]+$/.test(name)) return 'Use letters, numbers, spaces and simple punctuation.';
  return /surfd|official/i.test(name) ? "Room names can't include Surfd or official." : null;
}
export const isRoomName = value => typeof value === 'string' && value === normalizeRoomName(value) && roomNameProblem(value) === null;
const playerId = value => typeof value === 'string' && value.startsWith('private-') && UUID.test(value.slice(8));

export function catalogEntry(map) {
  return {id: map.id, title: map.title ?? map.name ?? map.id, ...(map.tier !== undefined ? {tier: map.tier} : {})};
}

// Each host message is rebuilt from the fields the game reads, so nothing else a host sends reaches it.
// Maps and ranks come from the receiver's own game; host is true for the host's own view of its room.
export function createRoomFilter({roomId, maps = [], ranks = RANKS, host = false}) {
  const catalog = new Map(maps.map(map => [map.id, catalogEntry(map)]));
  const titles = new Set(rankTable(ranks).map(rank => rank.title));
  let own = null, current = null;
  function readPlayer(player) {
    requireValid(record(player) && typeof player.connectionId === 'string' && UUID.test(player.connectionId)
      && player.id === 'private-' + player.connectionId && uint(player.slot, MAX_ROOM_PLAYERS - 1) && isPlayerName(player.name)
      && (player.guest === true ? isGuestName(player.name) && player.userId === undefined && player.rank === 'Guest' && player.points === 0
        : player.guest === false && (player.userId === undefined || isUuid(player.userId))
          && titles.has(player.rank) && isPoints(player.points))
      && typeof player.moderator === 'boolean' && typeof player.spectating === 'boolean' && course(player.course)
      && validAppearance(player.appearance), 'Invalid room player');
    return {id: player.id, connectionId: player.connectionId, slot: player.slot, name: player.name,
      rank: player.rank, points: player.points, guest: player.guest, ...(player.userId === undefined ? {} : {userId: player.userId}),
      moderator: player.moderator, appearance: normalizeAppearance(player.appearance), spectating: player.spectating,
      course: player.course ?? 0};
  }
  const validRank = rank => rank === 'Guest' || titles.has(rank);
  function readPlayers(players) {
    requireValid(Array.isArray(players) && players.length <= MAX_ROOM_PLAYERS, 'Invalid room roster');
    const slots = new Set(), connections = new Set();
    let moderators = 0;
    const result = players.map(value => {
      const player = readPlayer(value);
      requireValid(!slots.has(player.slot) && !connections.has(player.connectionId), 'Duplicate room player');
      slots.add(player.slot);
      connections.add(player.connectionId);
      if (player.moderator) moderators++;
      requireValid(!player.moderator || own === null || (player.connectionId === own) === host, 'Invalid room moderator');
      return player;
    });
    requireValid(moderators <= 1, 'Invalid room moderator');
    return result;
  }
  function readState(state) {
    requireValid(record(state) && state.roomId === roomId && isRoomName(state.name)
      && ['private', 'public'].includes(state.visibility) && isMaxPlayers(state.maxPlayers) && catalog.has(state.mapId)
      && uint(state.epoch) && state.epoch > 0 && timestamp(state.startedAt)
      && state.endsAt === 0 && state.untimed === true
      && Array.isArray(state.recent) && state.recent.length <= 8 && state.recent.every(identifier)
      && record(state.nominations) && Object.keys(state.nominations).length === 0
      && Array.isArray(state.rtv) && state.rtv.length === 0
      && state.vote === null && state.nextMap === null, 'Invalid room state');
    return {roomId, name: state.name, visibility: state.visibility, maxPlayers: state.maxPlayers,
      mapId: state.mapId, mapTitle: catalog.get(state.mapId).title,
      epoch: state.epoch, startedAt: state.startedAt, endsAt: 0, untimed: true,
      recent: state.recent.filter(id => catalog.has(id)), nominations: {}, rtv: [], vote: null, nextMap: null};
  }
  return message => {
    requireValid(record(message), 'Invalid room message');
    switch (message.type) {
      case 'welcome': {
        const state = readState(message.state), player = readPlayer(message.player);
        own = player.connectionId;
        const players = readPlayers(message.players);
        const entry = players.find(value => value.connectionId === own);
        requireValid(entry && JSON.stringify(entry) === JSON.stringify(player), 'Invalid own room player');
        requireValid(Array.isArray(message.maps) && timestamp(message.serverTime)
          && message.spectatorStream === true && message.playtime === false && message.activityTracking === false
          && [undefined, true].includes(message.courses) && Array.isArray(message.recentResults) && message.recentResults.length === 0 && message.chatMute === null,
        'Invalid room welcome');
        const ids = new Set(message.maps.map(map => record(map) ? map.id : null));
        current = state;
        return {type: 'welcome', state, player, players, maps: [...ids].filter(id => catalog.has(id)).map(id => catalog.get(id)),
          serverTime: message.serverTime, spectatorStream: true, playtime: false, courses: message.courses === true,
          activityTracking: false, recentResults: [], chatMute: null};
      }
      case 'state': {
        requireValid(timestamp(message.serverTime), 'Invalid room time');
        const state = readState(message.state);
        current = state;
        return {type: 'state', state, serverTime: message.serverTime};
      }
      case 'saveloc-init':
      case 'saveloc-add':
      case 'saveloc-remove': {
        requireValid(catalog.has(message.mapId) && uint(message.epoch) && message.epoch > 0, 'Invalid saveloc map');
        if (!current || message.mapId !== current.mapId || message.epoch !== current.epoch) return null;
        const envelope = {type: message.type, mapId: message.mapId, epoch: message.epoch};
        if (message.type === 'saveloc-init') {
          requireValid(isUuid(message.ownerId) && uint(message.count, MAX_ROOM_SAVELOCS), 'Invalid saveloc owner');
          return {...envelope, ownerId: message.ownerId, count: message.count};
        }
        if (message.type === 'saveloc-remove') {
          requireValid(Number.isSafeInteger(message.id) && message.id > 0, 'Invalid saveloc ID');
          return {...envelope, id: message.id};
        }
        const entry = message.entry;
        requireValid(record(entry) && Number.isSafeInteger(entry.id) && entry.id > 0
          && isUuid(entry.ownerId) && isPlayerName(entry.name), 'Invalid saveloc entry');
        const snapshot = sanitizeSaveloc(entry.snapshot);
        requireValid(JSON.parse(snapshot.key)[0] === message.mapId, 'Invalid saveloc key');
        return {...envelope, entry: {id: entry.id, ownerId: entry.ownerId, name: entry.name, snapshot}};
      }
      case 'paint-init':
      case 'paint-add':
      case 'paint-erase':
      case 'paint-clear': {
        requireValid(catalog.has(message.mapId) && uint(message.epoch) && message.epoch > 0, 'Invalid paint map');
        if (!current || message.mapId !== current.mapId || message.epoch !== current.epoch) return null;
        const envelope = {type: message.type, mapId: message.mapId, epoch: message.epoch};
        if (message.type === 'paint-clear') {
          requireValid(message.ownerId === null || isUuid(message.ownerId), 'Invalid paint owner');
          return {...envelope, ownerId: message.ownerId};
        }
        requireValid(isUuid(message.ownerId), 'Invalid paint owner');
        if (message.type === 'paint-init') return {...envelope, ownerId: message.ownerId};
        if (message.type === 'paint-erase') {
          requireValid(isPaintPoint(message.point) && isEraseRadius(message.radius), 'Invalid paint erase');
          return {...envelope, ownerId: message.ownerId, point: message.point.slice(), radius: message.radius};
        }
        requireValid(paintDots(message.dots, MAX_OWNER_PAINT), 'Invalid paint');
        return {...envelope, ownerId: message.ownerId, dots: message.dots.map(dot => dot.slice())};
      }
      case 'roster':
        return {type: 'roster', players: readPlayers(message.players)};
      case 'chat':
        requireValid(playerId(message.playerId) && isPlayerName(message.name) && textValue(message.text, 240)
          && (message.rank === undefined || validRank(message.rank))
          && (message.appearance === undefined || validAppearance(message.appearance)), 'Invalid room chat');
        return {type: 'chat', playerId: message.playerId, name: message.name, text: message.text,
          ...(message.rank === undefined ? {} : {rank: message.rank}),
          ...(message.appearance === undefined ? {} : {appearance: normalizeAppearance(message.appearance)})};
      case 'result': {
        // Only runs the site verified carry points, promotions and a leaderboard place; an unverified record is the room's.
        const result = message.result, verified = result?.verified === true;
        const ranked = verified && (result.leaderboardRank !== undefined || result.leaderboardTotal !== undefined);
        requireValid(record(result) && isUuid(result.id) && (isUuid(result.userId) || playerId(result.userId))
          && isPlayerName(result.name) && validRank(result.rank) && catalog.has(result.mapId)
          && (result.bonus === undefined || uint(result.bonus, MAX_COURSE) && result.bonus > 0)
          && runTime(result.timeUs) && typeof result.record === 'boolean' && typeof result.personalBest === 'boolean'
          && (result.previousBestUs === null || (result.record || result.personalBest)
            && runTime(result.previousBestUs) && result.previousBestUs > result.timeUs)
          && [undefined, true, false].includes(result.verified) && [undefined, true, false].includes(result.roomRecord)
          && (verified ? isPointsDelta(result.pointsDelta) && typeof result.promoted === 'boolean'
            && (!ranked || isStanding(result.leaderboardRank, result.leaderboardTotal))
            : result.pointsDelta === 0 && result.promoted === false), 'Invalid room result');
        const roomRecord = result.record && (!verified || result.roomRecord === true);
        return {type: 'result', result: {id: result.id, userId: result.userId, name: result.name, rank: result.rank,
          mapId: result.mapId, mapTitle: catalog.get(result.mapId).title, ...(result.bonus ? {bonus: result.bonus} : {}),
          timeUs: result.timeUs, record: result.record, ...(roomRecord ? {roomRecord} : {}), personalBest: result.personalBest, previousBestUs: result.previousBestUs,
          pointsDelta: verified ? result.pointsDelta : 0, promoted: verified && result.promoted,
          ...(ranked ? {leaderboardRank: result.leaderboardRank, leaderboardTotal: result.leaderboardTotal} : {}), verified}};
      }
      case 'notice':
      case 'error': {
        requireValid(textValue(message.text, 4096)
          && (message.spectatorRequest === undefined || timestamp(message.spectatorRequest)), 'Invalid room notice');
        if (message.spectatorRequest === undefined) return isRoomText(message.text) ? {type: message.type, text: message.text} : null;
        // An error for the current spectate request is what stops spectating, so it keeps a text of our own.
        return {type: message.type, text: isRoomText(message.text) ? message.text : ROOM_TEXTS.unavailable,
          spectatorRequest: message.spectatorRequest};
      }
      case 'spectator-demand':
        requireValid(typeof message.active === 'boolean' && uint(message.count, MAX_ROOM_PLAYERS)
          && (message.count > 0) === message.active, 'Invalid spectator demand');
        return {type: 'spectator-demand', active: message.active, count: message.count};
      case 'context':
        requireValid(uint(message.epoch) && message.token === null, 'Invalid room context');
        return {type: 'context', epoch: message.epoch, token: null};
      default:
        throw new Error('Invalid room message type');
    }
  };
}

export function createRoomControlReader(filter = null) {
  let chunks = [], length = 0;
  const clear = () => { chunks = []; length = 0; };
  return {
    clear,
    read(text) {
      requireValid(typeof text === 'string' && text.length <= MAX_CONTROL_BYTES
        && encoder.encode(text).byteLength <= MAX_CONTROL_BYTES, 'Invalid room frame');
      let message;
      try { message = JSON.parse(text); } catch {
        requireValid(!chunks.length && (filter === null || text === 'pong'), 'Invalid room JSON');
        return text;
      }
      if (message?.type === 'room-chunk') {
        requireValid(typeof message.data === 'string' && message.data.length > 0
          && typeof message.final === 'boolean' && chunks.length < MAX_ROOM_CHUNKS
          && length + message.data.length <= MAX_ROOM_MESSAGE_CHARS, 'Invalid room chunk');
        chunks.push(message.data);
        length += message.data.length;
        if (!message.final) return null;
        text = chunks.join('');
        clear();
        message = JSON.parse(text);
        requireValid(message?.type !== 'room-chunk', 'Nested room chunk');
      } else requireValid(!chunks.length, 'Interrupted room chunks');
      if (!filter) return text;
      const rebuilt = filter(message);
      return rebuilt === null ? null : JSON.stringify(rebuilt);
    },
  };
}

export function validateRoomBinary(buffer) {
  const view = dataView(buffer, SNAPSHOT_HEADER_BYTES, MAX_SNAPSHOT_BYTES);
  if (view.getUint8(1) === 4) decodeSpectator(buffer, true);
  else decodeSnapshot(buffer);
}
