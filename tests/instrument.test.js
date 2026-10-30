import {describe, expect, test} from 'bun:test';
import {ADAPTER_MARKER, ROOM_CHUNKS, ROOM_MESSAGE_CHARS, instrumentGame, isCurrentInstrumented} from '../extension/instrument.js';
import {MAX_ROOM_CHUNKS, MAX_ROOM_MESSAGE_CHARS} from '../src/private-rooms/protocol.js';
import {createSharedSavelocs} from '../src/private-rooms/shared-savelocs.js';

const nativePracticePanelSource = `
function fixturePanel(n,e,document){const save=document.getElementById("save"),count={};
  return {refresh(){const rows=n.entries(e());for(const row of rows){const option={};option.textContent=\`#\${row.id} · CP \${row.checkpoints} · \${row.time}\`}count.textContent=\`\${rows.length} / \${limit}\`}};
}
const fixtureSelector=fixturePanel(bank,()=>nativeSession,{getElementById:()=>({})});
`;

// The private names are deliberately unrelated to the live bundle's names.
// This miniature native module keeps the signatures used by instrumentation
// and the game's pre-download generation / guarded startup behavior.
const nativeSource = `
let sessions=0;
class Movement {}
class Session{
  constructor(map={id:'map',version:1},config={rule:'legacy'},format=1) {
    sessions++; this.movement=new Movement(); this.timer={state:{}}; this.map=map; this.config=config; this.replayFormat=format;
  }
  checkpointSpeeds=[];startJumps=0;startPosition=null;
  practiceKey() { return JSON.stringify([this.map.id,this.map.version,this.config.rule,this.replayFormat]); }
  setStartPosition(start) { this.startPosition=start; return start; }
}
// Surfd's replay player: what plays and where.
const player={replay:null,position:0,host:{position:()=>player.position},open(data){player.replay=data;player.position=0;},snapshot(){return {open:!!player.replay};}};
let nativeSession=new Session(),generation=0,target=null,view=null;
let startup=()=>Promise.resolve();
const input={yaw: 0, pitch: 0, setView(e){this.yaw=e.yaw,this.pitch=Math.max(-89,Math.min(89,e.pitch))},setBindings(){}},settings={bindings:{}};
input.setBindings(settings.bindings);
const currentFormat=8,liveRules=map=>({rule:settings.rule??'current'});
let replayMap=null;
let starts={};
function storedStart(map){return starts[map.id+':'+map.version]??null}
function fresh(map){const session=new Session(map,liveRules(map),currentFormat),saved=storedStart(map);return saved&&session.setStartPosition(saved),session;}
function restart(){nativeSession=fresh(replayMap??nativeSession.map);replayMap=null;return nativeSession;}
const client={session:{user:{id:'account-a'}},listeners:new Set(),onChange(listener){client.listeners.add(listener);return()=>client.listeners.delete(listener)},config:{maps:[{id:'map',slug:'test-map'}]},
  board:()=>({boardId:'board'}),replay:async()=>null};
const boards={key:'board:account-a',current:{boardId:'board',own:{runId:'pb-a'},entries:[]}};
const route={prepare(){}},bank={entries:()=>[],save(){}},limit=20;
function references() { const record=boards.current?.entries.find(entry=>entry.rank===1);route.prepare('map',()=>client.replay(record.runId)); }
function lookup() { return client.board(nativeSession.map); }
function snapshot() { return {state:nativeSession?.state,run:nativeSession?.timer.state,replay:player.snapshot(),spectator:{target:target,view:view}}; }
function save() { const full=bank.entries(nativeSession).length>=limit,result=bank.save(nativeSession); }
function notify() {}
function saveNotice() { if(false){notify("Return to play before saving a location.");return} }
async function watch(data,current,label,token=++generation){if(!current())return;
  await startup();
  if(token!==generation||!current())return;
  nativeSession=new Session();player.open(data);
}
function nativeWatch(load) {
  const token=++generation;
  return load().then(data=>watch(data,()=>true,'native',token));
}
${nativePracticePanelSource}
class Group{}
function ghostFactory(scene){const group=new Group;group.name="record-ghost",group.visible=!1,scene.add(group);return{update(){},dispose(){}}}
function mapRenderer(){const scene={children:[],add(object){this.children.push(object)}},camera={fov:0,updateProjectionMatrix(){}},ghost=ghostFactory(scene);let lastFov=-1;
  const resize=()=>{},api={resize:resize,setQuality:()=>{},render(view){view.fov!==lastFov&&(camera.fov=2*Math.atan(Math.tan(view.fov*Math.PI/360)*.75)*180/Math.PI,camera.updateProjectionMatrix(),lastFov=view.fov);api.lastView=view}};return api}
let renderer=mapRenderer();
const recordGhost={frame:(state,alpha)=>({state,alpha})};
function drawFrame(state,alpha,spectating=false,inReplay=false){renderer.render({state:state,eyePosition:{x:0,y:0,z:0},fov:90,ghost:spectating||inReplay?null:recordGhost.frame(state,alpha)})}
`;

function fixture() {
  let adapter;
  const runtime = new Function('globalThis', instrumentGame(nativeSource) + `
    return {nativeWatch,generation:()=>generation,setStartup:fn=>{startup=fn;},drawFrame,replaceRenderer:()=>{renderer=mapRenderer();},
      setOwner:id=>{client.session=id?{user:{id}}:null;},
      sessions:()=>sessions,restart,setStart:(key,start)=>{starts[key]=start;},
      setRules:rule=>{settings.rule=rule;},setReplayMap:map=>{replayMap=map;}};
  `)({__SURFD_QOL__: {attach: value => { adapter = value; }}});
  return {adapter, runtime};
}

describe('native replay instrumentation', () => {
  test('extension reservation cancels an older native download without reserving again at startup', async () => {
    const {adapter, runtime} = fixture();
    let finishNative;
    const native = runtime.nativeWatch(() => new Promise(resolve => { finishNative = resolve; }));
    const token = adapter.replay.reserve();
    finishNative({commands: ['older']});
    await native;
    expect(adapter.replay.playback().replay).toBeNull();
    const data = {commands: ['newer']};
    await adapter.replay.watch(data, 'saved', () => adapter.replay.isCurrent(token), token);
    expect(adapter.replay.playback().replay).toBe(data);
    expect(runtime.generation()).toBe(token);
    expect(adapter.replay.isCurrent(token)).toBe(true);
  });

  test('a newer native intent cancels an already pending extension startup', async () => {
    const {adapter, runtime} = fixture();
    let finishStartup;
    runtime.setStartup(() => new Promise(resolve => { finishStartup = resolve; }));
    const token = adapter.replay.reserve();
    const pending = adapter.replay.watch({commands: ['older']}, 'saved', () => true, token);
    runtime.setStartup(() => Promise.resolve());
    const data = {commands: ['newer']};
    await runtime.nativeWatch(async () => data);
    expect(adapter.replay.isCurrent(token)).toBe(false);
    finishStartup();
    await pending;
    expect(adapter.replay.playback().replay).toBe(data);
  });

  test('reference ownership follows the current account and rejects another account’s board data', () => {
    const {adapter, runtime} = fixture();
    expect(adapter.getReferences()).toMatchObject({ownerKey: 'account-a', own: {runId: 'pb-a'}});
    runtime.setOwner('account-b');
    expect(adapter.getReferences()).toMatchObject({ownerKey: 'account-b', own: null});
    runtime.setOwner(null);
    expect(adapter.getReferences()).toMatchObject({ownerKey: 'guest', own: null});
  });
});

describe('optional camera preview instrumentation', () => {
  test('sets only native input view without moving the session', () => {
    const {adapter} = fixture();
    const session = adapter.getSession();
    adapter.previewView.set({yaw: 110, pitch: 95});
    expect(adapter.previewView.get()).toEqual({yaw: 110, pitch: 89});
    expect(adapter.getSession()).toBe(session);
    expect(session.state).toBeUndefined();
  });
  test('an unsupported camera setter leaves the base adapter usable', () => {
    const warnings = [], originalWarn = console.warn;
    let adapter;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const changed = nativeSource.replace('setView(e){this.yaw=e.yaw,this.pitch=Math.max(-89,Math.min(89,e.pitch))}', 'otherView(){}');
      new Function('globalThis', instrumentGame(changed))({__SURFD_QOL__: {attach: value => {adapter = value;}}});
    } finally { console.warn = originalWarn; }
    expect(adapter.previewView).toBeUndefined();
    expect(adapter.getSession().map.id).toBe('map');
    expect(warnings.some(text => text.includes('Strafe preview unavailable:'))).toBe(true);
  });
});

describe('optional Compare view instrumentation', () => {
  test('the map renderer exposes its scene, camera and ghost factory, and frames carry their interpolation', () => {
    const {adapter, runtime} = fixture();
    const renderer = adapter.cinema.renderer();
    expect(renderer.qolScene.children.map(child => child.name)).toEqual(['record-ghost']);
    renderer.qolGhost();
    expect(renderer.qolScene.children).toHaveLength(2);
    runtime.drawFrame({tick: 4}, 0.25);
    expect(renderer.qolCamera.fov).toBeGreaterThan(0);
    expect(renderer.lastView).toMatchObject({qolAlpha: 0.25, ghost: {alpha: 0.25}});
    runtime.drawFrame({tick: 5}, 0.5, false, true);
    expect(renderer.lastView).toMatchObject({qolAlpha: 0.5, ghost: null});
  });
  test('a renderer the game replaces is the one the adapter returns', () => {
    const {adapter, runtime} = fixture();
    const first = adapter.cinema.renderer();
    runtime.replaceRenderer();
    expect(adapter.cinema.renderer()).not.toBe(first);
    expect(adapter.cinema.renderer().qolScene).toBeTruthy();
  });
  test('an unrecognised renderer leaves Compare out and the rest of the adapter working', () => {
    const warnings = [], originalWarn = console.warn;
    let adapter;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const changed = nativeSource.replace('group.name="record-ghost"', 'group.name="other"');
      new Function('globalThis', instrumentGame(changed))({__SURFD_QOL__: {attach: value => {adapter = value;}}});
    } finally { console.warn = originalWarn; }
    expect(adapter.cinema).toBeUndefined();
    expect(adapter.replay.playback).toBeTypeOf('function');
    expect(warnings.some(text => text.includes('Compare view unavailable:'))).toBe(true);
  });
  test('leaderboard entries are offered with the references', () => {
    const {adapter} = fixture();
    expect(adapter.getReferences().entries).toEqual([]);
  });
});

