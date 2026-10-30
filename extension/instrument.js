import {nativeRoomHooks} from './native-room-hooks.js';
import {nativeSavelocHooks} from './native-saveloc-hooks.js';

export const ADAPTER_MARKER = '\n/* surfd-qol-adapter-v20:';
export const isCurrentInstrumented = source => source.includes(ADAPTER_MARKER);

const identifier = '[A-Za-z_$][\\w$]*';
// Copies of MAX_ROOM_MESSAGE_CHARS and MAX_ROOM_CHUNKS in src/private-rooms/protocol.js, which extension/ cannot import.
export const ROOM_MESSAGE_CHARS = 262144, ROOM_CHUNKS = 66;
// A captured identifier, matched literally inside another pattern.
const literal = name => name.replace(/\$/g, () => '\\$');

function unique(source, pattern, label) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Unsupported Surfd build: ${label} (${matches.length} matches)`);
  return matches[0];
}

// Replay hooks are optional: when the game's watch function or its replay
// player can't be found, Watch is unavailable and nothing else changes.
// Surfd's own player (the transport behind its replay bar) does playback,
// seeking, speed and the timeline; the extension drives it and adds to it.
function replayHooks(source) {
  try {
    const watch = unique(source, new RegExp(`async function (${identifier})\\((${identifier}),(${identifier}),(${identifier}),(${identifier})=\\+\\+(${identifier})\\)\\{if\\(!\\3\\(\\)\\)return;`, 'g'), 'replay watch');
    // The game's own debug snapshot reads the player: replay:<player>.snapshot().
    const transport = unique(source, new RegExp(`replay:(${identifier})\\.snapshot\\(\\)`, 'g'), 'replay player')[1];
    return `
    replay: {
      reserve: () => ++${watch[6]},
      isCurrent: token => token === ${watch[6]},
      watch: (replay, label, isCurrent, token) => ${watch[1]}(replay, isCurrent, label, token),
      transport: () => ${transport},
      // What's playing and where: index counts the commands played.
      playback: () => ({replay: ${transport}.replay ?? null, index: ${transport}.replay ? ${transport}.host.position() : 0}),
    },`;
  } catch (error) {
    console.warn('[Surfd QoL] Replay controls unavailable:', error.message);
    return '';
  }
}

// The game's practice savelocs, also optional: moments saved while watching
// a replay are filed into them when you leave it.
function practiceHooks(source, sessionClass, state) {
  try {
    const store = unique(source, new RegExp(`const ${identifier}=(${identifier})\\.entries\\((${identifier})\\)\\.length>=${identifier},${identifier}=\\1\\.save\\(\\2\\)`, 'g'), 'saveloc store')[1];
    // Use the same map, rules and replay format as native Restart. A replay
    // session can remain alive after Exit with an older format/rules bank.
    const fresh = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const ${identifier}=new ${sessionClass}\\(\\2,(${identifier})\\(\\2\\),(${identifier})\\),`, 'g'), 'live session factory');
    const maps = [...new Set([...source.matchAll(new RegExp(`${fresh[1]}\\((${identifier})\\?\\?${state}\\.map\\)`, 'g'))].map(match => match[1]))];
    if (maps.length !== 1) throw new Error('Unsupported Surfd build: practice destination map');
    // The start position the factory applies: yours if you set one, else none.
    let loadStart = null;
    try {
      const factory = new RegExp(`function ${literal(fresh[1])}\\((${identifier})\\)\\{const (${identifier})=new ${literal(sessionClass)}\\(\\1,${literal(fresh[3])}\\(\\1\\),${literal(fresh[4])}\\),(${identifier})=(${identifier})\\(\\1\\);return \\3&&\\2\\.setStartPosition\\(\\3\\)`, 'g');
      loadStart = unique(source, factory, 'start position loader')[4];
    } catch (error) {
      console.warn('[Surfd QoL] Savelocs from replays keep the replay’s start position:', error.message);
    }
    let shared = {source, setup: '', adapter: ''};
    try { shared = nativeSavelocHooks(source, store); }
    catch (error) { console.warn('[Surfd QoL] Shared practice savelocs unavailable:', error.message); }
    return {...shared, adapter: `
    practice: {
      // The saveloc store: one bank of snapshots per practice key (map and movement rules).
      store: () => ${store},
      destination: () => {
        const map = ${maps[0]} ?? ${state}?.map;
        if (!map) return null;
        // practiceKey is native's pure metadata key, not a synthetic Session.
        const key = ${sessionClass}.prototype.practiceKey.call({map, config: ${fresh[3]}(map), replayFormat: ${fresh[4]}});
        return {map, mapId: map.id, mapVersion: map.version, key${loadStart ? `, startPosition: ${loadStart}(map) ?? null` : ''}};
      },${shared.adapter}
    },`};
  } catch (error) {
    console.warn('[Surfd QoL] Practice savelocs from replays unavailable:', error.message);
    return {source, setup: '', adapter: ''};
  }
}
// The game's own notice line (where "Saved location #1" appears), optional.
function noticeHook(source) {
  try {
    const notice = unique(source, new RegExp(`\\{(${identifier})\\("Return to play before saving a location\\."\\);return\\}`, 'g'), 'notice')[1];
    return `
    notice: text => ${notice}(text),`;
  } catch (error) {
    console.warn('[Surfd QoL] Game notices unavailable:', error.message);
    return '';
  }
}

