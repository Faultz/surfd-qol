# Private rooms: the room protocol

A private room is hosted by a player's own browser tab. The extension swaps the game's room WebSocket for its own socket when the room id is private, and the host tab answers in the game's protocol, so the game's lobby, roster, chat, spectating and map changes work unchanged. This is the reference for that protocol as the game's client uses it.

Code: `src/private-rooms/` (`host.js` the room, `protocol.js` the codecs, `socket.js` the sockets, `index.js` the wiring) and the `roomHooks` in `extension/instrument.js`.

The game's client validates binary frames strictly but consumes most JSON fields directly; what follows is what it reads. When the game updates, find the code again by these literals: `"surfd-v1"`, `"/servers/"`, `"Invalid spectator header"`, `"Changing map…"`, `"You were invited to"`.

The game trusts its server and puts some fields (a map's tier, for one) into markup unescaped, so guests rebuild every message from the host out of the fields listed here before the game sees it, dropping anything else. Map ids must be in the guest's own catalog, and titles and tiers come from that catalog. Invalid data closes with 4002.

## Ids and joining

Room ids are `p-` and 12 characters of `abcdefghjkmnpqrstuvwxyz23456789` (no 0, 1, i, l or o), random and unguessable. Official server ids (`eu`, `na`, `eut3`, …) never match. People see them as codes in three groups of four capitals (`GZXF-F9T2-R5RK`); a typed code ignores case, spaces and dashes, and a `surfd.net/?join=` link works too.

Player-hosted rooms show in the game's server list under a Community tab: public rooms from the meeting point's directory, private rooms only for their host and people with the code. Rows carry `visibility`, `players`, `capacity` (the host's limit), `endsAt: 0`, `untimed: true` and a measured ping when known; map titles come from the local catalog. Hide full never hides them and Play now never picks them. An invite link or a typed code joins directly.

Before the game's own messages, each joining client sends the host an extension-only hello: `{name, appearance, guest, userId, browserId, rank?, points?}`, with no tokens. `userId` is a signed-in player's public account id or `null`; `browserId` is a random id kept in localStorage, used for bans; `rank` and `points` are a signed-in player's as the game's own profile shows them. Nobody can verify who a player is: a modified client can use anyone's name or account id. A name that breaks the rules below joins as a guest with a new `Guest_` name.

The host checks each joining account once against the site's public profile, `/api/surf?action=progression&userId=<id>` without credentials: when its username is the player's name, the room uses its rank and points; another name or no profile gives the lowest rank and 0 points; a check that fails (429, 5xx, offline) keeps the claim.

Player names follow the site's username rules: 3–24 letters, digits, `_` or `-`; guests are `Guest_` plus five lowercase hex characters. Room names are 3–32 letters, digits, spaces or `' - _ . ! ? & # : ( )`, without "surfd" or "official" in any case; the default is `<username>'s room`. Renaming broadcasts `state` without a new epoch.

A room holds at most 64 players. The host sets a limit from 2 to 64 (default 16); joins past it close with 4008 "This room is full." Lowering it keeps everyone already in. Hosting needs a surfd.net account (a client-side rule), and signing out while hosting ends the room.

## Meeting point and relay

The host connects with `role=host` and sends `{type: "auth", key}` as its first message; after any unexpected close it reconnects with the same key, and its peer connections stay open meanwhile. A guest's `role=guest` connection carries its `room-info` request and the WebRTC exchange, then closes once the peer connection is up. The host answers `room-info` at most once per peer every 5 seconds, takes at most 3 offers per peer a minute, and keeps at most 32 negotiations open, each for up to 15 seconds.

Every peer connection uses only the meeting point's TURN servers, with `iceTransportPolicy: "relay"`, so nobody sees another player's IP address; there is no direct fallback. Without credentials, hosting fails and joins close with 4000 "Couldn't reach the room service. Try again in a moment." Credentials last an hour and renew after 45 minutes; renewal restarts ICE over the open control channel, the guest making the offer:

| Control message | From | Meaning |
| --- | --- | --- |
| `{type: "restart"}` | host | the host renewed; the guest restarts ICE (at most 3 a minute, the rest ignored) |
| `{type: "offer", description}` | guest | an ICE restart offer; a host closes with 4002 past 3 a minute |
| `{type: "answer", description}` | host | its answer |
| `{type: "ice", candidate}` | either | a candidate gathered once the socket is open, sent after the description it belongs to |

Public hosts send `listing` `{name, mapId, players, capacity, roster}` when the row changes and at least every 30 seconds; `listing: null` unlists the room even after the host exhausts its update budget. `roster` holds up to 24 `{name, guest, userId?}`, with the same player-name rules as room rosters. `GET /rooms` returns `{rooms: [{id, name, mapId, players, capacity, roster, updatedAt}]}`; the client fetches it only while the main menu or server browser is showing, at most every 10 seconds, and skips invalid rows. Previews show names and guest labels only, no ranks or points, and a profile opens only by a listed `userId`.

Friends' Join buttons and accepted invitations reach community rooms through the meeting point, not the site. Inviting a friend sends the site's own invite with the room id, which the site accepts but never delivers for a community room, so the friend is also sent a friend message with the room's invite link (`Join my room: https://surfd.net/?join=…`). The extension shows that link in a message as a Join room button. The site sets friends' presence itself, so a friend's status can't show a community room.

Community command replies are local and fixed: votes explain that the host picks maps; `timeleft` reports no limit; `nextmap` points to the host; rank/playtime queries explain they need official servers. Official-room command handling is unchanged.

## Shared structures

**Appearance:** `{title, titleColor, nameColor, revision}`. `title` is at most 24 characters of letters, digits, space and `_.'!?-`; the colours are `null` or `#RRGGBB`; `revision` is a non-negative integer. The default is `{title: "", titleColor: null, nameColor: null, revision: 0}`.

**Player:** `{id, connectionId, slot, name, rank, points, guest, userId?, moderator, appearance, spectating}`.
- `id` drives mutes, own-player checks and chat senders; `connectionId` tells live connections apart and picks spectator targets; `slot` (a unique uint16) picks the interpolation buffer for binary poses. Names need not be unique.
- A freed slot is reused with a new `connectionId`, which makes the game clear the old buffer.
- In private rooms: `connectionId` is a UUID, `id` is `private-<connectionId>`; guests have `rank` `"Guest"` and 0 `points`, signed-in players a title from the receiver's own rank table (the game's `{points, title}` list, or a built-in copy) and 0 to 10^9 points. Only the host has `moderator: true` (guests accept at most one moderator, never themselves), and `guest` is the player's real status, as on official servers. Guest labels follow `guest`, not the name's spelling. Signed-in players may carry `userId`; guests never do.
- The game refuses to send chat for its own guest player, shows map controls only to moderators who aren't guests, and hides View profile, Add friend and Block for guests. Add friend sends a request by name. In private rooms View profile opens `userId` instead of `id`, and Block is hidden, as the room can't confirm who a player is.

**State:** the game reads `mapId`, `epoch`, `endsAt`, `recent`, `nominations`, `vote` and `nextMap`. A player-hosted room sends `{roomId, name, visibility, maxPlayers, mapId, mapTitle, epoch, startedAt, endsAt: 0, untimed: true, recent: [], nominations: {}, rtv: [], vote: null, nextMap: null}`. `visibility` is `"public"` or `"private"`; name, visibility and capacity changes broadcast `state` without changing the epoch. `epoch` starts at 1 and increases on map changes; `recent` keeps up to 8 earlier maps. `untimed` prevents the native countdown from interpreting `endsAt: 0` as "Changing map…".

## Client → room

| Message | Fields | Private host |
| --- | --- | --- |
| `ping` (plain text) | sent every 15 s; the reply measures ping | answers `pong` |
| `chat` | `text`, trimmed and limited to 240 characters by the host | refuses guests with an `error` "Sign in to send chat messages. You can still read chat."; otherwise masks whole-word English slurs and strong profanity with equal-length asterisks, then broadcasts to everyone, sender included, with the sender's fields. Matching ignores case and handles letter substitutions and repetition, not innocent substrings. The list and licence are in `chat-filter-words.js` and `chat-filter-notice.txt`. Rate: 1 per second with bursts of 3, beyond which the sender gets one `error` "You're sending messages too fast." |
| `finish` (extension only) | `mapId`, `epoch`, `timeUs`, `personalBest`, `previousBestUs` | a map and epoch from the room's current or last 8 epochs; integer time from 1 to 86,400,000,000 µs; at most one accepted claim per player every 3 seconds, excess dropped. `previousBestUs` is the browser's earlier map best when beaten, otherwise `null`; a non-null best must exceed the finish time. |
| `verified` (extension only) | `id?`, `mapId`, `epoch`, `timeUs`, `personalBest`, `previousBestUs`, `record`, `pointsDelta`, `promoted`, `rank?`, `leaderboardRank?`, `leaderboardTotal?` | from signed-in players with an account id; map and epoch as for `finish`; `id` a UUID, each announced once; `pointsDelta` 0–1,000,000; `rank` only with `promoted`; leaderboard fields together, `0 < leaderboardRank <= leaderboardTotal`; 1 every 3 seconds with bursts of 3, excess dropped |
| `saveloc-save` (extension only) | `mapId`, `epoch`, `snapshot` | current map and epoch; checked as under Shared savelocs; 1 per second with bursts of 3 per owner, excess dropped; 20 per owner, replacing that owner's oldest |
| `saveloc-delete` (extension only) | `mapId`, `epoch`, `id` | current map and epoch; removes only the sender's own save |
| `change-map` | `mapId` from the game's catalog | host only, to a different known map: new epoch, `state` to all |
| `spectate` | `connectionId` or `null` to stop, `request` (increasing integer) | refuses self, missing or already-spectating targets with an `error` carrying `spectatorRequest`; starts and target changes allow 2 per second with bursts of 4, beyond which they are dropped; Stop always applies, and repeated Stop/current-target requests only retain the latest request id |
| `context` | none; the game waits up to 2.5 s for it when a map starts | answers `{type: "context", epoch, token: null}`; without a token the game submits finished runs like solo runs, and the site verifies each replay |
| `refresh`, `ack`, `activity` | ticket refresh, `check` reply, activity tracking | ignored |
| `rtv`, `nominate`, `vote`, `extend` | map votes | ignored |
| `moderate` | `playerId`, `action` (`"kick"` or `"ban"`), `minutes` (the game sends 60) | host only, not on itself: closes the player with 4008 "You were kicked from this room." or "You were banned from this room for 1 hour." and sends everyone a `notice` "<name> was kicked." or "<name> was banned for 1 hour.". A ban refuses that `browserId` for an hour with 4008 "You're banned from this room for now." |
| `query`, `report`, `reports` | official server services | ignored |

## Room → client

| Message | Fields and what the game does with them |
| --- | --- |
| `pong` (plain text) | updates the ping display |
| `welcome` | `{state, player, players, maps, serverTime, spectatorStream, playtime, activityTracking, recentResults?, chatMute?}`. Sets the own player, roster and state and loads the map. Private: `spectatorStream: true`, `playtime` and `activityTracking` false, `recentResults: []`, `chatMute: null`. |
| `state` | `{state, serverTime}`. Lower epochs are ignored; a new epoch clears pose and spectator buffers, so the host republishes spectator demand after a map change. |
| `roster` | `{players}`. Replaces the roster and clears buffers of slots that changed hands. The private host sends at most one every 100 ms when roster fields change; switching spectator targets does not broadcast an unchanged roster. |
| `chat` | `{playerId, name, text, rank?, appearance?}` (flat fields, not a `sender` object) |
| `notice`, `error` | `{text, spectatorRequest?}`. Shown in chat; an `error` matching the current spectate request stops spectating. Guests keep only the extension's own texts (`ROOM_TEXTS`): they drop other notices and give an `error` with `spectatorRequest` "That player is not available to spectate." |
| `spectator-demand` | `{active, count}`; `count` is 0–64 and positive exactly when `active`. Tells a player to stream detailed frames. |
| `context` | `{epoch, token}`; private `token` is always `null` |
| `result` | a finished run, below |
| `saveloc-init` (extension only) | `{mapId, epoch, ownerId, count}` after `welcome` and each map change: this browser's owner id, and how many retained saves follow directly. A joiner applies those as one batch and redraws the list once. |
| `saveloc-add` (extension only) | `{mapId, epoch, entry: {id, ownerId, name, snapshot}}`: a new save, or a retained one after `saveloc-init` |
| `saveloc-remove` (extension only) | `{mapId, epoch, id}`: a deletion or a replaced save, sent before the save that replaces it |
| `check`, `afk-warning`, `chat-status`, `reports` | official server features; never sent by a private room |

**Result:** `{result}` with `id` (deduplication), `userId`, `name`, `rank`, `mapId`, `mapTitle`, `timeUs`, `record`, `personalBest`, `previousBestUs`, `pointsDelta`, `promoted`, and optionally `leaderboardRank`, `leaderboardTotal` and `stageRecords` (`[{stage, timeUs, previousRecordUs}]`, at most 64). `record` outranks `personalBest` in the text and sound; leaderboard text needs `0 < leaderboardRank <= leaderboardTotal`. Community rooms add `verified` and `roomRecord`.

Private rooms announce valid timed finishes, including the host's through its loopback. The extension compares against this browser's run history before recording the finish; practice, invalid, replay and spectated runs send nothing. A finish the game sends to the site for verification (the game reports its attempt id while it handles the finish) waits for the site's verdict; any other finish is claimed at once with `finish`. When the site verifies the run and its submission carries the game's `result`, the finisher sends `verified` with the site's fields; a rejected run, or one without a result, sends `finish` then.

Only a personal best or site record changes the leaderboard, so only those wait for the host's check: it reads the map's uncached board (`/api/surf?action=leaderboard&boardId=<id>`, no credentials) once, within a room-wide budget of 5 reads and then one every 2 seconds, and the player's entry must show the claimed time (in first place for a site record), or, when the board lists only its top places, the time and place must fall below them. The board's place and total replace the claimed ones. A best the board doesn't confirm, or a board that can't be read, makes the run unverified. A slower run is announced at once without points or promotion, which only a best earns; a place it carries is kept only when the board, read once, agrees.

The host supplies the room player's `userId` (or player `id` without an account), name and rank, and catalog map fields; `id` is the site's result id when the claim has one, else fresh. `record` is a confirmed site record or a strict best on that map since the room started (kept across map changes), and `roomRecord: true` marks the latter; `previousBestUs` is then the old room record. Verified results carry `verified: true`, the site's points and promotion and the confirmed place; points add to the player's, and a promotion counts only to a higher rank, which becomes the player's. They go to everyone but the finisher, whose game already shows the site's own result. Unverified results carry `verified: false`, 0 points and no promotion, and go to everyone; guests strip their leaderboard fields and read an unverified record as a room record. Stage records are never sent. In community rooms native text says "New room record!" for `roomRecord` and "First completion." for unverified runs; sounds keep the native record/PB/completion priority.

Reliable native text travels as a one-byte ASCII `d` tag followed by the original text, without another JSON envelope. Extension transport controls remain JSON. The tag and UTF-8 payload together must fit within 65,536 bytes. Larger native JSON messages retain sequential `{type:"room-chunk",data,final}` frames, bounded to 4,000 source characters per chunk. An assembled message stays within 262,144 characters and 66 chunks; nested chunks are refused.

## Shared savelocs

Community rooms share practice saves, as community surf servers do; official rooms and offline play keep the game's local bank. The game's Save button and bind, and replay savelocs, submit to the host, and its confirmation brings the game's "Saved location #N" with the room-wide number. The game's own list shows every owner's saves newest first, labelled with the owner's name. Load picks your latest save, or the room's newest when you have none, unless you select another; Previous and Next walk the whole list. Loading runs the game's own restore with the receiver's own start position, so Restart behaves as after loading your own save.

The host gives each `browserId` an owner id for the room, so a reconnect keeps its saves and rate budget. Save ids increase across the room. Saves outlive their owner's connection until the map changes or the room closes; past 1,280 saves, a new one replaces the oldest save of a player who left, so present players' saves are never replaced by others'. Deleting another owner's save hides it for that connection only.

Snapshots are rebuilt from the game's practice schema, at most 32,768 UTF-8 bytes, sent with a `null` start position. Host and receivers check the map key, finite and bounded numbers (positions ±131072, velocities ±32767, yaw ±360, pitch ±89, elapsed 0–86,400 s), ordered splits and unfinished timers; malformed saves close with 4002. Stages, pending stage teleports, checkpoint counts, start regions and map outputs must exist in the loaded map; a save failing only these, as one from another map version does, is dropped by the host and left out of a receiver's list. The checks make a save safe to load, not proof that anyone reached it.

## Binary frames

Little-endian, version byte 1, ArrayBuffers (set `binaryType = "arraybuffer"` on every receiving socket; the default `blob` breaks the JSON/binary split). A frame whose epoch isn't the room's current one is dropped.

**Compact pose, 32 bytes**

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | uint32 | `time`, sender timestamp mod 2^32 |
| 4, 8, 12 | float32 | `x`, `y`, `z`, finite, \|v\| ≤ 131072 |
| 16, 18, 20 | int16 | `vx`, `vy`, `vz`, rounded, -32768 invalid |
| 22 | uint16 | `yaw`: `round(yaw mod 360 / 360 × 65535)` |
| 24 | int16 | `pitch`: `round(pitch / 90 × 32767)`, -32768 invalid |
| 26 | uint8 | flags 0–63: grounded 1, crouched 2, teleport 4, practice 8, idle 16, finished 32 |
| 27 | uint8 | reserved, 0 |
| 28 | float32 | `seconds`, timer, 0–86400 |

**Type 1, client pose batch** (44 or 76 bytes): version, type 1, sample count (1 or 2), reserved 0, uint32 sequence, uint32 epoch, then the poses. The game samples at most every 49 ms, usually sends pairs, and closes its socket with 4013 when more than 64 KB is buffered.

**Type 2, room snapshot** (4–4996 bytes): version, type 2, uint16 block count (0–64), then per block a 14-byte header (uint16 slot, uint32 sequence, uint32 epoch, uint8 sample count 1–2, uint8 and uint16 reserved 0) and its poses. Duplicate slots or trailing bytes are invalid. The host keeps each sender's latest upload and schedules a flush 50 ms after the first pending upload, excluding the recipient's own block. An upload also flushes a batch past its deadline: hidden tabs can delay timers to a second while data-channel events keep arriving. Empty periods send nothing. All other players fit in one snapshot. Pose bytes stay unchanged. Recipients with more than 64 KB buffered skip snapshots and spectator frames until they drain; snapshot assembly skips them before allocating or copying packets. Reliable controls remain available. The game keeps up to 12 samples per player, drops samples over 250 ms behind the newest, and extrapolates at most 100 ms.

**Types 3 and 4, spectator frames** (56 bytes; 3 uploaded, 4 forwarded):

| Offset | Type | Field |
| ---: | --- | --- |
| 0 | uint8 | version 1 |
| 1 | uint8 | 3 or 4 |
| 2 | uint16 | slot (0 from the sender; the host writes the sender's) |
| 4 | uint32 | spectator sequence, separate from pose sequences |
| 8 | uint32 | epoch |
| 12 | 32 bytes | compact pose |
| 44 | float32 | `eyeHeight`, 0–128 |
| 48 | uint8 | phase: 0 ready, 1 running, 2 finished |
| 49 | uint8 | `untimed`, 0 or 1 |
| 50, 52 | uint16 | `checkpoints`, `stage`, 0–1024 |
| 54 | uint8 | 0 = no inputs; else bit 7 set, bit 6 clear, low 6 bits held inputs (w 1, a 2, s 4, d 8, jump 16, duck 32) |
| 55 | uint8 | presses since the last frame, 0–63; 0 when byte 54 is 0 |

A player streams these at about 30 Hz while `spectator-demand` is active for them. The host rewrites only the type and slot and forwards each frame to that player's watchers alone. When a watcher leaves or switches, or the target leaves, demand counts are updated. A roster is scheduled only when a player's `spectating` flag changes, including watchers released when their target starts spectating; target switches alone do not alter roster fields. Redundant requests preserve the latest request id for a later unavailable-target error without generating demand or roster traffic.

The host validates spectator frames and drops wrong-epoch, duplicate and stale sequences, accepting forward uint32 wraparound independently of pose sequences. Per sender, fanout permits the native minimum interval of `1000/30 - 1` milliseconds plus an eight-frame jitter burst. Epoch and demand changes do not refill the bucket. This bounds outgoing amplification without reducing native-permitted cadence; it does not bound attacker ingress traffic or decoding work.

`estimateBandwidth` (`bandwidth.js`) estimates the host's upload and download in Mbps from these frame sizes, the 50 ms snapshot bundling, 30 Hz spectator streams and relay overhead; it is a guide for hosts, not a bound.

## Closing

The game treats 4002, 4004, 4008 and 4009 as final and shows the reason without retrying; other unexpected closes retry six times with backoff. Guests replace any close reason that isn't one of the extension's own texts with "This private room has closed." for 4004, "Invalid private room data" for 4002, and nothing otherwise. The private host uses 4002 for invalid data, 4004 when the room is gone, 4008 for full rooms, kicks and bans, and 4013 (which the game retries) for a player whose buffer stays above 8 MB for 5 seconds. The game itself closes with 4000 (no welcome within 10 s), 4013 (too much buffered), 4003 (session refresh) and 1000 (leaving).

The host's own game reads its room through the same rebuilding and checks as a guest's, except that its own player is the moderator. A replacement host loopback removes the old host connection without ending the room. Explicit Leave and `pagehide` close the room. When a guest's peer connection drops without a close message, the guest asks the meeting point: if the room is gone, it closes with 4004; otherwise it reconnects through the meeting point. When a guest's open connections to a room have closed more than 3 times within 30 seconds, the next attempt closes at once with 4004 "This private room has closed.", which stops the game's retries. Closing a guest's meeting point socket after negotiation doesn't affect its peer connection.

## Testing safely

Test as a guest, without finishing runs. Hosting needs a signed-in account; finish no runs with it either. The game prepares `guest-attempt` tickets on its own, even before a finish, so block the attempt, upload and claim endpoints before the first page load when testing in a browser.
