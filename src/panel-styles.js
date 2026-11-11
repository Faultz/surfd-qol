// Settings panel styles: dark glass over the menu, the user's speed colour as
// the only accent, hairline rows instead of cards. The slanted bar is the one motif.
export const panelStyles = `
.launcher,#panel{pointer-events:auto;text-shadow:none;-webkit-text-stroke:0;
  --bg:rgba(18,18,18,.93);--raise:#242424;--sunk:rgba(0,0,0,.3);--line:rgba(255,255,255,.08);--line-2:rgba(255,255,255,.15);
  --text:#eeeeee;--text-2:#a8a8a8;--text-3:#7a7a7a;color:var(--text);font-size:14px;line-height:1.45}
button,input,select{font:inherit;color:inherit}
button{cursor:pointer}
:is(button,input,summary,[role=tabpanel]):focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.mark{display:inline-block;flex:none;width:6px;height:15px;border-radius:1.5px;background:var(--accent);transform:skewX(-18deg)}

.launchers{position:absolute;right:var(--dock-right,20px);bottom:var(--dock-bottom,20px);height:var(--dock-height,42px);display:flex;gap:8px}
.launcher{height:100%;display:inline-flex;align-items:center;gap:9px;padding:0 16px 0 14px;border:1px solid var(--line-2);
  border-radius:999px;background:var(--bg);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);box-shadow:0 8px 28px rgba(0,0,0,.35);
  font-size:13px;font-weight:700;letter-spacing:.02em}
.launcher:hover,.launcher[aria-expanded=true]{border-color:color-mix(in srgb,var(--accent) 55%,transparent)}
.update-notice{position:absolute;right:0;bottom:calc(100% + 10px);pointer-events:auto;white-space:nowrap;color:var(--accent);font-size:12px;font-weight:650;text-decoration:none;text-shadow:0 1px 2px #000}
.update-notice:hover{text-decoration:underline}
.update-notice:focus-visible{outline:2px solid var(--accent);outline-offset:4px}
.launchers:has(.launcher[aria-expanded=true]) .update-notice{display:none}

#panel{--above:calc(var(--dock-bottom,20px) + var(--dock-height,42px) + 12px);position:absolute;right:var(--dock-edge,20px);bottom:var(--above);
  width:560px;max-width:calc(100vw - 24px);height:min(800px,calc(100dvh - var(--above) - 16px));display:flex;flex-direction:column;
  overflow:hidden;border:1px solid var(--line-2);border-radius:18px;background:var(--bg);-webkit-backdrop-filter:blur(22px) saturate(1.1);
  backdrop-filter:blur(22px) saturate(1.1);box-shadow:0 24px 70px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.25);animation:panel-in .16s ease-out}
#panel:has(#tab-history[aria-selected=true]) .preview-hud,#panel:not(:has(#tab-history[aria-selected=true])) .history-preview{display:none}
@keyframes panel-in{from{opacity:0;transform:translateY(6px)}}

.head{flex:none;display:flex;align-items:center;gap:12px;padding:14px 12px 12px 20px}
.head h2{display:flex;align-items:center;gap:10px;margin:0;font-size:15px;font-weight:700;letter-spacing:.005em}
.saved{margin-left:auto;font-size:12px;color:var(--text-3)}
.saved+.close{margin-left:0}
.close{flex:none;margin-left:auto;display:grid;place-items:center;width:34px;height:34px;padding:0;border:0;border-radius:10px;background:transparent;color:var(--text-2)}
.close:hover{background:var(--raise);color:var(--text)}
.close svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round}

/* Live preview: the real HUD renderer over a drawn ramp, lit and shaded faces. */
.preview{flex:none;position:relative;height:150px;margin:0 12px;border-radius:12px;overflow:hidden;isolation:isolate;box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
.scene{position:absolute;inset:0;width:100%;height:100%;display:block}
.preview .hud{--y:56%;--scale:.74}
.preview .clock{width:360px}
.preview .energy .speed{animation:energy 4.5s linear infinite}
@keyframes energy{0%,55%{color:var(--accent)}63%,92%{color:var(--energy-loss)}100%{color:var(--accent)}}

.tabs{flex:none;display:grid;grid-template-columns:repeat(6,minmax(0,1fr));margin:10px 12px 0;border-bottom:1px solid var(--line)}
[role=tab]{position:relative;padding:11px 4px 12px;border:0;background:none;color:var(--text-2);font-size:13.5px;font-weight:700;border-radius:8px 8px 0 0}
[role=tab]:hover{color:var(--text)}
[role=tab][aria-selected=true]{color:var(--text)}
[role=tab][aria-selected=true]::after{content:"";position:absolute;left:calc(50% - 15px);bottom:-1px;width:30px;height:3px;border-radius:2px;background:var(--accent);transform:skewX(-24deg)}
[role=tab]:focus-visible{outline-offset:-2px}

.body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:4px 20px 18px;scrollbar-width:thin;scrollbar-color:#555555 transparent}
[role=tabpanel]{outline:none}
[role=tabpanel]:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-radius:8px}
h3{display:flex;align-items:center;gap:8px;margin:22px 0 2px;font-size:12px;font-weight:700;color:var(--text-2);letter-spacing:.01em}
.group{margin:0}
.group>.row:first-child{border-top:0}

.row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 18px;min-height:50px;padding:10px 0;border-top:1px solid var(--line)}
.row-text{flex:1 1 210px;min-width:0;display:flex;flex-direction:column;gap:2px}
.row-label{font-size:14px;color:var(--text)}
.hint{font-size:12.5px;line-height:1.4;color:var(--text-3)}
.row.off{opacity:.42}
.row.sub{margin:0 0 8px 2px;padding:4px 0 4px 16px;min-height:0;border-top:0;border-left:2px solid var(--line-2)}
.explain{margin:0 0 6px;font-size:12.5px;line-height:1.45;color:var(--text-3)}
.explain.intro{margin:16px 0 0}
.ghost.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 60%,transparent)}

.switch{appearance:none;-webkit-appearance:none;flex:none;position:relative;width:40px;height:23px;margin:0;border-radius:12px;background:rgba(255,255,255,.14);transition:background .15s}
.switch::before{content:"";position:absolute;left:3px;top:3px;width:17px;height:17px;border-radius:50%;background:#d4d4d4;transition:transform .15s,background .15s}
.switch:checked{background:var(--accent)}
.switch:checked::before{transform:translateX(17px);background:#161616}
.switch:disabled{cursor:default}

.seg{flex:none;display:inline-flex;padding:3px;gap:2px;border-radius:10px;background:var(--sunk);box-shadow:inset 0 0 0 1px var(--line)}
.seg label{position:relative;display:block}
.seg input{position:absolute;opacity:0;inset:0;margin:0;cursor:pointer}
.seg span{display:block;padding:6px 12px;border-radius:7px;font-size:13px;font-weight:700;color:var(--text-3);white-space:nowrap;transition:background .12s,color .12s}
.seg label:hover span{color:var(--text-2)}
.seg input:checked+span{background:#383838;color:var(--text);box-shadow:0 1px 2px rgba(0,0,0,.3)}
.seg input:focus-visible+span{outline:2px solid var(--accent);outline-offset:1px}
.seg input:disabled{cursor:default}

.range{flex:none;display:flex;align-items:center;gap:12px;width:228px;max-width:100%}
.range input{flex:1;min-width:0;height:22px;margin:0;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer}
.range input::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(90deg,var(--accent) var(--fill,50%),rgba(255,255,255,.14) var(--fill,50%))}
.range input::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;background:var(--text);box-shadow:0 0 0 3px #1c1c1c,0 1px 3px rgba(0,0,0,.5)}
.range output{width:46px;text-align:right;font-size:13px;color:var(--text-2);font-variant-numeric:tabular-nums}

.num{flex:none;display:inline-flex;align-items:center;gap:7px}
.num input,.cutoffs input{width:70px;padding:7px 9px;border:1px solid var(--line-2);border-radius:8px;background:var(--sunk);text-align:right;font-variant-numeric:tabular-nums;font-size:13.5px}
.num input:hover,.cutoffs input:hover{border-color:rgba(255,255,255,.26)}
.unit{min-width:24px;font-size:12px;color:var(--text-3)}

.colors{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;padding:14px 0 8px}
.color{display:flex;flex-direction:column;align-items:center;gap:8px;font-size:12.5px;color:var(--text-2);cursor:pointer}
.color input{width:42px;height:42px;padding:0;border:0;border-radius:50%;background:none;cursor:pointer;box-shadow:0 0 0 1px var(--line-2),0 0 0 4px transparent;transition:box-shadow .12s}
.color input:hover{box-shadow:0 0 0 1px var(--line-2),0 0 0 4px rgba(255,255,255,.08)}
.color input::-webkit-color-swatch-wrapper{padding:0}
.color input::-webkit-color-swatch{border:0;border-radius:50%}

.actions{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0 4px}
.note{font-size:12.5px;color:var(--text-3)}
.ghost{flex:none;padding:7px 13px;border:1px solid var(--line-2);border-radius:9px;background:transparent;font-size:13px;font-weight:700;color:var(--text-2)}
.ghost:hover{color:var(--text);border-color:color-mix(in srgb,var(--accent) 60%,transparent)}

.keycap{flex:none;min-width:96px;padding:8px 16px 7px;border:1px solid rgba(255,255,255,.14);border-bottom-width:3px;border-radius:9px;
  background:linear-gradient(180deg,#363636,#292929);font-size:14px;font-weight:700;letter-spacing:.02em}
.keycap:hover{border-color:rgba(255,255,255,.24)}
.keycap.listening{border-color:var(--accent);color:var(--accent)}
.keycap:disabled{cursor:default}
.paint-color{flex:none;width:34px;height:34px;padding:0;border:0;border-radius:50%;background:none;cursor:pointer;box-shadow:0 0 0 1px var(--line-2)}
.paint-color::-webkit-color-swatch-wrapper{padding:0}
.paint-color::-webkit-color-swatch{border:0;border-radius:50%}

.sw{display:inline-block;width:9px;height:9px;margin:0 6px 0 1px;border-radius:50%;vertical-align:.5px;background:var(--muted);box-shadow:inset 0 0 0 1px rgba(255,255,255,.18)}
.sw.good{background:var(--good)}.sw.warn{background:var(--warn)}.sw.loss{background:var(--bad)}.sw.energy{background:var(--energy-loss)}
.legend{display:flex;flex-wrap:wrap;gap:6px 18px;padding:12px 0 4px;font-size:12.5px;color:var(--text-2);border-top:1px solid var(--line)}
.tag{padding:1px 7px;border:1px solid currentColor;border-radius:999px;font-size:10.5px;font-weight:700;letter-spacing:.02em;color:var(--warn)}

details.group{margin-top:18px;border-top:1px solid var(--line)}
summary{display:flex;flex-direction:column;gap:2px;padding:14px 26px 12px 0;position:relative;list-style:none;cursor:pointer}
summary::-webkit-details-marker{display:none}
summary::after{content:"";position:absolute;right:6px;top:20px;width:7px;height:7px;border-right:1.8px solid var(--text-2);border-bottom:1.8px solid var(--text-2);transform:rotate(45deg);transition:transform .15s}
details[open] summary::after{transform:translateY(3px) rotate(-135deg)}
.cutoffs{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:9px 14px;padding:4px 0 12px}
.cutoffs [role=columnheader]{font-size:12px;color:var(--text-3)}
.cutoffs [role=rowheader]{font-size:13.5px;color:var(--text)}
.cutoffs .num input{width:64px}

.status{flex:none;margin:0;padding:10px 20px 12px;border-top:1px solid var(--line);font-size:12px;line-height:1.4;color:var(--text-3)}
.status:empty{display:none}

@media (max-width:600px){
  #panel{left:12px;right:12px;width:auto;max-width:none}
  .head{padding-left:16px}.saved{display:none}.saved+.close{margin-left:auto}
  .preview{height:116px;margin:0 10px}.preview .hud{--scale:.62}
  .tabs{margin:8px 10px 0}
  .body{padding:2px 16px 16px}
  .range{width:100%}
  .colors{gap:4px}
}
@media (max-height:720px){
  .preview{height:104px}.preview .hud{--scale:.58;--y:58%}
}
@media (max-height:640px){
  .preview{height:84px}.preview .hud{--scale:.5;--y:56%}
  .status{display:none}
}
@media (prefers-reduced-motion:reduce){
  #panel{animation:none}
  .preview .energy .speed{animation:none;color:var(--energy-loss)}
  .switch,.switch::before,.seg span{transition:none}
}
`;