// Directory rosters are host claims, not verified rank or friend information.
// Keep the native official renderer intact and use only public community fields.
function roomRosterHooks(body, options) {
  const roster = unique(body, new RegExp(`(${identifier})=\\[\\.\\.\\.(${identifier})\\.roster\\?\\?\\[\\]\\]\\.sort\\(\\((${identifier}),(${identifier})\\)=>Number\\((${identifier})\\.has\\(\\4\\.name\\)\\)-Number\\(\\5\\.has\\(\\3\\.name\\)\\)\\|\\|\\4\\.points-\\3\\.points\\)`, 'g'), 'browser roster order');
  const row = roster[2], players = roster[1];
  const render = unique(body, new RegExp(`${literal(players)}\\.map\\((${identifier})=>\`([\\s\\S]*?)\`\\)\\.join\\(""\\)`, 'g'), 'browser roster rows');
  const escape = unique(render[2], new RegExp(`\\$\\{(${identifier})\\(${literal(render[1])}\\.name\\)\\}`, 'g'), 'browser roster name escaping')[1];
  const rank = unique(render[2], new RegExp(`class="rank-name \\$\\{(${identifier})\\(${literal(render[1])}\\.guest\\?"Guest":${literal(render[1])}\\.rank\\)\\}`, 'g'), 'browser guest style')[1];
  const empty = unique(body, new RegExp(`const (${identifier})=(${identifier})\\("p.empty",(${identifier})\\);`, 'g'), 'browser roster container');
  body = body.replace(roster[0], () => `${players}=__qolCommunity(${row})?(${row}.roster??[]):${roster[0].slice(players.length + 1)}`);
  body = body.replace(render[0], () => `(__qolCommunity(${row})?${players}.map(__qolRosterPlayer).join(""):${render[0]})`);
  // Bind after each native render so reused DOM cannot keep an old room's action.
  body = body.replace(empty[0], () => `${empty[2]}("tbody",${empty[3]}).onclick=__qolCommunity(${row})?event=>{const button=event.target.closest("button[data-qol-user]");if(button)${options}.__qolProfile(button.dataset.qolUser,button.dataset.qolName)}:null;${empty[0]}`);
  return {body, helpers: `
    const __qolPublicUser=player=>player.guest===false&&typeof player.userId==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(player.userId);
    function __qolRosterPlayer(player){
      const name=${escape}(player.name),who=__qolPublicUser(player)?'<button type="button" class="who" data-qol-user="'+player.userId+'" data-qol-name="'+name+'">'+name+'</button>':'<span class="who">'+name+'</span>';
      return '<tr><td>'+who+'</td><td class="c-min">'+(player.guest?'<span class="rank-name '+${rank}("Guest")+'">Guest</span>':'')+'</td><td></td></tr>';
    }
  `};
}