describe('native practice destinations', () => {
  test('a legacy replay uses Restart’s current rules and format without constructing or changing a Session', () => {
    const {adapter, runtime} = fixture();
    const legacy = adapter.getSession(), legacyKey = legacy.practiceKey(), count = runtime.sessions();
    const destination = adapter.practice.destination();
    expect(destination).toEqual({map: legacy.map, mapId: 'map', mapVersion: 1, key: JSON.stringify(['map', 1, 'current', 8]), startPosition: null});
    expect(runtime.sessions()).toBe(count);
    expect(adapter.getSession()).toBe(legacy);
    expect(legacy.practiceKey()).toBe(legacyKey);
    expect(runtime.restart().practiceKey()).toBe(destination.key);
  });

  test('destination metadata follows native map override and live movement settings rather than replay metadata', () => {
    const {adapter, runtime} = fixture();
    runtime.setReplayMap({id: 'map', version: 2});
    runtime.setRules('unrestricted');
    const destination = adapter.practice.destination();
    expect(destination).toEqual({map: {id: 'map', version: 2}, mapId: 'map', mapVersion: 2,
      key: JSON.stringify(['map', 2, 'unrestricted', 8]), startPosition: null});
    expect(adapter.getSession().map.version).toBe(1);
    expect(runtime.restart().practiceKey()).toBe(destination.key);
    runtime.setRules('ranked');
    expect(adapter.practice.destination().key).toBe(JSON.stringify(['map', 2, 'ranked', 8]));
  });

  test('the destination carries the start position Restart applies: the one you set on that map version', () => {
    const {adapter, runtime} = fixture();
    const yours = {position: {x: 1, y: 2, z: 3}, yaw: 90, pitch: 0};
    runtime.setStart('map:1', yours);
    expect(adapter.practice.destination().startPosition).toEqual(yours);
    expect(runtime.restart().startPosition).toEqual(yours);
    runtime.setReplayMap({id: 'map', version: 2});
    expect(adapter.practice.destination().startPosition).toBeNull();
  });

  test('without a recognisable start loader, savelocs still file and keep the replay’s start position', () => {
    let adapter;
    const source = nativeSource.replace('return saved&&session.setStartPosition(saved),session;', 'return session;');
    new Function('globalThis', instrumentGame(source))({__SURFD_QOL__: {attach: value => { adapter = value; }}});
    const destination = adapter.practice.destination();
    expect(destination.key).toBe(JSON.stringify(['map', 1, 'current', 8]));
    expect('startPosition' in destination).toBe(false);
  });
});

// Native social presence arrives from the server; the client only posts menu/solo.
// Both the friend/profile Join actions and accepted notifications use these callbacks.
const nativeSocialSource = `
const officialNames={eu:{name:"Surfd EU"}},roomLabel=id=>officialNames[id]?.name??"Surfd "+id.toUpperCase();
let nativeRoomId=null,joinedState=false,menuKey="",wasJoined=false,wasVisible=false;
const nativeMenu={hidden:false},nativeLoading={isOpen:()=>false},nativeBackdrop={setActive(){}};
const nativePresence=[],nativeInvites=[],nativeToasts=[],nativeReplies=[],nativeQueries=[],nativeJoins=[];
const friendStore={entries:[],sent:[],friends(){return this.entries},setPresence(value){nativePresence.push(value)},
  invite(userId,roomId){nativeInvites.push({userId,roomId})},send(userId,text){this.sent.push({userId,text})}};
const messageEscape=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
function threadItems(messages){return messages.map(item=>{const mine=item.from==="me";return \`<li class="\${mine?"mine":""}" data-id="\${messageEscape(item.id)}">\${messageEscape(item.text)}<span class="msg-meta"></span></li>\`}).join("")}
class NativeNotifications {
  noteOf(note){const name=officialNames[note.roomId??"eu"]?.name??"Surfd EU",text=note.kind==="invite"?"invited you to "+name+".":"";return {...note,text}}
}
const roomController={roomId:()=>nativeRoomId,connected:()=>!!nativeRoomId};
const roomDisplay={connected:()=>!!nativeRoomId,title:()=> "Duplicate title"};
const nativeRows={rows:()=>lobby.servers.rows(),mapTitle:row=>row.mapTitle};
const friendWindows={close(){}},nativeOptions={toast:message=>nativeToasts.push(message),currentMap:()=> "map"};
function officialFriendJoin(id){nativeJoins.push(id);return fetch('/friend-ticket/'+id)}
function friendPresence(userId){const friend=friendStore.friends().find(item=>item.userId===userId);if(!friend)return null;const presence=friend.presence;return presence.kind==="server"?\`Playing on \${nativeRows.rows().find(item=>item.id===presence.roomId)?.name??roomLabel(presence.roomId)}\`:null}
const friendCallbacks={
  join:id=>{friendWindows.close(!1),officialFriendJoin(id)},
  invite:friend=>{const id=roomDisplay.connected()?nativeRows.rows().find(row=>row.name===roomDisplay.title())?.id:null;if(!id){nativeOptions.toast("Join a server first, then invite friends to it.");return}friendStore.invite(friend.userId,id),nativeOptions.toast("Invited "+friend.name)},
  myRoom:()=>roomDisplay.connected()?nativeRows.rows().find(row=>row.name===roomDisplay.title())?.id??null:null,
  roomName:id=>nativeRows.rows().find(row=>row.id===id)?.name??roomLabel(id),
  roomMap:id=>{const row=nativeRows.rows().find(entry=>entry.id===id);return row?nativeRows.mapTitle(row):"connecting"}
};
const profileCallbacks={join:id=>{friendWindows.close(!1),officialFriendJoin(id)}};
function acceptNativeInvite(note){friendCallbacks.join(note.roomId)}
function nativeSync(value){const key=\`\${value.joined}|\${value.visible}|\${value.roomId}|\${nativeLoading.isOpen()}\`;if(key===menuKey)return;const previousJoined=wasJoined,previousVisible=wasVisible;menuKey=key,wasJoined=value.joined,wasVisible=value.visible,nativeBackdrop.setActive(value.visible&&!value.joined&&!nativeLoading.isOpen());const map=nativeOptions.currentMap();friendStore.setPresence(value.joined&&value.roomId?null:value.joined&&map?{kind:"solo",mapId:map}:{kind:"menu"})}
function nativeFrame(){lobby.sync({joined:joinedState,visible:!nativeMenu.hidden,roomId:roomController?.roomId()??null})}
let chatRoom=null;
function localReply(text){nativeReplies.push(text)}
function nativeCommand(text){const[token,...parts]=text.trim().split(/\\s+/),argument=parts.join(" "),command=token.replace(/^[!/]/,"").toLowerCase();if(command==="played"){if(chatRoom?.status==="connected"&&!chatRoom.playtime){localReply("Playtime unavailable");return}nativeQueries.push(command);return}if(command==="vote"){localReply("Use /vote followed by one of the displayed numbers.");return}if(command==="help"){localReply("Official help");return}localReply("Unknown command")}
const nativeResults=[];
function nativeResultText(result){const text=result.record?"New Surfd record!":result.personalBest?result.previousBestUs?"Personal best, "+(result.previousBestUs-result.timeUs)+" faster.":"First verified completion.":"Finished.";return result.mapTitle+" in "+result.timeUs+". "+text}
function nativeResultChat(text,type,name,rank){nativeResults.push({text,type,name,rank})}
function announceResult(result){nativeResultChat(nativeResultText(result),"result",result.name,result.rank)}
const nativeSubmissions={calls:[],answers:new Map(),submit(id,context){this.calls.push(["submit",id,context]);return Promise.resolve(this.answers.get(id))},
  submission(id){this.calls.push(["submission",id]);return Promise.resolve(this.answers.get(id))}};
Object.assign(client,{submit:nativeSubmissions.submit,submission:nativeSubmissions.submission,answers:nativeSubmissions.answers,calls:nativeSubmissions.calls});
client.config.maps.push({id:'archived-map',boardId:'old-board',archived:true},{id:'archived-map',boardId:'new-board'});
let rankedTicket=null,guestTicket=null,finishStatus="";
const rankedAttempts={take:()=>rankedTicket},guestAttempts={take:()=>guestTicket};
function nativeFinish(replay,valid){let current;const ticket=rankedAttempts.take(replay,valid);if(current=ticket?.ticket.id??null,!ticket){const guest=guestAttempts.take(replay,valid);finishStatus=guest?"Replay kept for sign-in.":"Saved locally only.";return finishStatus}finishStatus="Replay queued for verification. You can keep surfing.";return "Replay queued for verification."}
`;