function roomBrowserHooks(source, hook) {
  const start = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{let (${identifier})=\\[\\],(${identifier})="Checking servers…"`, 'g'), 'server browser');
  const end = unique(source.slice(start.index), new RegExp(`mapTitle:(${identifier})\\}\\}`, 'g'), 'server browser end');
  let body = source.slice(start.index, start.index + end.index + end[0].length);
  const replace = (pattern, replacement, label) => {
    const match = unique(body, pattern, label);
    body = body.replace(match[0], () => typeof replacement === 'function' ? replacement(match) : replacement);
    return match;
  };
  const joins = replace(new RegExp(`(${identifier})=(${identifier})=>\\2\\.online&&!\\2\\.preview&&\\2\\.players<\\2\\.capacity`, 'g'),
    m => `${m[1]}=${m[2]}=>${m[2]}.online&&!${m[2]}.preview&&(__qolCommunity(${m[2]})||${m[2]}.players<${m[2]}.capacity)`, 'server eligibility');
  replace(new RegExp(`${literal(start[3])}\\.filter\\(${literal(joins[1])}\\)`, 'g'),
    `${start[3]}.filter(row=>!__qolCommunity(row)&&${joins[1]}(row))`, 'official recommendation');
  replace(new RegExp(`\\(!(${identifier})\\|\\|(${identifier})\\.players<\\2\\.capacity\\)&&\\(!(${identifier})\\|\\|\\2\\.players>0\\)`, 'g'),
    m => `(__qolCommunity(${m[2]})||!${m[1]}||${m[2]}.players<${m[2]}.capacity)&&(!${m[3]}||${m[2]}.players>0)`, 'community filters');
  body = body.replace(new RegExp(`(?<![\\w$.])(${identifier})\\.region`, 'g'), (_, name) => `__qolRegion(${name})`);
  replace(new RegExp(`Number\\((${identifier})\\.online\\)-Number\\((${identifier})\\.online\\)\\|\\|`, 'g'),
    m => `Number(__qolCommunity(${m[2]}))-Number(__qolCommunity(${m[1]}))||Number(${m[1]}.online)-Number(${m[2]}.online)||`, 'official row order');
  replace(new RegExp(`\\.sort\\(\\((${identifier}),(${identifier})\\)=>\\((${identifier})\\(\\1\\[1\\]\\[0\\]\\)\\?\\?9999\\)-\\(\\3\\(\\2\\[1\\]\\[0\\]\\)\\?\\?9999\\)\\)`, 'g'),
    m => `.sort((${m[1]},${m[2]})=>Number(${m[1]}[0]==="Community")-Number(${m[2]}[0]==="Community")||(${m[3]}(${m[1]}[1][0])??9999)-(${m[3]}(${m[2]}[1][0])??9999))`, 'official group order');
  const tabs = unique(body, new RegExp(`(${identifier})\\.hidden=(${identifier})\\.length<2,\\1\\.innerHTML=\\2\\.length<2\\?"":`, 'g'), 'community tab visibility');
  body = body.replace(tabs[0], () => `${tabs[1]}.hidden=${tabs[2]}.length<2&&!${tabs[2]}.includes("Community"),${tabs[1]}.innerHTML=${tabs[2]}.length<2&&!${tabs[2]}.includes("Community")?"":`);
  replace(new RegExp('`Join \\$\\{(' + identifier + ')\\((' + identifier + ')\\.id\\)\\}`', 'g'),
    m => '`Join ${__qolCommunity(' + m[2] + ')?' + m[2] + '.name:' + m[1] + '(' + m[2] + '.id)}`', 'community join label');
  const render = unique(body, new RegExp(`for\\(const (${identifier}) of ${identifier}\\("\\[data-region\\]",${identifier}\\)\\)\\1\\.onclick=\\(\\)=>\\{(${identifier})=\\1\\.dataset\\.region,(${identifier})\\(\\)\\}`, 'g'), 'region selection');
  const selected = unique(body, new RegExp(`typeof (${identifier})=="string"&&\\((${identifier})=\\1\\)`, 'g'), 'selected server');
  const view = replace(new RegExp(`return\\{view:(${identifier}),update\\(`, 'g'),
    m => `return{view:${m[1]},status:()=>${start[4]},selected:()=>${selected[2]},selectRoom:id=>{${selected[2]}=id;${render[2]}="all";${render[3]}()},update(`, 'browser adapter')[1];
  replace(new RegExp(`open\\((${identifier})\\)\\{typeof \\1=="string"`, 'g'),
    m => `open(${m[1]}){${hook}?.browserVisibility?.(!${view}.el.hidden);typeof ${m[1]}=="string"`, 'browser open lifecycle');
  replace(new RegExp(`close\\(\\)\\{clearInterval\\((${identifier})\\)\\}`, 'g'),
    m => `close(){clearInterval(${m[1]});queueMicrotask(()=>${hook}?.browserVisibility?.(!${view}.el.hidden))}`, 'browser close lifecycle');
  body = body.replaceAll(`${start[2]}.refresh()`, () => `(${hook}?.refreshDirectory({open:!${view}.el.hidden}),${start[2]}.refresh())`);
  const roster = roomRosterHooks(body, start[2]);
  body = roster.body.replace(start[0], () => start[0].replace('{let ', () => '{const __qolCommunity=row=>/^p-[a-z0-9]{12}$/.test(row.id),__qolRegion=row=>__qolCommunity(row)?"Community":row.region;' + roster.helpers + 'let '));
  source = source.slice(0, start.index) + body + source.slice(start.index + end.index + end[0].length);
  // The ordinary profile callback also resolves friends by display name. Open
  // directly by the advertised UUID instead, never by a possibly spoofed name.
  const window = unique(source, new RegExp(`(${identifier})\\.setOpenHandler\\(\\(\\)=>(${identifier})\\.open\\("servers"\\)\\)`, 'g'), 'browser profile window')[2];
  const create = unique(source, new RegExp(`${literal(start[1])}\\(\\{`, 'g'), 'browser creation');
  return source.replace(create[0], () => `${create[0]}__qolProfile:(userId,name)=>${window}.open("profile",{userId,name}),`);
}

// Optional parts of the host's room UI, each on its own: the game's map change
// dialog for choosing a room's starting map, its Leave and map change, and the
// host's Your room button in the room menu.
function roomUiHooks(source, hook) {
  const adapter = [];
  const optional = (label, apply) => {
    try { apply(); } catch (error) { console.warn(`[Surfd QoL] ${label} unavailable:`, error.message); }
  };
  optional('Room map choice', () => {
    const picker = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const (${identifier})=document\\.createElement\\("dialog"\\);\\3\\.className="nominate-window map-change-window"`, 'g'), 'map change dialog')[1];
    // The factory appends its dialog to the page before it returns.
    adapter.push(`
      mapPicker: options => { const picker = ${picker}(options); return {open: picker.open, state: picker.state, close: picker.close, dialog: document.body.lastElementChild}; },`);
  });
  optional('Room leave and map change', () => {
    const leave = unique(source, new RegExp(`leave:\\(\\)=>\\{(${identifier})\\?\\.roomId\\(\\)&&\\1\\.leave\\(\\),(${identifier})\\(\\)\\}`, 'g'), 'room leave');
    adapter.push(`
      leaveRoom: () => { ${leave[1]}?.roomId() && ${leave[1]}.leave(); ${leave[2]}(); },
      changeMap: () => ${leave[1]}?.roomView?.changeMap?.(),`);
  });
  optional('Your room menu button', () => {
    const menu = unique(source, new RegExp(`(${identifier})\\.innerHTML=\`\\$\\{(${identifier})\\.guest\\(\\)\\?'<button type="button" class="btn" data-act="signin" `, 'g'), 'room menu');
    const click = unique(source, new RegExp(`\\{const (${identifier})=(${identifier})\\.dataset\\.act;if\\(\\1==="chat"&&`, 'g'), 'room menu actions');
    // The menu is rebuilt when the player connects, by which time the host's own room is known.
    source = source.replace(menu[0], () => `${menu[1]}.innerHTML=\`\${${hook}?.ownRoom?.()?'<button type="button" class="btn" data-act="qol-room">Your room</button>':""}\${${menu[2]}.guest()?'<button type="button" class="btn" data-act="signin" `);
    source = source.replace(click[0], () => `{const ${click[1]}=${click[2]}.dataset.act;if(${click[1]}==="qol-room"){${hook}?.openRoom?.();return}if(${click[1]}==="chat"&&`);
  });
  return {source, adapter: adapter.join('')};
}

// Room transport hooks are one optional unit: a partial match must never send
// a private identifier to the site's ticket, ping or WebSocket endpoints.
function roomHooks(source, client, state) {
  const original = source;
  try {
    const list = unique(source, new RegExp(`async list\\(\\)\\{const (${identifier})=await fetch\\(this\\.baseUrl\\+"/servers",\\{signal:AbortSignal\\.timeout\\(8e3\\),cache:"no-store"\\}\\);if\\(!\\1\\.ok\\)throw Error\\("Servers unavailable"\\);const (${identifier})=await \\1\\.json\\(\\);if\\(!Array\\.isArray\\(\\2\\.servers\\)\\)throw Error\\("Invalid server list"\\);return \\2\\.servers\\}`, 'g'), 'room list');
    const measure = unique(source, new RegExp(`async measure\\((${identifier})\\)\\{const (${identifier})=performance\\.now\\(\\);if\\(!\\(await fetch\\(this\\.baseUrl\\+"/servers/"\\+\\1\\+"/ping"`, 'g'), 'room ping');
    const socket = unique(source, new RegExp(`new WebSocket\\((${identifier}),\\["surfd-v1",(${identifier})\\]\\)`, 'g'), 'room socket');
    const tickets = [...source.matchAll(/await this\.ticket\(\)/g)];
    if (tickets.length !== 2) throw new Error(`Unsupported Surfd build: room tickets (${tickets.length} matches)`);
    const bind = unique(source, new RegExp(`bindServers\\((${identifier}),(${identifier})\\)\\{(${identifier})=\\1,(${identifier})=\\2,\\2\\(\\)\\}`, 'g'), 'room join callback');
    const lobby = unique(source, new RegExp(`(${identifier})\\.bindServers\\(`, 'g'), 'room lobby')[1];
    const maps = unique(source, new RegExp(`refreshTop10\\(\\)\\{${identifier}\\.refresh\\((${identifier})\\.find\\((${identifier})=>\\2\\.id===${identifier}\\.currentMap\\(\\)\\)\\?\\?null\\)\\}`, 'g'), 'room maps')[1];
    const countdown = unique(source, new RegExp(`function (${identifier})\\((${identifier}),(${identifier})\\)\\{const (${identifier})=(${identifier})\\(\\2,\\3\\);return \\4===0\\?"Changing map…":`, 'g'), 'room countdown')[1];
    const clocks = new RegExp(`${literal(countdown)}\\((${identifier}(?:\\.state)?)\\.endsAt,Date\\.now\\(\\)(?:\\+${identifier})?\\)`, 'g');
    const clockCount = [...source.matchAll(clocks)].length;
    if (clockCount !== 4) throw new Error(`Unsupported Surfd build: room countdown views (${clockCount} matches)`);
    const hook = 'globalThis.__SURFD_QOL__?.privateRooms';
    // In private rooms View profile needs the account id the player sent, and Block stays hidden:
    // the room can't confirm who a player is, so a block could land on someone else's account.
    const profile = unique(source, new RegExp(`(${identifier})==="profile"&&(${identifier})\\.profile\\((${identifier})\\.id,\\3\\.name\\)`, 'g'), 'player profile');
    const block = unique(source, new RegExp(`\\$\\{!(${identifier})\\.guest&&(${identifier})\\.available&&\\2\\.block\\?`, 'g'), 'player block');
    const account = unique(source, new RegExp(`onSignIn:\\(\\)=>(${identifier})\\.openAccount\\(\\)`, 'g'), 'sign in')[1];
    const toast = unique(source, new RegExp(`(${identifier})\\("toast"\\)\\.textContent=(${identifier}),\\1\\("toast"\\)\\.classList\\.add\\("show"\\),(${identifier})=performance\\.now\\(\\)\\+5e3`, 'g'), 'room notice');
    source = roomBrowserHooks(source, hook);
    source = source.replace(profile[0], () => `${profile[1]}==="profile"&&${profile[2]}.profile(${profile[3]}.userId??${profile[3]}.id,${profile[3]}.name)`);
    source = source.replace(block[0], () => '${!' + block[1] + '.guest&&!/^private-/.test(' + block[1] + '.id)&&' + block[2] + '.available&&' + block[2] + '.block?');
    const leave = unique(source, new RegExp(`function (${identifier})\\(\\)\\{(${identifier})\\?\\.disconnect\\(\\),(${identifier})=null,`, 'g'), 'explicit room leave');
    const receive = unique(source, new RegExp(`receive\\((${identifier})\\)\\{if\\(\\1==="pong"\\)`, 'g'), 'room receiver');
    const decode = unique(source, new RegExp(`if\\(typeof (${identifier})!="string"\\|\\|\\1\\.length>65536\\)throw Error\\("Invalid room data"\\);const (${identifier})=JSON\\.parse\\(\\1\\);`, 'g'), 'room JSON decoder');
    source = source.replace(leave[0], () => leave[0].replace('{', () => `{${hook}?.leave(${leave[2]}?.roomId);`));
    source = source.replace(receive[0], () => receive[0].replace('){', () => ',__qolAssembled=false){'));
    source = source.replace(decode[0], () => `if(typeof ${decode[1]}!="string"||${decode[1]}.length>(__qolAssembled&&/^p-[a-z0-9]{12}$/.test(this.roomId)?${ROOM_MESSAGE_CHARS}:65536)){this.__qolChunks=null;throw Error("Invalid room data")}const ${decode[2]}=JSON.parse(${decode[1]});if(${decode[2]}.type==="room-chunk"&&/^p-[a-z0-9]{12}$/.test(this.roomId)){if(__qolAssembled||typeof ${decode[2]}.data!=="string"||typeof ${decode[2]}.final!=="boolean"){this.__qolChunks=null;throw Error("Invalid room chunk")}const chunks=this.__qolChunks??={parts:[],length:0};if(chunks.parts.length>=${ROOM_CHUNKS}||chunks.length+${decode[2]}.data.length>${ROOM_MESSAGE_CHARS}){this.__qolChunks=null;throw Error("Invalid room chunk")}chunks.parts.push(${decode[2]}.data);chunks.length+=${decode[2]}.data.length;if(${decode[2]}.final){this.__qolChunks=null;this.receive(chunks.parts.join(""),true)}return}if(this.__qolChunks){this.__qolChunks=null;throw Error("Invalid room chunk")}`);
    const disconnect = unique(source, /disconnect\(\)\{this\.watchTarget=null/g, 'room disconnect');
    source = source.replace(disconnect[0], () => 'disconnect(){this.__qolChunks=null;this.watchTarget=null');
    const listBody = list[0].slice('async list(){'.length, -1).replace(`return ${list[2]}.servers`, () => `return ${hook}?.mergeRooms(${list[2]}.servers)??${list[2]}.servers`);
    source = source.replace(list[0], () => `async list(){${hook}?.refreshDirectory?.();try{${listBody}}catch(error){const rows=${hook}?.mergeRooms([]);if(rows?.length)return rows;throw error}}`);
    source = source.replace(measure[0], () => measure[0].replace('{const ', () => `{const privatePing=${hook}?.measure(${measure[1]});if(privatePing!=null)return privatePing;const `));
    source = source.replace(socket[0], () => `(this.__qolChunks=null,${hook}?.roomSocket(this.roomId)??${socket[0]})`);
    source = source.replace(/await this\.ticket\(\)/g, () => `(${hook}?.ticket(this.roomId)??await this.ticket())`);
    source = source.replace(bind[0], () => `${bind[0]},joinServer(id){return ${bind[3]}(id)},refreshServers(){return ${bind[4]}()}`);
    source = source.replace(clocks, (call, room) => `(${room}.untimed===true?"No time limit":${call})`);
    const native = nativeRoomHooks(source, hook, lobby);
    source = native.source;
    const ui = roomUiHooks(source, hook);
    source = ui.source;
    let ranks = '';
    try {
      const table = unique(source, new RegExp(`const (${identifier})=\\[\\{points:0,title:"Unranked"\\}`, 'g'), 'rank table')[1];
      ranks = `
      ranks: () => ${table},`;
    } catch (error) {
      console.warn('[Surfd QoL] Rank table unavailable:', error.message);
    }
    return {source, adapter: `
    rooms: {${ui.adapter}${ranks}
      // The server browser's own status line, kept until the game lists servers again.
      setStatus: text => ${lobby}.updateServers(${lobby}.servers.rows().map(({serverTime,...row})=>row), text),
      openBrowser: () => ${lobby}.tab?.("servers"),
      // The HUD is hidden while the menu is open.
      notice: text => {${toast[1]}("menu-status").textContent=text;${toast[1]}("toast").textContent=text;${toast[1]}("toast").classList.add("show");${toast[3]}=performance.now()+5e3},
      join: id => ${lobby}.joinServer(id),
      rows: () => ${lobby}.servers.rows(),
      update: rows => ${lobby}.updateServers(rows.map(({serverTime,...row})=>row), ${lobby}.servers.status()),
      status: () => ${lobby}.servers.status(),
      browserOpen: () => !${lobby}.servers.view.el.hidden,${native.adapter}
      root: () => ${lobby}.servers.view.el,
      refresh: () => {${hook}?.refreshDirectory({open:!${lobby}.servers.view.el.hidden});return ${lobby}.refreshServers()},
      select: id => ${lobby}.servers.selectRoom(id),
      selected: () => ${lobby}.servers.selected(),
      displayName: () => ${client}.session ? ${client}.profile?.username ?? ${hook}?.guestName?.() ?? "Guest" : ${hook}?.guestName?.() ?? "Guest",
      appearance: () => ${client}.profile?.appearance ?? null,
      guest: () => !${client}.session,
      userId: () => ${client}.session?.user?.id ?? null,
      // The signed-in player's rank and points as the game's own profile shows them.
      profile: () => { const me = ${lobby}.me?.get?.(); return me?.kind === "member" && me.userId === ${client}.session?.user?.id ? {rank: me.rank, points: me.points} : null; },
      onAccountChange: listener => ${client}.onChange?.(listener) ?? (() => {}),
      signIn: () => ${account}.openAccount(),
      maps: () => ${maps},
      currentMap: () => ${state}?.map ?? ${lobby}.selected(),
      boardId: mapId => (${client}.config.maps.find(map => map.id === mapId && !map.archived) ?? ${client}.config.maps.find(map => map.id === mapId))?.boardId ?? null,
      // Every answer the site gives about a submitted run, as listener(attemptId, submission), until stopped.
      onVerdict: __qolListener => {
        const __qolClient = ${client}, __qolRestore = [];
        for (const name of ["submit", "submission"]) {
          const original = __qolClient[name], own = Object.hasOwn(__qolClient, name);
          if (typeof original !== "function") continue;
          const wrapper = function (id, ...rest) {
            const reply = original.call(this, id, ...rest);
            Promise.resolve(reply).then(value => __qolListener(id, value), () => {});
            return reply;
          };
          __qolClient[name] = wrapper;
          __qolRestore.push(() => { if (__qolClient[name] === wrapper) own ? __qolClient[name] = original : delete __qolClient[name]; });
        }
        return () => { for (const undo of __qolRestore.splice(0)) undo(); };
      },
    },`};
  } catch (error) {
    console.warn('[Surfd QoL] Private rooms unavailable:', error.message);
    return {source: original, adapter: ''};
  }
}

function previewViewHook(source, input) {
  try {
    unique(source, new RegExp(`setView\\((${identifier})\\)\\{this\\.yaw=\\1\\.yaw,this\\.pitch=Math\\.max\\(-89,Math\\.min\\(89,\\1\\.pitch\\)\\)\\}`, 'g'), 'camera view setter');
    return `
    previewView: {
      get: () => ({yaw: ${input}.yaw, pitch: ${input}.pitch}),
      set: view => ${input}.setView(view),
    },`;
  } catch (error) {
    console.warn('[Surfd QoL] Strafe preview unavailable:', error.message);
    return '';
  }
}

// Compare's cinematic view, optional. The map renderer is a plain object the
// game calls once per frame with a view (eye, yaw, pitch, ghost): it also
// exposes its scene, camera and the record ghost's factory, so two ghosts can
// share the game's own ghost look. The extension wraps render() only while the
// view is open; the frame's interpolation is passed along for smooth ghosts.
function cinemaHooks(source) {
  try {
    const factory = unique(source, new RegExp(`function (${identifier})\\((${identifier})\\)\\{const (${identifier})=new ${identifier};\\3\\.name="record-ghost"`, 'g'), 'record ghost')[1];
    const scene = unique(source, new RegExp(`(${identifier})=${literal(factory)}\\((${identifier})\\)`, 'g'), 'record ghost scene')[2];
    const camera = unique(source, new RegExp(`\\.fov!==${identifier}&&\\((${identifier})\\.fov=2\\*Math\\.atan`, 'g'), 'map camera')[1];
    const object = unique(source, new RegExp(`(${identifier})=\\{resize:(${identifier}),setQuality:`, 'g'), 'map renderer');
    const call = unique(source, new RegExp(`(${identifier})\\.render\\(\\{state:${identifier},eyePosition:`, 'g'), 'frame render')[1];
    const ghost = unique(source, new RegExp(`ghost:(${identifier})\\|\\|(${identifier})\\?null:(${identifier})\\.frame\\((${identifier}),(${identifier})\\)\\}\\)`, 'g'), 'frame interpolation');
    source = source.replace(object[0], () => `${object[1]}={qolScene:${scene},qolCamera:${camera},qolGhost:()=>${factory}(${scene}),resize:${object[2]},setQuality:`);
    source = source.replace(ghost[0], () => `${ghost[0].slice(0, -2)},qolAlpha:${ghost[5]}})`);
    return {source, adapter: `
    cinema: {
      renderer: () => ${call} ?? null,
    },`};
  } catch (error) {
    console.warn('[Surfd QoL] Compare view unavailable:', error.message);
    return {source, adapter: ''};
  }
}

// Append access to existing lexical objects; no original movement statement is rewritten.
// Fail open when the private game layout changes instead of guessing at another class.
export function instrumentGame(source) {
  const injected = source.indexOf('\n/* surfd-qol-adapter-v');
  if (injected >= 0) {
    if (isCurrentInstrumented(source)) return source;
    throw new Error('Stale Surfd QoL adapter');
  }
  const state = unique(source, new RegExp(`state:(${identifier})\\?\\.state,run:\\1\\?\\.timer\\.state`, 'g'), 'session snapshot')[1];
  const viewed = unique(source, new RegExp(`spectator:\\{target:(${identifier}),view:(${identifier})\\}`, 'g'), 'spectator view');
  const marker = unique(source, /checkpointSpeeds=\[\];startJumps=0/g, 'session fields').index;
  const classes = [...source.slice(0, marker).matchAll(new RegExp(`class (${identifier})\\{`, 'g'))];
  const sessionClass = classes.at(-1)?.[1];
  if (!sessionClass) throw new Error('Unsupported Surfd build: Session class');
  const body = source.slice(classes.at(-1).index, marker);
  const movementClass = unique(body, new RegExp(`this\\.movement=new (${identifier})\\(`, 'g'), 'movement class')[1];
  if (!body.includes('this.timer=') || !body.includes('this.map=')) throw new Error('Unsupported Surfd build: Session contract');
  const binding = unique(source, new RegExp(`(${identifier})\\.setBindings\\((${identifier})\\.bindings\\)`, 'g'), 'native input');
  const references = unique(source, new RegExp(`const (${identifier})=(${identifier})\\.current\\?\\.entries\\.find\\((${identifier})=>\\3\\.rank===1\\);(${identifier})\\.prepare\\(([^;]{1,200}?),\\(\\)=>(${identifier})\\.replay\\(\\1\\.runId\\)\\)`, 'g'), 'leaderboard references');
  const boardStore = references[2];
  const client = references[6];
  if (!source.includes(`${client}.board(${state}.map)`)) throw new Error('Unsupported Surfd build: board lookup');
  const rooms = roomHooks(source, client, state);
  source = rooms.source;
  const practice = practiceHooks(source, sessionClass, state);
  source = practice.source;
  const cinema = cinemaHooks(source);
  source = cinema.source;
  return source + `${ADAPTER_MARKER} native community rooms and optional room transport */
${practice.setup}
;(() => {
  const qol = globalThis.__SURFD_QOL__;
  if (!qol) return;
  const viewed = {target: null, view: null};
  qol.attach({
    Session: ${sessionClass}, Movement: ${movementClass},
    getSession: () => ${state},
    getView: () => { viewed.target = ${viewed[1]}; viewed.view = ${viewed[2]}; return viewed; },
    getInput: () => ${binding[1]},
    getBindings: () => ${binding[2]}.bindings,
    setInputBindings: bindings => ${binding[1]}.setBindings(bindings),${previewViewHook(source, binding[1])}${replayHooks(source)}${practice.adapter}${noticeHook(source)}${cinema.adapter}${rooms.adapter}
    getReferences: () => {
      const session = ${state};
      if (!session) return null;
      const board = ${client}.board(session.map);
      const ownerKey = ${client}.session?.user.id ?? 'guest';
      const key = board ? board.boardId + ':' + ownerKey : '';
      const current = ${boardStore}.current;
      const refs = board && ${boardStore}.key === key && current?.boardId === board.boardId ? current : null;
      const mapInfo = ${client}.config.maps.find(entry => entry.id === session.map.id);
      const recordSlug = mapInfo?.slug ?? session.map.slug;
      const record = refs?.entries?.find(entry => entry.rank === 1) ?? null;
      return {ownerKey, boardId: board?.boardId ?? null, own: refs?.own ?? null, record, entries: refs?.entries ?? [], mapName: mapInfo?.title ?? (mapInfo?.slug ? String(mapInfo.slug).split(/[-_]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : mapInfo?.name) ?? null,
        loadReplay: runId => ${client}.replay(runId),
        loadRecordRoute: () => recordSlug ? fetch('/replays/' + encodeURIComponent(recordSlug) + '-complete.json', {signal: AbortSignal.timeout(3e4)}).then(response => response.ok ? response.json() : null) : Promise.resolve(null)};
    }
  });
})();
`;
}