// The fixture intentionally preserves only semantic/minified signatures, not
// any live private name. Its network spies make unintended private traffic fail.
const roomSource = nativeSource + `
const catalog=[{id:'map',title:'Fixture map'}],ranking={refresh(){}},options={currentMap:()=> 'map'};
let joined=null,listed=[{id:'public',mapId:'map',online:true}],joinCallback,refreshCallback;
const nativeToast={textContent:'',classList:{add(){}}};let toastExpiry=0;
const toastNode=id=>nativeToast;
function toast(text){toastNode("toast").textContent=text,toastNode("toast").classList.add("show"),toastExpiry=performance.now()+5e3}
const secondsLeft=(end,now)=>Math.max(0,Math.ceil((end-now)/1000));
function countdown(end,now){const seconds=secondsLeft(end,now);return seconds===0?"Changing map…":seconds+"s left"}
function clocks(row){const connection={state:row},offset=0;return [
  countdown(row.endsAt,Date.now()),countdown(row.endsAt,Date.now()),
  countdown(connection.state.endsAt,Date.now()+offset),countdown(row.endsAt,Date.now()+offset)
]}
function nativeBrowser(options){let entries=[],status="Checking servers…",selection=null;
  const eligible=row=>row.online&&!row.preview&&row.players<row.capacity;
  const ping=row=>row.ping, mapTitle=row=>row.mapTitle, all=()=>entries;
  const recommended=()=>entries.filter(eligible)[0]??null;
  let region="all",hideFull=false,hideEmpty=false,order="ping";
  const nodes=()=>[],regionNodes={},comparators={ping:(a,b)=>(ping(a)??9999)-(ping(b)??9999)};
  function visible(){let rows=all().filter(row=>(region==="all"||row.region===region)&&(!hideFull||row.players<row.capacity)&&(!hideEmpty||row.players>0));
    return rows=rows.sort((a,b)=>Number(b.online)-Number(a.online)||comparators[order](a,b)),rows}
  function groups(){return [...new Set(entries.map(row=>row.region))].map(key=>[key,visible().filter(row=>row.region===key)]).filter(([,rows])=>rows.length).sort((a,b)=>(ping(a[1][0])??9999)-(ping(b[1][0])??9999))}
  const roomCode=id=>id.toUpperCase(),joinButton={textContent:""};
  const escapeHtml=value=>String(value).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"),rankClass=value=>value==="Guest"?"rank-guest":"rank-earned",points=value=>String(value);
  const rosterBody={innerHTML:"",onclick:null},rosterEmpty={},rosterTable={hidden:false},rosterWrap={};
  const query=(selector,root)=>selector==="tbody"?rosterBody:selector==="table"?rosterTable:rosterEmpty;
  const insert=(node,html)=>{node.innerHTML=html},friends=new Set(["Friend"]);
  function rosterView(row){
    const people=[...row.roster??[]].sort((a,b)=>Number(friends.has(b.name))-Number(friends.has(a.name))||b.points-a.points);
    query("table",rosterWrap).hidden=!people.length;
    insert(query("tbody",rosterWrap),people.map(person=>\`<tr class="\${friends.has(person.name)?"friend-row-hl":""}"><td><span class="who"><span>\${escapeHtml(person.name)}</span>\${friends.has(person.name)?'<span class="friend-tag">friend</span>':""}\${person.spectating?'<small class="quiet">spectating</small>':""}</span></td><td class="c-min"><span class="rank-name \${rankClass(person.guest?"Guest":person.rank)}">\${escapeHtml(person.guest?"Guest":person.rank)}</span></td><td class="c-num">\${person.guest?"":points(person.points)}</td></tr>\`).join("")+(people.length&&row.players>people.length?\`<tr><td colspan="3" class="quiet">+\${row.players-people.length} more</td></tr>\`:""));
    const empty=query("p.empty",rosterWrap);empty.hidden=!!people.length;
    return {body:rosterBody,table:rosterTable,empty};
  }
  function detail(row,connecting=null){const full=row.players>=row.capacity;joinButton.textContent=connecting===row.id?"Connecting…":full?"Server full":row.preview?"Preview only":\`Join \${roomCode(row.id)}\`;return joinButton}
  function render(){const regions=[...new Set(entries.map(row=>row.region))];regionNodes.hidden=regions.length<2,regionNodes.innerHTML=regions.length<2?"":"tabs";for(const node of nodes("[data-region]",regionNodes))node.onclick=()=>{region=node.dataset.region,render()}}
  let browserTimer;
  const view={el:{hidden:true},open(value){typeof value=="string"&&(selection=value);options.refresh()},close(){clearInterval(browserTimer)}};
  return{view:view,update(rows,note){const now=Date.now();entries=rows.map(row=>({...row,...row.endsAt===undefined?{}:{endsAt:row.endsAt+(row.serverTime===undefined?0:now-row.serverTime)}}));status=note},
    rows:()=>entries,best:recommended,visible,groups,detail,rosterView,setOpenHandler(fn){this.requestOpen=fn},filters(full,empty){hideFull=full;hideEmpty=empty},region(value){region=value},mapTitle:mapTitle}}
const rankSteps=[{points:0,title:"Unranked"},{points:100,title:"Rookie"}];
let ownProfile={kind:"member",userId:"account-a",name:"Fixture player",rank:"Rookie",points:150};
function lobbyFactory(){const windows={opened:[],open(view,value){this.opened.push({view,value})}},servers=nativeBrowser({refresh:()=>{}});servers.setOpenHandler(()=>windows.open("servers"));return {
  servers,windows,sync:nativeSync,me:{get:()=>ownProfile},selected:()=>catalog[0],tab(value){this.tabbed=value},
  updateServers(rows,status){servers.update(rows,status);listed=servers.rows()},
  bindServers(connect,refresh){joinCallback=connect,refreshCallback=refresh,refresh()},
  refreshTop10(){ranking.refresh(catalog.find(entry=>entry.id===options.currentMap())??null)}
}}
const lobby=lobbyFactory();
lobby.bindServers(id=>{joined={id,row:listed.find(row=>row.id===id)}},()=>{});
class NativeRoom {
  baseUrl='https://public.example';roomId=null;
  ticket(){return fetch('/room-ticket',{method:'POST'}).then(response=>response.json()).then(data=>data.token)}
  async list(){const response=await fetch(this.baseUrl+"/servers",{signal:AbortSignal.timeout(8e3),cache:"no-store"});if(!response.ok)throw Error("Servers unavailable");const data=await response.json();if(!Array.isArray(data.servers))throw Error("Invalid server list");return data.servers}
  async measure(id){const started=performance.now();if(!(await fetch(this.baseUrl+"/servers/"+id+"/ping",{signal:AbortSignal.timeout(5e3),cache:"no-store"})).ok)throw Error("Server unavailable");return performance.now()-started}
  async open(id){this.roomId=id;const token=await this.ticket();const url=new URL('/servers/'+id+'/ws',this.baseUrl);return new WebSocket(url,["surfd-v1",token])}
  async refreshIdentity(){return await this.ticket()}
  receive(data){if(data==="pong")return;if(typeof data!="string"||data.length>65536)throw Error("Invalid room data");const message=JSON.parse(data);this.message=message}
  disconnect(){this.watchTarget=null;this.roomId=null}
}
let connection=null,active=null;
const account={opened:0,openAccount(){account.opened++}},roomOptions={onSignIn:()=>account.openAccount()};
const social={available:true,block(){},isBlocked:()=>false},menuActions={opened:null,profile(id,name){menuActions.opened={id,name}}};
function playerMenu(_){return \`\${!_.guest&&social.available&&social.block?\`<button data-act="block">Block</button>\`:""}\`}
function playerAction(H,_){H==="profile"&&menuActions.profile(_.id,_.name)}
function leaveRoom(){connection?.disconnect(),active=null,connection=null}
const document={body:{lastElementChild:null,append(node){document.body.lastElementChild=node}},createElement:tag=>({tag,className:""})};
function mapChangeDialog(n){const e=document.createElement("dialog");e.className="nominate-window map-change-window",document.body.append(e);return{open(){e.opened=n.state()},state(m){e.state=m},error(){},close(){e.closed=!0}}}
let activeRoom=null,soloResets=0;
function resetSolo(){soloResets++}
const gameActions={leave:()=>{activeRoom?.roomId()&&activeRoom.leave(),resetSolo()},room:()=>activeRoom?.roomView??null};
function serverMenu(e,o){if(e.hidden=!1,o){e.innerHTML=\`\${o.guest()?'<button type="button" class="btn" data-act="signin" title="Sign in to chat">Sign in to chat</button>':'<button type="button" class="btn" data-act="chat">Chat</button>'}\`}return e.innerHTML}
function serverMenuAction(u,o){u.onclick=()=>{const h=u.dataset.act;if(h==="chat"&&o.openChat(),h==="rtv"&&o.rtv(),0)return};u.onclick()}
` + nativeSocialSource;

function roomFixture(privateRooms, source = roomSource) {
  let adapter;
  const requests = [], sockets = [], warnings = [];
  let failList = false;
  const fetch = async (url, options) => {
    requests.push({url, options});
    if (String(url).endsWith('/servers')) {
      if (failList) throw new Error('offline');
      return {ok: true, json: async () => ({servers: [{id: 'public', mapId: 'map', online: true}]})};
    }
    return {ok: true, json: async () => ({token: 'native-ticket'})};
  };
  function WebSocket(url, protocols) { sockets.push({url: String(url), protocols}); }
  const warn = console.warn;
  let instrumented;
  try {
    console.warn = (...args) => warnings.push(args);
    instrumented = instrumentGame(source);
  } finally { console.warn = warn; }
  const runtime = new Function('globalThis', 'fetch', 'WebSocket', instrumented + `
    return {room:new NativeRoom(),clocks,joined:()=>joined,profile:value=>{client.profile=value},me:value=>{ownProfile=value},
      guest:()=>{client.session=null},browser:lobby.servers,leave:room=>{connection=room;leaveRoom()},
      native:{friends:friendCallbacks,profile:profileCallbacks,presence:friendPresence,accept:acceptNativeInvite,
        notes:new NativeNotifications(),friendStore,nativePresence,nativeInvites,nativeToasts,nativeReplies,nativeQueries,nativeJoins,
        command:nativeCommand,setRoom:id=>{nativeRoomId=id;joinedState=!!id;chatRoom=id?{roomId:id,status:"connected",playtime:true}:null},
        results:nativeResults,announceResult,client,threadItems,
        finish:ticket=>{rankedTicket=ticket?{ticket:{id:ticket}}:null;return nativeFinish({},true)},
        menu:open=>{nativeMenu.hidden=!open;nativeFrame()},frame:nativeFrame,label:roomLabel},
      ui:{serverMenu,serverMenuAction,page:document,lobby,enter:room=>{activeRoom=room},soloResets:()=>soloResets},
      playerMenu,playerAction,menuActions,account,signOut:()=>{client.session=null;for(const listener of client.listeners)listener()}};
  `)({__SURFD_QOL__: {privateRooms, attach: value => { adapter = value; }}}, fetch, WebSocket);
  return {adapter, runtime, requests, sockets, warnings, instrumented, failList: () => { failList = true; }};
}

function privateFixtureHooks() {
  const row = {id: 'private-fixture', name: 'Private fixture', mapId: 'map', online: true};
  const socket = {private: true};
  return {
    row, socket,
    ticket: id => id === row.id ? 'private-ticket' : null,
    measure: id => id === row.id ? 0 : null,
    roomSocket: id => id === row.id ? socket : null,
    mergeRooms: rows => [...rows, row]
  };
}

describe('optional native private room instrumentation', () => {
  test('public tickets, refresh, ping and WebSockets keep the native flow', async () => {
    const fixture = roomFixture(privateFixtureHooks());
    await fixture.runtime.room.open('public');
    await fixture.runtime.room.refreshIdentity();
    await fixture.runtime.room.measure('public');
    expect(fixture.requests.filter(request => request.url === '/room-ticket')).toHaveLength(2);
    expect(fixture.requests.some(request => request.url.endsWith('/servers/public/ping'))).toBe(true);
    expect(fixture.sockets).toEqual([{url: 'https://public.example/servers/public/ws', protocols: ['surfd-v1', 'native-ticket']}]);
    expect(fixture.warnings).toEqual([]);
  });

  test('private room players get View profile by account id and no Block', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    expect(runtime.playerMenu({id: 'private-1', guest: false})).toBe('');
    expect(runtime.playerMenu({id: 'account-1', guest: false})).toContain('Block');
    runtime.playerAction('profile', {id: 'private-1', userId: 'account-1', name: 'Surfer'});
    expect(runtime.menuActions.opened).toEqual({id: 'account-1', name: 'Surfer'});
    runtime.playerAction('profile', {id: 'account-2', name: 'Official'});
    expect(runtime.menuActions.opened).toEqual({id: 'account-2', name: 'Official'});
  });

  test('account changes reach room listeners until they unsubscribe', () => {
    const {adapter, runtime} = roomFixture(privateFixtureHooks());
    const changes = [];
    const stop = adapter.rooms.onAccountChange(() => changes.push(adapter.rooms.guest()));
    runtime.signOut();
    stop();
    runtime.signOut();
    expect(changes).toEqual([true]);
  });

  test('the room hook never receives the site ticket', async () => {
    const calls = [], hooks = privateFixtureHooks();
    hooks.roomSocket = (...args) => { calls.push(args); return null; };
    const fixture = roomFixture(hooks);
    await fixture.runtime.room.open('public');
    expect(calls).toEqual([['public']]);
    expect(fixture.sockets[0].protocols).toEqual(['surfd-v1', 'native-ticket']);
  });

  test('private connect, identity refresh and measurement never touch site transport', async () => {
    const hooks = privateFixtureHooks();
    const fixture = roomFixture(hooks);
    expect(await fixture.runtime.room.open(hooks.row.id)).toBe(hooks.socket);
    expect(await fixture.runtime.room.refreshIdentity()).toBe('private-ticket');
    expect(await fixture.runtime.room.measure(hooks.row.id)).toBe(0);
    expect(fixture.requests).toEqual([]);
    expect(fixture.sockets).toEqual([]);
  });

  test('known private rows merge with public results and survive public list outages', async () => {
    const hooks = privateFixtureHooks();
    const fixture = roomFixture(hooks);
    expect(await fixture.runtime.room.list()).toEqual([{id: 'public', mapId: 'map', online: true}, hooks.row]);
    fixture.failList();
    expect(await fixture.runtime.room.list()).toEqual([hooks.row]);
  });

  test('adapter uses native join callback and selected row plus current identity and maps', () => {
    const hooks = privateFixtureHooks();
    const {adapter, runtime} = roomFixture(hooks);
    adapter.rooms.update([hooks.row]);
    adapter.rooms.join(hooks.row.id);
    expect(runtime.joined()).toEqual({id: hooks.row.id, row: hooks.row});
    const appearance = {title: '', nameColor: '#123456', titleColor: null, revision: 1};
    runtime.profile({username: 'Fixture player', appearance});
    expect(adapter.rooms.displayName()).toBe('Fixture player');
    expect(adapter.rooms.appearance()).toBe(appearance);
    expect(adapter.rooms.guest()).toBe(false);
    expect(adapter.rooms.userId()).toBe('account-a');
    expect(adapter.rooms.profile()).toEqual({rank: 'Rookie', points: 150});
    expect(adapter.rooms.ranks()).toEqual([{points: 0, title: 'Unranked'}, {points: 100, title: 'Rookie'}]);
    runtime.me({kind: 'member', userId: 'account-b', rank: 'Legend', points: 30000});
    expect(adapter.rooms.profile()).toBeNull();
    runtime.me({kind: 'guest', userId: null, rank: 'Unranked', points: 0});
    expect(adapter.rooms.profile()).toBeNull();
    runtime.guest();
    expect(adapter.rooms.guest()).toBe(true);
    expect(adapter.rooms.userId()).toBeNull();
    adapter.rooms.signIn();
    expect(runtime.account.opened).toBe(1);
    expect(adapter.rooms.maps()).toEqual([{id: 'map', title: 'Fixture map'}]);
    expect(adapter.rooms.currentMap()).toBe(adapter.getSession().map);
  });

  test('the host’s room UI reuses the game’s map dialog, Leave, map change, status line and browser', () => {
    const {adapter, runtime, warnings} = roomFixture(privateFixtureHooks());
    expect(warnings).toEqual([]);
    const picker = adapter.rooms.mapPicker({state: () => ({mapId: null, epoch: 1})});
    expect(picker.dialog).toBe(runtime.ui.page.body.lastElementChild);
    expect(picker.dialog.className).toBe('nominate-window map-change-window');
    picker.open();
    expect(picker.dialog.opened).toEqual({mapId: null, epoch: 1});
    const calls = [];
    runtime.ui.enter({roomId: () => 'p-aaaaaaaaaaaa', leave: () => calls.push('leave'), roomView: {changeMap: () => calls.push('change')}});
    adapter.rooms.changeMap();
    adapter.rooms.leaveRoom();
    expect(calls).toEqual(['change', 'leave']);
    expect(runtime.ui.soloResets()).toBe(1);
    adapter.rooms.openBrowser();
    expect(runtime.ui.lobby.tabbed).toBe('servers');
    runtime.browser.update([{id: 'eu', endsAt: 1000, serverTime: Date.now()}], 'Ready');
    adapter.rooms.setStatus('This private room has closed.');
    expect(adapter.rooms.status()).toBe('This private room has closed.');
    expect(adapter.rooms.rows().map(row => row.id)).toEqual(['eu']);
  });

  test('only the host in its own room gets Your room in the room menu', () => {
    const hooks = privateFixtureHooks(), opened = [];
    let own = false;
    hooks.ownRoom = () => own;
    hooks.openRoom = () => opened.push('room');
    const {runtime} = roomFixture(hooks);
    const menu = {}, room = {guest: () => false, openChat: () => opened.push('chat')};
    expect(runtime.ui.serverMenu(menu, room)).not.toContain('qol-room');
    own = true;
    expect(runtime.ui.serverMenu(menu, room)).toStartWith('<button type="button" class="btn" data-act="qol-room">Your room</button><button type="button" class="btn" data-act="chat">');
    runtime.ui.serverMenuAction({dataset: {act: 'qol-room'}}, room);
    runtime.ui.serverMenuAction({dataset: {act: 'chat'}}, room);
    expect(opened).toEqual(['room', 'chat']);
    expect(roomFixture(undefined).runtime.ui.serverMenu({}, room)).not.toContain('qol-room');
  });

  test('a missing room UI hook warns on its own and leaves the others', () => {
    const source = roomSource.replace('className="nominate-window map-change-window"', () => 'className="map-change-window"');
    const {adapter, warnings} = roomFixture(privateFixtureHooks(), source);
    expect(warnings.map(args => args[0])).toEqual(['[Surfd QoL] Room map choice unavailable:']);
    expect(adapter.rooms.mapPicker).toBeUndefined();
    expect(adapter.rooms.leaveRoom).toBeFunction();
    expect(adapter.rooms.join).toBeFunction();
  });

  test('absent runtime hooks leave all native behavior available', async () => {
    const fixture = roomFixture(undefined);
    await fixture.runtime.room.open('public');
    expect(fixture.sockets).toHaveLength(1);
    expect(await fixture.runtime.room.list()).toEqual([{id: 'public', mapId: 'map', online: true}]);
    fixture.failList();
    await expect(fixture.runtime.room.list()).rejects.toThrow('offline');
  });

  test('an unrecognised optional hook warns and leaves the entire room transport unchanged', async () => {
    const source = roomSource.replace('cache:\"no-store\"', 'cache:\"reload\"');
    const fixture = roomFixture(privateFixtureHooks(), source);
    expect(fixture.adapter.rooms).toBeUndefined();
    expect(fixture.warnings).toHaveLength(1);
    expect(fixture.warnings[0][0]).toContain('Private rooms unavailable');
    await fixture.runtime.room.open('public');
    expect(fixture.requests[0].url).toBe('/room-ticket');
    expect(fixture.sockets).toHaveLength(1);
  });

  test('untimed private rows and room state show no time limit while public countdowns stay native', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    expect(runtime.clocks({endsAt: 0, untimed: true})).toEqual(Array(4).fill('No time limit'));
    expect(runtime.clocks({endsAt: 0})).toEqual(Array(4).fill('Changing map…'));
    for (const text of runtime.clocks({endsAt: Date.now() + 30000, untimed: false})) expect(text).toMatch(/^\d+s left$/);
  });

  test('instrumenting an instrumented bundle does not duplicate transport hooks', () => {
    const fixture = roomFixture(privateFixtureHooks());
    expect(instrumentGame(fixture.instrumented)).toBe(fixture.instrumented);
  });

  test('old adapters require fresh source', () => {
    expect(isCurrentInstrumented(instrumentGame(nativeSource))).toBe(true);
    expect(() => instrumentGame(nativeSource + '\n/* surfd-qol-adapter-v6: stale */')).toThrow('Stale');
  });

  test('community Join uses the selected room name while official labels and join states stay native', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const row = {id: 'p-aaaaaaaaaaaa', name: "Friends' & family", players: 2, capacity: 16};
    expect(runtime.browser.detail(row).textContent).toBe("Join Friends' & family");
    expect(runtime.browser.detail({...row, id: 'eu', name: 'Surfd EU'}).textContent).toBe('Join EU');
    expect(runtime.browser.detail(row, row.id).textContent).toBe('Connecting…');
    expect(runtime.browser.detail({...row, players: 16}).textContent).toBe('Server full');
    expect(runtime.browser.detail({...row, preview: true}).textContent).toBe('Preview only');
  });

  test('community roster reads only names and guest identity, not host rank or friend claims', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const names = ['<Surfer & "one">', 'Friend'];
    const roster = names.map((name, index) => {
      const player = {name, guest: index === 1};
      for (const field of ['points', 'rank', 'spectating']) Object.defineProperty(player, field, {get() { throw new Error('Read untrusted ' + field); }});
      return player;
    });
    const {body, table, empty} = runtime.browser.rosterView({id: 'p-aaaaaaaaaaaa', players: 5, roster});
    expect(body.innerHTML).toContain('&lt;Surfer &amp; &quot;one&quot;&gt;');
    expect(body.innerHTML.indexOf('Surfer')).toBeLessThan(body.innerHTML.indexOf('Friend'));
    expect(body.innerHTML).toContain('rank-guest">Guest');
    expect(body.innerHTML).not.toContain('friend-tag');
    expect(body.innerHTML).not.toContain('<button');
    expect(body.innerHTML).toContain('+3 more');
    expect(table.hidden).toBe(false);
    expect(empty.hidden).toBe(true);
    runtime.browser.rosterView({id: 'p-aaaaaaaaaaaa', players: 0});
    expect(body.innerHTML).toBe('');
    expect(table.hidden).toBe(true);
    expect(empty.hidden).toBe(false);
  });

  test('only non-guest UUIDs make community profile buttons and navigation uses that exact ID', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const userId = 'ABCDEF01-2345-6789-abcd-0123456789ab';
    const roster = [
      {name: 'Friend', guest: false, userId},
      {name: 'Guest', guest: true, userId},
      {name: 'Anonymous', guest: false},
      {name: 'Bad ID', guest: false, userId: 'private-1'},
      {name: 'Injection', guest: false, userId: userId + '" onclick="bad'},
      {name: 'Unknown guest flag', userId}
    ];
    const {body} = runtime.browser.rosterView({id: 'p-aaaaaaaaaaaa', players: roster.length, roster});
    const buttons = [...body.innerHTML.matchAll(/<button[^>]*data-qol-user="([^"]+)" data-qol-name="([^"]+)"[^>]*>/g)];
    expect(buttons.map(match => [match[1], match[2]])).toEqual([[userId, 'Friend']]);
    body.onclick({target: {closest: () => null}});
    expect(runtime.ui.lobby.windows.opened).toEqual([]);
    const button = {dataset: {qolUser: buttons[0][1], qolName: buttons[0][2]}};
    body.onclick({target: {closest: () => button}});
    expect(runtime.ui.lobby.windows.opened).toEqual([{view: 'profile', value: {userId, name: 'Friend'}}]);
    runtime.browser.rosterView({id: 'eu', players: 0, roster: []});
    expect(body.onclick).toBeNull();
  });

  test('official roster keeps native rank, points, guest display, friend ordering and no new profile action', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const {body} = runtime.browser.rosterView({id: 'eu', players: 3, roster: [
      {name: 'Leader', guest: false, rank: 'Champion', points: 900, spectating: true},
      {name: 'Friend', guest: false, rank: 'Surfer', points: 100},
      {name: 'Visitor', guest: true, points: 0}
    ]});
    expect(body.innerHTML.indexOf('Friend')).toBeLessThan(body.innerHTML.indexOf('Leader'));
    expect(body.innerHTML).toContain('friend-tag');
    expect(body.innerHTML).toContain('Champion');
    expect(body.innerHTML).toContain('>900</td>');
    expect(body.innerHTML).toContain('spectating');
    expect(body.innerHTML).toContain('rank-guest">Guest');
    expect(body.onclick).toBeNull();
  });

  test('community never wins official recommendation', () => {
    const {adapter, runtime} = roomFixture(privateFixtureHooks());
    adapter.rooms.update([
      {id:'p-aaaaaaaaaaaa',region:'Public',players:300,capacity:1000,online:true,ping:1},
      {id:'eu',region:'Europe',players:2,capacity:64,online:true,ping:90},
      {id:'p-bbbbbbbbbbbb',region:'Private',players:0,online:true}
    ]);
    expect(runtime.browser.best().id).toBe('eu');
    runtime.browser.filters(true,true);
    expect(runtime.browser.visible().map(row=>row.id)).toEqual(['eu','p-aaaaaaaaaaaa']);
    expect(runtime.browser.groups().map(([region])=>region)).toEqual(['Europe','Community']);
    runtime.browser.region('Community');
    expect(runtime.browser.visible().map(row=>row.id)).toEqual(['p-aaaaaaaaaaaa']);
    runtime.browser.filters(true,false);
    expect(runtime.browser.visible().map(row=>row.id)).toEqual(['p-aaaaaaaaaaaa','p-bbbbbbbbbbbb']);
  });

  test('community rows with the room capacity keep their place in Play now, Hide full and the order', () => {
    const {adapter, runtime} = roomFixture(privateFixtureHooks());
    adapter.rooms.update([
      {id:'p-aaaaaaaaaaaa',region:'Public',players:256,capacity:256,online:true,ping:1},
      {id:'eu',region:'Europe',players:64,capacity:64,online:true,ping:90},
      {id:'na',region:'North America',players:3,capacity:64,online:true,ping:120},
      {id:'p-bbbbbbbbbbbb',region:'Private',players:2,capacity:256,online:true,ping:2}
    ]);
    expect(runtime.browser.best().id).toBe('na');
    expect(runtime.browser.visible().map(row=>row.id)).toEqual(['eu','na','p-aaaaaaaaaaaa','p-bbbbbbbbbbbb']);
    runtime.browser.filters(true,false);
    expect(runtime.browser.visible().map(row=>row.id)).toEqual(['na','p-aaaaaaaaaaaa','p-bbbbbbbbbbbb']);
    expect(runtime.browser.groups().map(([region])=>region)).toEqual(['North America','Community']);
  });

  test('identifiers containing $ survive instrumentation', () => {
    const source = roomSource.replaceAll(/(?<!\.)\bstatus\b/g, () => 's$1')
      .replace('receive(data){if(data==="pong")return;if(typeof data!="string"||data.length>65536)throw Error("Invalid room data");const message=JSON.parse(data);this.message=message}',
        () => 'receive(d$1){if(d$1==="pong")return;if(typeof d$1!="string"||d$1.length>65536)throw Error("Invalid room data");const m$$=JSON.parse(d$1);this.message=m$$}');
    const {adapter, runtime, warnings} = roomFixture(privateFixtureHooks(), source);
    expect(warnings).toEqual([]);
    runtime.browser.update([], 'Offline; try again.');
    expect(adapter.rooms.status()).toBe('Offline; try again.');
    runtime.room.roomId = 'p-aaaaaaaaaaaa';
    runtime.room.receive(JSON.stringify({type: 'roster', players: []}));
    expect(runtime.room.message).toEqual({type: 'roster', players: []});
  });

  test('row updates preserve clocks and status', () => {
    const {adapter,runtime} = roomFixture(privateFixtureHooks());
    runtime.browser.update([{id:'eu',endsAt:1000,serverTime:Date.now()-5000}], 'Offline; try again.');
    const end = adapter.rooms.rows()[0].endsAt;
    adapter.rooms.update(adapter.rooms.rows());
    adapter.rooms.update(adapter.rooms.rows());
    expect(adapter.rooms.rows()[0].endsAt).toBe(end);
    expect(adapter.rooms.status()).toBe('Offline; try again.');
    expect(adapter.rooms.rows()[0].serverTime).toBeUndefined();
    expect(adapter.rooms.browserOpen()).toBe(false);
    runtime.browser.view.el.hidden=false;
    expect(adapter.rooms.browserOpen()).toBe(true);
    adapter.rooms.select('p-aaaaaaaaaaaa');
    expect(adapter.rooms.selected()).toBe('p-aaaaaaaaaaaa');
  });

  test('private chunks deliver complete large rosters', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const room=runtime.room;
    room.roomId='p-aaaaaaaaaaaa';
    const message={type:'roster',players:Array.from({length:2000},(_,slot)=>({slot,name:'Surfer '+slot,connectionId:'connection-'+slot}))};
    const json=JSON.stringify(message);
    expect(json.length).toBeGreaterThan(65536);
    for(let index=0;index<json.length;index+=8000)room.receive(JSON.stringify({type:'room-chunk',data:json.slice(index,index+8000),final:index+8000>=json.length}));
    expect(room.message).toEqual(message);
    expect(()=>room.receive(json)).toThrow('Invalid room data');
    room.receive(JSON.stringify({type:'room-chunk',data:'unfinished',final:false}));
    room.disconnect();
    expect(room.__qolChunks).toBeNull();
  });

  test('endless non-final chunks are bounded and a rejected stream releases its fragments', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const room = runtime.room;
    room.roomId = 'p-aaaaaaaaaaaa';
    const fragment = JSON.stringify({type: 'room-chunk', data: '', final: false});
    for (let index = 0; index < ROOM_CHUNKS; index++) room.receive(fragment);
    expect(() => room.receive(fragment)).toThrow('Invalid room chunk');
    expect(room.message).toBeUndefined();
    room.receive(JSON.stringify({type: 'room-chunk', data: '{"type":"roster","players":[]}', final: true}));
    expect(room.message).toEqual({type: 'roster', players: []});
  });

  test('the game hook bounds chunks like the room protocol', () => {
    expect(ROOM_MESSAGE_CHARS).toBe(MAX_ROOM_MESSAGE_CHARS);
    expect(ROOM_CHUNKS).toBe(MAX_ROOM_CHUNKS);
  });

  test('chunk bytes are bounded independently of frame count', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const room = runtime.room;
    room.roomId = 'p-aaaaaaaaaaaa';
    const fragment = JSON.stringify({type: 'room-chunk', data: 'x'.repeat(65000), final: false});
    expect(fragment.length).toBeLessThan(65536);
    for (let index = 0; index < Math.floor(ROOM_MESSAGE_CHARS / 65000); index++) room.receive(fragment);
    expect(() => room.receive(fragment)).toThrow('Invalid room chunk');
    room.receive(JSON.stringify({type: 'roster', players: []}));
    expect(room.message).toEqual({type: 'roster', players: []});
  });

  test('invalid, nested and interrupted chunks cannot contaminate a later message', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    const room = runtime.room;
    room.roomId = 'p-aaaaaaaaaaaa';
    const unfinished = JSON.stringify({type: 'room-chunk', data: '{"type":', final: false});
    const complete = JSON.stringify({type: 'roster', players: []});
    for (const invalid of [
      {type: 'room-chunk', data: 1, final: false},
      {type: 'room-chunk', data: '', final: null},
      {type: 'roster', players: []},
    ]) {
      room.receive(unfinished);
      expect(() => room.receive(JSON.stringify(invalid))).toThrow('Invalid room chunk');
      room.receive(complete);
      expect(room.message).toEqual({type: 'roster', players: []});
    }
    expect(() => room.receive(JSON.stringify({type: 'room-chunk', data: unfinished, final: true}))).toThrow('Invalid room chunk');
    room.receive(complete);
    expect(room.message).toEqual({type: 'roster', players: []});
  });

  test('late optional mismatches roll back every room hook without disabling other QoL', async () => {
    for (const [before, after] of [
      ['disconnect(){this.watchTarget=null', 'disconnect(){this.other=null;this.watchTarget=null'],
      ['if(data==="pong")', 'if("pong"===data)'],
      ['data.length>65536', 'data.length>65535'],
    ]) {
      const left = [];
      const fixture = roomFixture({...privateFixtureHooks(), leave: id => left.push(id)}, roomSource.replace(before, after));
      expect(fixture.adapter.rooms).toBeUndefined();
      expect(fixture.warnings).toHaveLength(1);
      expect(fixture.adapter.getSession()).toBeInstanceOf(fixture.adapter.Session);
      expect(fixture.adapter.practice.destination().mapId).toBe('map');
      const token = fixture.adapter.replay.reserve();
      expect(fixture.adapter.replay.isCurrent(token)).toBe(true);
      await fixture.runtime.room.open('public');
      await fixture.runtime.room.measure('public');
      expect(fixture.requests.some(request => request.url === '/room-ticket')).toBe(true);
      expect(fixture.requests.some(request => request.url.endsWith('/servers/public/ping'))).toBe(true);
      fixture.runtime.leave(fixture.runtime.room);
      expect(left).toEqual([]);
    }
  });

  test('community measurements never refresh the directory or call native endpoints', async () => {
    const refreshes = [], hooks = privateFixtureHooks();
    hooks.row.id = 'p-aaaaaaaaaaaa';
    hooks.refreshDirectory = options => refreshes.push(options);
    const fixture = roomFixture(hooks);
    expect(await fixture.runtime.room.measure(hooks.row.id)).toBe(0);
    expect(refreshes).toEqual([]);
    expect(fixture.requests).toEqual([]);
    fixture.adapter.rooms.refresh();
    expect(refreshes).toEqual([{open: false}]);
    fixture.runtime.browser.view.el.hidden = false;
    fixture.runtime.browser.view.open(hooks.row.id);
    expect(refreshes).toEqual([{open: false}, {open: true}]);
  });

  test('an unknown community ping remains unknown without a native fallback request', async () => {
    const hooks = privateFixtureHooks();
    hooks.measure = () => Promise.resolve(null);
    const fixture = roomFixture(hooks);
    expect(await fixture.runtime.room.measure('p-aaaaaaaaaaaa')).toBeNull();
    expect(fixture.requests).toEqual([]);
  });

  test('an official socket retains the native raw message limit', () => {
    const {runtime} = roomFixture(privateFixtureHooks());
    runtime.room.roomId = 'eu';
    const message = JSON.stringify({type: 'roster', players: [], padding: ' '.repeat(65536)});
    expect(() => runtime.room.receive(message)).toThrow('Invalid room data');
  });

  test('explicit leave notifies runtime', () => {
    const left=[],hooks={...privateFixtureHooks(),leave:id=>left.push(id)};
    const {runtime}=roomFixture(hooks);
    runtime.room.roomId='p-aaaaaaaaaaaa';
    runtime.leave(runtime.room);
    expect(left).toEqual(['p-aaaaaaaaaaaa']);
    expect(runtime.room.roomId).toBeNull();
  });
});

describe('native community behavior integration', () => {
  const communityId = 'p-aaaaaaaaaaaa';
  const publicId = 'p-bbbbbbbbbbbb';
  const rows = [
    {id: communityId, name: "Secret's room", visibility: 'private', mapId: 'map', mapTitle: 'Fixture map'},
    {id: publicId, name: "Public's room", visibility: 'public', mapId: 'map', mapTitle: 'Public map'},
    {id: 'eu', name: 'Surfd EU', mapId: 'map', mapTitle: 'Official map'}
  ];
  const socialHooks = extra => ({
    ...privateFixtureHooks(), menuVisibility() {}, refreshDirectory() {},
    roomInfo: id => rows.find(row => row.id === id) ?? null,
    ...extra
  });

  test('friend, profile and accepted invite joins route community IDs without official requests', async () => {
    const joins = [], fixture = roomFixture(socialHooks({join: id => { joins.push(id); }}));
    const native = fixture.runtime.native;
    await native.friends.join(communityId);
    await native.profile.join(publicId);
    native.accept({roomId: communityId});
    expect(joins).toEqual([communityId, publicId, communityId]);
    expect(fixture.requests).toEqual([]);
    expect(native.nativeJoins).toEqual([]);
    await native.friends.join('eu');
    expect(native.nativeJoins).toEqual(['eu']);
    expect(fixture.requests.map(request => request.url)).toEqual(['/friend-ticket/eu']);
    expect(fixture.warnings).toEqual([]);
  });

  test('failed community joins report once per native action without escaping accepted invites', async () => {
    const closed = 'This private room has closed.';
    for (const join of [() => Promise.reject(new Error(closed)), () => { throw new Error(closed); }]) {
      const fixture = roomFixture(socialHooks({join})), native = fixture.runtime.native;
      await native.friends.join(communityId);
      await native.profile.join(communityId);
      native.accept({roomId: communityId});
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(native.nativeToasts).toEqual([closed, closed, closed]);
      expect(fixture.requests).toEqual([]);
      expect(native.nativeJoins).toEqual([]);
    }
  });

  test('missing runtime never falls back to official friend tickets for community IDs', () => {
    const fixture = roomFixture(undefined);
    fixture.runtime.native.friends.join(communityId);
    fixture.runtime.native.profile.join(communityId);
    fixture.runtime.native.accept({roomId: communityId});
    expect(fixture.requests).toEqual([]);
  });

  test('native friend and profile status never displays private codes or private room names', () => {
    const fixture = roomFixture(socialHooks());
    fixture.runtime.browser.update(rows, 'Ready');
    const native = fixture.runtime.native;
    native.friendStore.entries = rows.map(row => ({userId: row.id, presence: {kind: 'server', roomId: row.id}}));
    expect(native.friends.roomName(communityId)).toBe('Private room');
    expect(native.friends.roomMap(communityId)).toBe('Fixture map');
    expect(native.presence(communityId)).toBe('Playing on Private room · Fixture map');
    expect(native.label(communityId)).toBe('Private room');
    expect(native.notes.noteOf({kind: 'invite', roomId: communityId}).text).toBe('invited you to Private room.');
    expect(native.friends.roomName(publicId)).toBe("Public's room");
    expect(native.presence(publicId)).toBe("Playing on Public's room · Public map");
    expect(native.friends.roomName('eu')).toBe('Surfd EU');
    expect(native.presence('eu')).toBe('Playing on Surfd EU');
    expect(native.friends.roomName('p-cccccccccccc')).toBe('Private room');
    expect(native.friends.roomMap('p-cccccccccccc')).toBe('connecting');
  });

  test('only explicit native invitation sends the private ID and does not claim delivery', () => {
    const fixture = roomFixture(socialHooks());
    fixture.runtime.browser.update(rows, 'Ready');
    const native = fixture.runtime.native;
    native.setRoom(communityId);
    expect(native.friends.myRoom()).toBeNull();
    expect(native.nativeInvites).toEqual([]);
    native.friends.invite({userId: 'friend', name: 'Friend'});
    expect(native.nativeInvites).toEqual([{userId: 'friend', roomId: communityId}]);
    expect(native.nativeToasts).toEqual([]);
    native.setRoom(publicId);
    expect(native.friends.myRoom()).toBe(publicId);
    native.setRoom('eu');
    native.friends.invite({userId: 'friend', name: 'Friend'});
    expect(native.nativeInvites.at(-1)).toEqual({userId: 'friend', roomId: 'eu'});
    expect(native.nativeToasts).toEqual(['Invited Friend']);
  });

  test('a friend invited to a community room is also sent its invite link, which their messages show as Join', () => {
    const link = id => `https://surfd.net/?join=${id}`;
    const fixture = roomFixture(socialHooks({inviteMessage: id => `Join my room: ${link(id)}`}));
    const native = fixture.runtime.native;
    native.setRoom(communityId);
    native.friends.invite({userId: 'friend', name: 'Friend'});
    expect(native.nativeInvites).toEqual([{userId: 'friend', roomId: communityId}]);
    expect(native.friendStore.sent).toEqual([{userId: 'friend', text: `Join my room: ${link(communityId)}`}]);
    expect(native.nativeToasts).toEqual(['Invited Friend to your room.']);
    // Official servers keep the site's invite alone.
    native.setRoom('eu');
    native.friends.invite({userId: 'friend', name: 'Friend'});
    expect(native.friendStore.sent).toHaveLength(1);
    const html = native.threadItems([{id: '1', from: 'Friend', text: `Join my room: ${link(communityId)}`}, {id: '2', from: 'me', text: '<b>hi</b>'}]);
    expect(html).toContain(`Join my room: <button type="button" class="btn small btn-primary" data-qol-join="${communityId}">Join room</button>`);
    expect(html).toContain('&lt;b&gt;hi&lt;/b&gt;');
    expect(fixture.warnings).toEqual([]);
  });
  test('a changed message list leaves friend invites and the rest of the room hooks working', () => {
    const warnings = [], originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try { instrumentGame(roomSource.replace('data-id="${messageEscape(item.id)}"', 'data-key="${messageEscape(item.id)}"')); }
    finally { console.warn = originalWarn; }
    expect(warnings).toEqual([expect.stringContaining('Room invites in friend messages unavailable:')]);
  });

  test('preserves server-controlled presence instead of publishing private IDs', () => {
    const {runtime} = roomFixture(socialHooks());
    runtime.native.frame();
    runtime.native.setRoom(communityId);
    runtime.native.frame();
    runtime.native.setRoom('eu');
    runtime.native.frame();
    expect(runtime.native.nativePresence).toEqual([{kind: 'menu'}, null, null]);
  });

  test('menu transitions notify once and the adapter reports actual visibility', async () => {
    const transitions = [], refreshes = [];
    const fixture = roomFixture(socialHooks({
      menuVisibility: open => transitions.push(open),
      refreshDirectory: options => refreshes.push(options)
    }));
    expect(fixture.adapter.rooms.menuOpen()).toBe(true);
    expect(fixture.adapter.rooms.browserOpen()).toBe(false);
    await fixture.runtime.room.list();
    expect(refreshes).toEqual([undefined]);
    fixture.runtime.native.frame();
    fixture.runtime.native.frame();
    fixture.runtime.native.menu(false);
    fixture.runtime.native.frame();
    expect(fixture.adapter.rooms.menuOpen()).toBe(false);
    fixture.runtime.native.setRoom(communityId);
    fixture.runtime.native.frame();
    expect(transitions).toEqual([true, false]);
    fixture.runtime.native.menu(true);
    expect(transitions).toEqual([true, false, true]);
  });

  test('browser visibility follows native open and post-close visibility without observers', async () => {
    const visibility = [], fixture = roomFixture(socialHooks({browserVisibility: open => visibility.push(open)}));
    const view = fixture.runtime.browser.view;
    view.el.hidden = false;
    view.open();
    expect(visibility).toEqual([true]);
    view.close();
    view.el.hidden = true;
    expect(visibility).toEqual([true]);
    await Promise.resolve();
    expect(visibility).toEqual([true, false]);
    view.el.hidden = false;
    view.open();
    view.close();
    view.el.hidden = true;
    view.el.hidden = false;
    view.open();
    await Promise.resolve();
    expect(visibility.at(-1)).toBe(true);
  });

  test('community command replies use native local chat; unhandled and official commands stay native', () => {
    const commands = [], fixture = roomFixture(socialHooks({
      commandReply: (command, id) => { commands.push({command, id}); return command === '/help' ? 'Community help' : null; }
    }));
    const native = fixture.runtime.native;
    native.setRoom(communityId);
    native.command('/help');
    native.command('/vote');
    native.command('/played');
    expect(native.nativeReplies).toEqual(['Community help', 'Use /vote followed by one of the displayed numbers.']);
    expect(native.nativeQueries).toEqual(['played']);
    expect(commands).toEqual(['/help', '/vote', '/played'].map(command => ({command, id: communityId})));
    native.setRoom('eu');
    native.command('/help');
    native.setRoom(null);
    native.command('/help');
    expect(commands).toHaveLength(3);
    expect(native.nativeReplies.slice(-2)).toEqual(['Official help', 'Official help']);
  });

  test('community room records and unverified completions get room wording; site results keep native wording', () => {
    const {runtime} = roomFixture(socialHooks()), native = runtime.native;
    const result = {mapTitle: 'Fixture map', timeUs: 1000000, name: 'Surfer', rank: 'Guest',
      record: true, roomRecord: true, personalBest: true, previousBestUs: null, verified: false};
    native.setRoom(communityId);
    native.announceResult(result);
    expect(native.results.at(-1)).toEqual({text: 'Fixture map in 1000000. New room record!',
      type: 'result', name: 'Surfer', rank: 'Guest'});
    native.announceResult({...result, record: false});
    expect(native.results.at(-1).text).toBe('Fixture map in 1000000. First completion.');
    native.announceResult({...result, record: false, previousBestUs: 1200000});
    expect(native.results.at(-1).text).toBe('Fixture map in 1000000. Personal best, 200000 faster.');
    const site = {...result, roomRecord: undefined, verified: undefined};
    native.announceResult(site);
    expect(native.results.at(-1).text).toBe('Fixture map in 1000000. New Surfd record!');
    native.announceResult({...site, record: false});
    expect(native.results.at(-1).text).toBe('Fixture map in 1000000. First verified completion.');
    native.announceResult({...result, roomRecord: false, verified: true});
    expect(native.results.at(-1).text).toBe('Fixture map in 1000000. New Surfd record!');
    native.setRoom('eu');
    native.announceResult(result);
    expect(native.results.at(-1).text).toBe('Fixture map in 1000000. New Surfd record!');
    native.announceResult({...result, record: false});
    expect(native.results.at(-1).text).toBe('Fixture map in 1000000. First verified completion.');
  });

  test('the game reports each finish\u2019s verification attempt, or none, as it handles the finish', () => {
    const reports = [], {runtime} = roomFixture(socialHooks({finishQueued: id => reports.push(id)}));
    expect(runtime.native.finish('attempt-1')).toBe('Replay queued for verification.');
    expect(runtime.native.finish(null)).toBe('Saved locally only.');
    expect(reports).toEqual(['attempt-1', null]);
  });

  test('verdict watching reports every site answer by attempt id and restores the client when stopped', async () => {
    const {adapter, runtime} = roomFixture(socialHooks()), client = runtime.native.client;
    const prototype = {submission: client.submission};
    expect(adapter.rooms.boardId('map')).toBeNull();
    expect(adapter.rooms.boardId('archived-map')).toBe('new-board');
    client.answers.set('a', {status: 'verified', result: {id: 'r'}});
    const seen = [], stop = adapter.rooms.onVerdict((id, answer) => seen.push([id, answer?.status]));
    expect(await client.submit('a', null)).toEqual({status: 'verified', result: {id: 'r'}});
    await client.submission('b');
    await Promise.resolve();
    expect(seen).toEqual([['a', 'verified'], ['b', undefined]]);
    expect(client.calls).toEqual([['submit', 'a', null], ['submission', 'b']]);
    stop();
    expect(client.submission).toBe(prototype.submission);
    await client.submission('a');
    await Promise.resolve();
    expect(seen).toHaveLength(2);
  });
});

// A consumer fixture: real native buttons call the store, and the selector
// renders entries through the same minified signatures as the shipped game.
const sharedPracticeSource = nativeSource.replace(nativePracticePanelSource, '').replace('bank={entries:()=>[],save(){}}', `bank=new class {
  revision=0;banks=new Map();nextId=1;rows=[{id:1,time:2,stage:1,checkpoints:0}];picked=1;
  entries(){return this.rows}selected(){return this.picked}
  save(){return 1}select(session,id){this.picked=id;return true}
  cycle(){return true}remove(){return true}
  restore(session){return session.restorePractice({native:true})}
}`)
  .replace('function save() { const full=', 'function save() { if(nativeSession.timer.state.phase==="finished")return;const full=')
  .replace('result=bank.save(nativeSession); }', 'result=bank.save(nativeSession);panel.refresh();messages.push(result===null?"Could not save":`Saved #${result}`); }')
  + `
const messages=[],effects=[];
nativeSession.restorePractice=snapshot=>{effects.push(["restore",snapshot]);return true};
function nativePanel(n,e,t){const saveButton=document.getElementById("save"),loadButton=document.getElementById("load");
  const select=document.getElementById("saveloc-list"),count=document.getElementById("count");
  let revision=-1;
  function refresh(){if(revision===n.revision)return;revision=n.revision;const session=e(),rows=n.entries(session);
    select.replaceChildren(...rows.map(row=>{const option=document.createElement("option");
      option.value=String(row.id);option.textContent=\`#\${row.id} · \${session.map.stages?.length?"Stage "+row.stage:"CP "+row.checkpoints} · \${row.time.toFixed(3)}\`;
      option.selected=row.id===n.selected(session);return option}));
    count.textContent=\`\${rows.length} / \${limit}\`;
  }
  select.onchange=()=>{n.select(e(),Number(select.value));refresh()};
  return {refresh};
}
const panel=nativePanel(bank,()=>nativeSession,()=>true);
function nativeLoad(){if(!bank.restore(nativeSession))return;effects.push("invalidate","view","input","practice");panel.refresh()}
function nativeCycle(step){if(!bank.cycle(nativeSession,step)){messages.push("No saved locations.");return}panel.refresh();messages.push("Selected location #"+bank.selected(nativeSession)+".")}
`;

function sharedPracticeFixture() {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, {textContent: id === 'saveloc-help' ? 'Native solo help' : '',
        children: [], replaceChildren(...children) { this.children = children; }});
      return nodes.get(id);
    },
    createElement: () => ({}),
  };
  let adapter;
  const runtime = new Function('globalThis', 'document', instrumentGame(sharedPracticeSource) +
    ';return {bank,save,nativeLoad,nativeCycle,messages,effects,panel};')(
    {__SURFD_QOL__: {attach(value) { adapter = value; }}}, document);
  return {adapter, runtime, node: id => document.getElementById(id)};
}

describe('native shared practice consumers', () => {
  test('native selector preserves supplied newest order, owner labels, selection and solo rendering on detach', () => {
    const {adapter, runtime, node} = sharedPracticeFixture();
    const store = runtime.bank, original = Object.getOwnPropertyDescriptors(store);
    let selected = 23;
    const rows = [{id: 23, name: '<Owner>', own: true, time: 4, stage: 2, checkpoints: 3},
      {id: 8, name: 'Friend', time: 1.5, stage: 1, checkpoints: 1}];
    const calls = [];
    const handlers = {entries: () => rows, selected: () => selected, save: () => null,
      select(session, id) { calls.push([session, id]); selected = id; adapter.practice.refresh(); return true; },
      cycle: () => true, remove: () => true, restore: () => true, saveSnapshot() {}};
    const cleanup = adapter.practice.shared(handlers);
    expect(node('saveloc-list').children.map(row => row.textContent)).toEqual(['<Owner> #23 · CP 3 · 4.000', 'Friend #8 · CP 1 · 1.500']);
    expect(node('saveloc-list').children[0].selected).toBe(true);
    // The game's own count, of your saves against your 20.
    expect(node('count').textContent).toBe('1 / 20');
    expect(node('saveloc-help').textContent).toContain('Each player keeps their newest 20.');
    node('saveloc-list').value = '8';
    node('saveloc-list').onchange();
    expect(calls).toEqual([[adapter.getSession(), 8]]);
    adapter.getSession().map.stages = [{}, {}];
    rows.unshift({id: 24, name: 'Newest', own: true, time: 5, stage: 2, checkpoints: 2});
    adapter.practice.refresh();
    expect(node('saveloc-list').children[0].textContent).toBe('Newest #24 · Stage 2 · 5.000');
    expect(node('count').textContent).toBe('2 / 20');
    cleanup();
    for (const name of ['entries', 'selected', 'save', 'select', 'cycle', 'remove', 'restore']) {
      expect(Object.getOwnPropertyDescriptor(store, name)).toEqual(original[name]);
    }
    expect(node('saveloc-list').children[0].textContent).toBe('#1 · Stage 1 · 2.000');
    expect(node('count').textContent).toBe('1 / 20');
    expect(node('saveloc-help').textContent).toBe('Native solo help');
  });

  test('buttons delegate without false save feedback and Load retains native side effects', () => {
    const {adapter, runtime} = sharedPracticeFixture();
    const session = adapter.getSession(), snapshot = {key: 'native'}, calls = [];
    let accepted = true;
    const handlers = {
      entries: () => [], selected: () => null,
      save(live) { calls.push(['save', live]); return null; },
      select: (...args) => calls.push(['select', ...args]),
      cycle: (...args) => calls.push(['cycle', ...args]),
      remove: (...args) => calls.push(['remove', ...args]),
      restore: live => live.restorePractice(snapshot),
      saveSnapshot: value => { calls.push(['snapshot', value]); return accepted; },
    };
    const nativeSave = runtime.bank.save;
    runtime.bank.save = nativeSave.bind(runtime.bank);
    const descriptor = Object.getOwnPropertyDescriptor(runtime.bank, 'save');
    adapter.practice.shared(handlers);
    runtime.save();
    expect(calls).toEqual([['save', session]]);
    expect(runtime.messages).toEqual([]);
    runtime.nativeLoad();
    expect(runtime.effects).toEqual([['restore', snapshot], 'invalidate', 'view', 'input', 'practice']);
    runtime.bank.cycle(session, -1);
    runtime.bank.remove(session);
    expect(calls.slice(1)).toEqual([['cycle', session, -1], ['remove', session]]);
    expect(adapter.practice.shareSnapshot(snapshot)).toBe(true);
    expect(calls.at(-1)).toEqual(['snapshot', snapshot]);
    // A refused capture stays with the replay's local fallback.
    accepted = false;
    expect(adapter.practice.shareSnapshot(snapshot)).toBe(false);
    adapter.practice.shared(null);
    expect(Object.getOwnPropertyDescriptor(runtime.bank, 'save')).toEqual(descriptor);
    expect(adapter.practice.shareSnapshot(snapshot)).toBe(false);
    runtime.save();
    expect(runtime.messages).toEqual(['Saved #1']);
  });

  test('an old cleanup cannot detach replacement room handlers', () => {
    const {adapter} = sharedPracticeFixture();
    const handlers = value => ({entries: () => [], selected: () => value, save() {}, select() {}, cycle() {}, remove() {}, restore() {}, saveSnapshot() {}});
    const cleanup = adapter.practice.shared(handlers(1));
    adapter.practice.shared(handlers(2));
    cleanup();
    expect(adapter.practice.store().selected(adapter.getSession())).toBe(2);
    adapter.practice.shared(null);
    expect(adapter.practice.store().selected(adapter.getSession())).toBe(1);
  });
});

// The game's panel, Load and cycle binds driven by the room's own controller.
describe('shared savelocs in the game before any save of your own', () => {
  const OWN = '00000000-0000-4000-8000-000000000001', OTHER = '00000000-0000-4000-8000-000000000002';
  const roomMap = id => ({id, version: 'v1', zones: [], spawn: {position: {x: 0, y: 0, z: 0}, yaw: 0, pitch: 0}});
  const snapshot = (mapId, elapsed) => ({key: JSON.stringify([mapId, 'v1', JSON.stringify({dt: 0.015}), 8]),
    state: {position: {x: 1, y: 2, z: 3}, velocity: {x: 0, y: 0, z: 0}, grounded: false, groundId: null, ducked: false,
      duckFraction: 0, eyeHeight: 64, jumpHeld: false, surfaceFriction: 1, yaw: 0, pitch: 0, tick: 100},
    timer: {state: {phase: 'running', startTick: 1, endTick: null, splits: [], invalidReason: null, elapsed}, armed: false, prehops: 0},
    checkpointSpeeds: [], startPosition: null, startJumps: 0, startGroundTime: 0, startHopWarned: false,
    startRegion: '', rawJumpHeld: false, stageStartRecovery: false});
  function room() {
    const f = sharedPracticeFixture(), session = f.adapter.getSession();
    session.map = roomMap('map');
    let controller = null;
    return {...f, session,
      connect(mapId, epoch, saves) {
        controller?.close();
        controller = createSharedSavelocs({practice: f.adapter.practice, send() {}, invalid() { throw new Error('Invalid room data'); }});
        controller.state({mapId, epoch});
        controller.receive({type: 'saveloc-init', mapId, epoch, ownerId: OWN, count: saves.length});
        for (const [id, elapsed] of saves) this.add(mapId, epoch, id, elapsed);
      },
      change(mapId, epoch) {
        session.map = roomMap(mapId);
        controller.state({mapId, epoch});
        controller.receive({type: 'saveloc-init', mapId, epoch, ownerId: OWN, count: 0});
      },
      add(mapId, epoch, id, elapsed) {
        controller.receive({type: 'saveloc-add', mapId, epoch, entry: {id, ownerId: OTHER, name: 'GPT-7-Nebula', snapshot: snapshot(mapId, elapsed)}});
      },
      rows: () => f.node('saveloc-list').children.map(row => (row.selected ? '> ' : '') + row.textContent),
      loaded() {
        const restored = f.runtime.effects.filter(effect => effect[0] === 'restore');
        f.runtime.effects.length = 0;
        return restored.map(([, value]) => value.timer.state.elapsed);
      },
      close: () => controller.close()};
  }
  // List, count, Load, Previous and Next, for whatever saves the room holds.
  function playable(r, newest, older) {
    expect(r.rows()).toEqual([`> GPT-7-Nebula #${newest} · CP 0 · ${newest}.000`, `GPT-7-Nebula #${older} · CP 0 · ${older}.000`]);
    // Your own saves against your 20; none yet.
    expect(r.node('count').textContent).toBe('0 / 20');
    r.runtime.nativeLoad();
    expect(r.loaded()).toEqual([newest]);
    r.runtime.nativeCycle(1);
    expect(r.runtime.messages.at(-1)).toBe(`Selected location #${older}.`);
    r.runtime.nativeLoad();
    expect(r.loaded()).toEqual([older]);
    r.runtime.nativeCycle(-1);
    expect(r.rows()[0]).toStartWith('> ');
  }

  test('saves arriving live are listed, counted, loaded and walked', () => {
    const r = room();
    r.connect('map', 1, []);
    r.add('map', 1, 1, 1);
    r.add('map', 1, 2, 2);
    playable(r, 2, 1);
    r.close();
  });

  test('a late joiner gets the same from the retained saves', () => {
    const r = room();
    r.connect('map', 1, [[1, 1], [2, 2]]);
    playable(r, 2, 1);
    r.close();
  });

  test('after a map change, saves on the new map work the same', () => {
    const r = room();
    r.connect('map', 1, [[1, 1], [2, 2]]);
    r.change('other', 2);
    expect(r.rows()).toEqual([]);
    expect(r.node('count').textContent).toBe('0 / 20');
    r.add('other', 2, 3, 3);
    r.add('other', 2, 4, 4);
    playable(r, 4, 3);
    r.close();
  });
});
