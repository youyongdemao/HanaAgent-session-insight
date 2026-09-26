// assets/panel-v2.js — Session Insight v2 前端（独立于 v1，路由 /page?v=2）
import { hana as hanaV2 } from "./sdk.js";
import { initUpdateNotice } from "./update-notice.js";
// 共享的宿主主题跟随（SDK 订阅 + 宿主签发的样式表），设置页也用同一份
import { initHostThemeSync as initSharedThemeSync, syncComputedColorMode, resolveThemeIntent } from "./theme-sync.js";

const PROTOCOL = "hana.plugin.ui";
const VERSION = 1;
// ── 内容没变就不重写 DOM ──
// 渲染函数大多直接 `box.innerHTML = html`，内容一模一样也会重建整棵子树：
// 轮询时只要有一个字段变了（比如账本 calls），所有图表都会跟着重建一遍，
// 画面看上去就是“整块闪一下重画”。数据没变就没有写 DOM 的理由。
// 用「上一次写进去的原文」做比较，不能用读回来的 innerHTML：浏览器会做序列化标准化
// （样式属性会变成 `a: b;` 这种带空格的写法），拿它跟原始字符串比永远不相等。
// 例外：进场路径（手动刷新/切页/首次进入/开弹层）要重播入场动画，必须真重建节点，用 PAINT_FORCE 放行。
let PAINT_FORCE=false;
function paintForce(fn){const prev=PAINT_FORCE;PAINT_FORCE=true;try{return fn();}finally{PAINT_FORCE=prev;}}
try{const _d=Object.getOwnPropertyDescriptor(Element.prototype,"innerHTML");const _set=_d.set,_get=_d.get;Object.defineProperty(Element.prototype,"innerHTML",{configurable:true,enumerable:_d.enumerable,get:_get,set(v){const t=typeof v==="string"?v:String(v);if(!PAINT_FORCE&&this.__paintHTML===t)return;this.__paintHTML=t;_set.call(this,t);}});}catch(e){}
let seq = 0;
function targetOrigin(){const p=new URLSearchParams(window.location.search);const e=p.get("hana-host-origin");if(e)return e;try{return new URL(document.referrer).origin;}catch{return "*";}}
function post(m){window.parent.postMessage(m,targetOrigin());}
function event(type,payload){post({protocol:PROTOCOL,version:VERSION,kind:"event",type,payload});}
function request(type,payload,timeoutMs=10000){const id=`hana-plugin-${Date.now()}-${++seq}`;const origin=targetOrigin();return new Promise((resolve,reject)=>{const t=window.setTimeout(()=>{window.removeEventListener("message",onM);reject(new Error(`Host request timed out: ${type}`));},timeoutMs);function onM(evt){if(evt.source!==window.parent)return;if(origin!=="*"&&evt.origin!==origin)return;const m=evt.data||{};if(m.protocol!==PROTOCOL||m.version!==VERSION||m.id!==id||m.type!==type)return;window.clearTimeout(t);window.removeEventListener("message",onM);if(m.kind==="error")reject(new Error(m.error?.message||`Host request failed: ${type}`));else resolve(m.payload);}window.addEventListener("message",onM);post({protocol:PROTOCOL,version:VERSION,id,kind:"request",type,payload});});}
// ── v2 适配层 ──
// v1 的后端地址是 /api/plugins/<pluginId>/<path>，凭证头 pluginSurfaceSession；
// v2 改成 /api/apps/<appId>/routes/<path>，凭证头 appSurfaceSession。
// 对外接口（hana.api.url / hana.api.fetch）保持不变，前端其余代码零改动。
const APP_ID = "session-insight-v2";
function toRoutePath(input){if(typeof input!=="string"||!input.trim())throw new Error("Invalid app API path.");let t=input.trim();if(t.includes("\\")||t.includes("\0")||t.includes("#")||t.startsWith("//")||/^[a-z][a-z0-9+.-]*:/i.test(t))throw new Error("Invalid app API path.");t=t.replace(/^\/+/, "");if(!t)throw new Error("Invalid app API path.");return t;}
function pluginApiUrl(path){return `${window.location.origin}/api/apps/${APP_ID}/routes/${toRoutePath(path)}`;}
function pluginApiFetch(path,init={}){const ss=new URLSearchParams(window.location.search).get("appSurfaceSession");const h=new Headers(init.headers||{});if(ss)h.set("X-Hana-App-Surface-Session",ss);return fetch(pluginApiUrl(path),{...init,headers:h});}
function hostApiUrl(path){return pluginApiUrl(path);}
const hana={ready:()=>Promise.resolve(),ui:{resize:()=>{}},api:{url:pluginApiUrl,fetch:pluginApiFetch},toast:{show:()=>{}},external:{open:(i)=>hanaV2.external.open(i)}};
// 时间口径与显示一律跟随系统本地时区（用户看到的就是自己机器上的时间）。
// 必须与后端同源：后端 byDay/byHour 也用本地时区，两端各用一套会在跨日时错位。
const fmtDay=(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
const fmtHM=(d)=>`${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
const fmtParts=(d)=>({year:String(d.getFullYear()),month:String(d.getMonth()+1).padStart(2,"0"),day:String(d.getDate()).padStart(2,"0"),hour:String(d.getHours()).padStart(2,"0")});
const fmtHour=(d)=>fmtParts(d).hour+":00";
const fmtWeek=(d)=>{const cur=Date.UTC(d.getFullYear(),d.getMonth(),d.getDate()),start=Date.UTC(d.getFullYear(),0,1);return d.getFullYear()+" 第"+(Math.floor((cur-start)/864e5/7)+1)+"周";};
const fmtMonthDayWeek=(d)=>{const W=["日","一","二","三","四","五","六"];return (d.getMonth()+1)+"月"+d.getDate()+"日星期"+W[d.getDay()];};
const root=document.getElementById("root");
const surface=root?.dataset.surface||"page";
/* 出错时把请求路径与错误原文显在左下角，便于定位；无错时自动移除。 */
function siDiag(msg){try{let el=document.getElementById("si-diag");if(!msg){if(el)el.remove();return;}if(!el){el=document.createElement("div");el.id="si-diag";el.style.cssText="position:fixed;left:8px;bottom:8px;z-index:9999;background:rgba(196,64,64,.94);color:#fff;font:11px/1.5 ui-monospace,Consolas,monospace;padding:6px 9px;border-radius:8px;max-width:78%;white-space:pre-wrap;pointer-events:none";document.body.appendChild(el);}el.textContent=msg;}catch{}}
const diagFails=new Map();
let diagFailAt=0;let surfaceExpired=false;/* 宿主签发的 App 视图会话（app surface session，默认 12 小时）到期后，这个 iframe 之后所有 /api/apps/... 请求都会被宿主直接拒成 403；token 由宿主签发、iframe 自己续不了期，只能等宿主重新挂载视图。置位后停止一切重试，省得每秒刷屏。 */
function diagClock(){const d=new Date();return [d.getHours(),d.getMinutes(),d.getSeconds()].map(n=>String(n).padStart(2,"0")).join(":");}
function diagShort(error){const s=String(error?.message||error||"未知错误");/* 同一个 AbortSignal.timeout 超时，Chrome 的报错文案不统一：可能是 "signal timed out"，也可能是 "The user aborted a request."（底层 abort 的文案）。两种都归成「超时」，不要把它原样当业务错误显示出来。 */if(/signal timed out|timed out|timeout|abort/i.test(s))return "超时";return s.length>30?s.slice(0,30)+"…":s;}
/* 失败详情写日志，弹窗只留一句短话 */
async function reportDiag(path,error,ms,attempt){try{await pluginApiFetch("api/diag-report",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path,error:String(error?.message||error),ms,attempt}),signal:AbortSignal.timeout(3000)});}catch{}}
function diagFail(path,error,t0){const ms=t0?Date.now()-t0:0;const expired=/HTTP (401|403)/.exec(String(error?.message||error));if(expired){if(!surfaceExpired){surfaceExpired=true;diagFails.clear();siDiag("视图凭证已过期\n"+(surface==="widget"?"重新打开这张卡片即可恢复":"重新打开本页即可恢复"));}return;}const n=(diagFails.get(path)||0)+1;diagFails.set(path,n);diagFailAt=Date.now();siDiag(`[${diagClock()}] ${path} ${diagShort(error)}${n>1?" · 第"+n+"次":""} · 详见日志`);reportDiag(path,error,ms,n);}
async function fetchJson(path,timeoutMs=8000){if(surfaceExpired)throw new Error("surface session expired");const t0=Date.now();try{const res=await hana.api.fetch(path,{signal:AbortSignal.timeout(timeoutMs)});if(!res.ok)throw new Error("HTTP "+res.status);const out=await res.json();if(Date.now()-diagFailAt>4000)siDiag("");diagFails.delete(path);return out;}catch(error){diagFail(path,error,t0);throw error;}}

/* 主题同步（与 v1 一致） */
function applyHostTheme(t){const raw=resolveThemeIntent(t);if(!raw)return false;if(document.documentElement.dataset.theme!==raw)document.documentElement.dataset.theme=raw;if(document.body.dataset.hanaTheme!==raw)document.body.dataset.hanaTheme=raw;const tc=document.getElementById("hana-theme-css")||document.querySelector('link[href*="/api/plugins/theme.css"]');if(tc){try{const u=new URL(tc.href,window.location.href);if(u.searchParams.get("theme")!==raw){u.searchParams.set("theme",raw);tc.addEventListener("load",syncComputedColorMode,{once:true});tc.href=u.toString();}}catch{}}requestAnimationFrame(syncComputedColorMode);return true;}
function initHostThemeSync(){const initial=new URLSearchParams(window.location.search).get("hana-theme")||document.body.dataset.hanaTheme||"warm-paper";if(!applyHostTheme(initial))applyHostTheme("warm-paper");try{const hw=window.parent,hd=hw.document,hr=hd.documentElement,media=hw.matchMedia?.("(prefers-color-scheme: dark)");const read=()=>{const a=hr.getAttribute("data-theme")?.trim()||hd.body?.getAttribute("data-theme")?.trim();if(a&&a!=="auto"&&a!=="inherit")return a;const s=hw.localStorage?.getItem("hana-theme")?.trim();if(s&&s!=="auto"&&s!=="inherit")return s;if(initial&&initial!=="auto"&&initial!=="inherit")return initial;return media?.matches?"midnight":"warm-paper";};const sync=()=>applyHostTheme(read());sync();const obs=new MutationObserver(sync);obs.observe(hr,{attributes:true,attributeFilter:["data-theme","class","style"]});if(hd.body)obs.observe(hd.body,{attributes:true,attributeFilter:["data-theme","class","style"]});hw.addEventListener("storage",sync);hw.addEventListener("hana-settings",sync);media?.addEventListener?.("change",sync);const timer=hw.setInterval(sync,500);window.addEventListener("beforeunload",()=>{obs.disconnect();hw.removeEventListener("storage",sync);hw.removeEventListener("hana-settings",sync);media?.removeEventListener?.("change",sync);hw.clearInterval(timer);},{once:true});}catch{}}
initHostThemeSync();
/* v2 主题跟随：宿主下发 { theme, appearance, palettes, cssUrl }，以它为准覆盖上面的推断。
   共用模块里也顺便处理了 appearance 为 dark/light 时该取哪套调色板。 */
initSharedThemeSync();
/* v2 当前会话跟踪：宿主 SDK 的 sessions.getActive / onActiveChanged 是唯一可靠来源。
   v1 那套（宿主 /api/sessions/messages + resolve-entry）在 v2 里不存在，会退化成一个固定会话。 */
let v2ActiveFile=null;
function v2FileFromActive(active){const p=active?.sessionPath??active?.path??active?.file;return typeof p==="string"&&p.endsWith(".jsonl")?p.split(/[\\/]/).pop():null;}
function initV2ActiveTracking(){const push=(active)=>{const base=v2FileFromActive(active);if(base===v2ActiveFile)return;v2ActiveFile=base;};const fail=(tag)=>(e)=>{diagFail(tag,e);};try{hanaV2.sessions.getActive().then(push).catch(fail("sessions.getActive"));}catch(e){fail("sessions.getActive")(e);}try{hanaV2.sessions.onActiveChanged?.((ev)=>push(ev?.current??null));}catch(e){fail("sessions.onActiveChanged")(e);}}
initV2ActiveTracking();
function onHostThemeMessage(evt){if(evt.source!==window.parent)return;const m=evt.data||{};if(m.type!=="hana.host.theme"&&m.type!=="hana.host.context")return;const p=m.payload||{};applyHostTheme(p.resolvedTheme||p.effectiveTheme||p.theme);}
window.addEventListener("message",onHostThemeMessage);
/* v2 主题已改由宿主 SDK（hana.theme）下发，不再需要每秒轮询 /api/appearance。
   该接口在后端会去读 App 沙箱外的外观偏好文件，轮询会持续超时并在面板上弹诊断提示。 */
function initAppearancePolling(){/* no-op in v2 */}
initAppearancePolling();

/* ── 工具 ── */
const $=(s,r=document)=>r.querySelector(s),$$=(s,r=document)=>Array.from(r.querySelectorAll(s));
const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const fmtTokens=n=>n==null?"–":(n>=1e9?(n/1e9).toFixed(2)+"B":n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"K":String(Math.round(n)));
// 总消耗 Token 用：不折成单位，全部位数写出来（千分位分隔），字号交给 CSS 按 --digits 自适应
const fmtFullTok=n=>n==null?"–":Math.round(Number(n)||0).toLocaleString("en-US");
const fmtCost=v=>v==null?"–":"¥"+Number(v).toFixed(2);
const fmtPct=n=>n==null?"–":Number(n).toFixed(1)+"%";const HIT_LOW=85;const hitCls=v=>{const n=Number(v);return Number.isFinite(n)&&n<HIT_LOW?" low":"";};const setHitClass=(el,v)=>{if(el)el.classList.toggle("low",Number.isFinite(Number(v))&&Number(v)<HIT_LOW);};function heatLevels(arr){const ns=arr.map(x=>Number(x)||0).filter(x=>x>0).sort((a,b)=>a-b);if(!ns.length)return[0,0,0,0,0];const q=p=>ns[Math.min(ns.length-1,Math.max(0,Math.floor(p*ns.length)))];return[q(.22),q(.4),q(.62),q(.85),q(1)];}function heatLv(v,levels){const n=Number(v)||0;if(n<=0)return 0;let l=0;for(let i=0;i<levels.length;i++){if(n>=levels[i])l=i+1;}return Math.min(4,l);}function fmtResetAt(value){if(value==null)return"重置时间未知";let ts=Number(value);if(Number.isFinite(ts)){if(ts<1e12)ts*=1000;}else{ts=Date.parse(value);}if(!Number.isFinite(ts))return"重置时间未知";const ms=Math.max(0,ts-Date.now()),h=Math.floor(ms/36e5),m=Math.floor((ms%36e5)/6e4);return h>0?`${h}h ${m}m 后重置`:`${m}m 后重置`;}function quotaWindowName(item){/* 有准确的中文窗口名（如 5 小时窗口/周窗口）直接用，没有才按秒推算 */if(item?.name&&String(item.name).trim())return String(item.name).trim();const type=String(item?.type||"").trim().toUpperCase();if(type){const zh={CREDIT_LIMIT:"点数额度",TOKENS_LIMIT:"Token 用量限制",REQUESTS_LIMIT:"请求次数限制",TIME_LIMIT:"时间用量限制",DAILY_LIMIT:"日用量限制",WEEKLY_LIMIT:"周用量限制",MONTHLY_LIMIT:"月用量限制",PRIMARY_WINDOW:"5 小时窗口",SECONDARY_WINDOW:"周窗口"};return zh[type]||"额度窗口";}const sec=Number(item?.windowSeconds);if(Number.isFinite(sec)&&sec>0){const h=sec/3600;return Number.isInteger(h)?`${h} 小时窗口`:`${Math.round(sec/60)} 分钟窗口`;}return "额度窗口";}

/* ── SVG 图表 ── */
function axis(vals,{w=640,h=170,axisW=42,plotL=50,plotR=632,top=28,bottom=154,max=null,ticks=5,format=v=>Math.round(v)}={}){const m=max||Math.max(...vals,1)*1.08;let o="";Array.from({length:ticks},(_,i)=>i/(ticks-1)).forEach(p=>{const v=m*(1-p),y=top+p*(bottom-top);o+=`<line class="grid-line" x1="${plotL}" y1="${y}" x2="${plotR}" y2="${y}"/><text class="axis-text" x="${axisW-6}" y="${y+3}" text-anchor="end">${format(v)}</text>`});return o;}
function xAxis(n,o={}){const pl=o.plotL||50,pr=o.plotR||632,bottom=o.bottom||154,h=o.h||170,labels=o.labels,ticks=Math.min(o.ticks||5,Math.max(1,n));const barsMode=!!o.bars;const step=barsMode?(pr-pl)/n:(pr-pl)/((n-1)||1);const gap=barsMode?(pr-pl)/n:(ticks>1?(pr-pl)/(ticks-1):(pr-pl));const maxChars=Math.max(3,Math.floor(gap/7.4));let out=`<line class="grid-line" x1="${pl}" y1="${bottom}" x2="${pr}" y2="${bottom}"/>`;for(let t=0;t<ticks;t++){const idx=t===ticks-1?n-1:Math.round((n-1)*t/(ticks-1));const x=barsMode?pl+(idx+.5)*step:pl+idx*step;const tx=barsMode?x:(t===0?x+12:t===ticks-1?x-12:x);const anchor=barsMode?"middle":(t===0?"start":t===ticks-1?"end":"middle");let lab=(typeof labels==="function")?labels(idx):(Array.isArray(labels)?(labels[idx]??idx+1):idx+1);lab=String(lab);if(lab.length>maxChars)lab=lab.slice(0,maxChars-1)+"…";lab=lab.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");out+=`<line class="grid-line" x1="${x}" y1="${bottom}" x2="${x}" y2="${bottom+4}"/><text class="axis-text" x="${tx}" y="${bottom+14}" text-anchor="${anchor}">${lab}</text>`}return out;}
function line(vals,opt={}){const w=opt.w||640,ph=opt.h||170,h=ph+18,axisW=opt.axisW||42,pad=8,pl=axisW+pad,pr=w-pad,top=28,bottom=ph-8,max=opt.yMax||Math.max(...vals,1)*1.08,step=(pr-pl)/((vals.length||1)-1),Y=v=>bottom-(v/max)*(bottom-top);const pts=vals.map((v,i)=>[pl+i*step,Y(v)]),path=pts.map((p,i)=>(i?"L":"M")+p[0].toFixed(1)+","+p[1].toFixed(1)).join(""),area=path+` L${pl},${bottom} Z`;return `<svg viewBox="0 0 ${w} ${h}">${axis(vals,{w,h:ph,axisW,plotL:pl,plotR:pr,top,bottom,max,ticks:opt.ticks||8,format:opt.format||fmtTokens})}<path class="si-area" d="${area}" fill="${opt.fill||"color-mix(in srgb,var(--accent) 10%,transparent)"}"/><path class="si-line" pathLength="1" d="${path}" fill="none" stroke="${opt.stroke||"var(--accent)"}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>${xAxis(vals.length,{plotL:pl,plotR:pr,bottom,h,labels:opt.xLabels,format:opt.xFormat,ticks:opt.xticks})}</svg>`;}
function bars(vals,opt={}){const w=opt.w||640,ph=opt.h||170,h=ph+18,axisW=42,pad=8,pl=axisW+pad,pr=w-pad,top=28,bottom=ph-8,max=opt.yMax||Math.max(...vals,1)*1.08,slot=(pr-pl)/(vals.length||1),bw=Math.max(3,Math.min(12,slot*.62));const pos=vals.map(v=>Number(v)>0?Number(v):0),posMax=Math.max(...pos,1),posMin=pos.filter(v=>v>0),spanMin=posMin.length?Math.min(...posMin):0,span=(posMax&&spanMin)?(posMax/spanMin):1,gamma=Math.max(.35,Math.min(1,Math.pow(1/span,1/3)*1.6))||1;let s="";vals.forEach((v,i)=>{const raw=Number(v)>0?Number(v)/posMax:0,frac=Math.pow(raw,gamma),bh=Math.max(frac*(bottom-top),raw>0?.5:0),x=pl+i*slot+(slot-bw)/2,y=bottom-bh;s+=`<rect class="si-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="6" fill="${opt.fill||"color-mix(in srgb,var(--accent) 58%,transparent)"}" style="animation-delay:${(i*.018).toFixed(2)}s"></rect>`;});return `<svg viewBox="0 0 ${w} ${h}">${axis(vals,{w,h:ph,axisW,plotL:pl,plotR:pr,top,bottom,max,ticks:opt.ticks||8,format:opt.format||fmtTokens})}${s}${xAxis(vals.length,{plotL:pl,plotR:pr,bottom,h,labels:opt.xLabels,ticks:opt.xticks,bars:true})}</svg>`;}
// ── 横轴刻度 ──
// 密度优先：先算「标签不撞车」所需的最小像素间距（一 12.4px 的 "#200" 约 30px）
// 换成轮数步长，取这个最小步长打格子（等间隔，不挑整齐数），
// 首尾必留；末尾靠边对齐会和倒数第二个挤，就丢掉倒数第二个。
// 主刻度之间再补一条半格次级短线，不写字，让刻度尺能读到更细。
const TICK_PAD=6;
function tickPoints(n,pl,pr,opt={}){const last=Math.max(0,n-1),slot=!!opt.slot,fs=opt.fontSize||12.4,label=opt.label||(v=>'#'+(v+1));
  const span=n>1?(pr-pl)/(slot?n:n-1):0;
  const chars=Math.max(String(label(0)).length,String(label(last)).length);
  const minStepPx=chars*fs*.62+TICK_PAD;
  const stepTurns=span>0?Math.max(1,Math.ceil(minStepPx/span)):1;
  const at=v=>slot?pl+(v+.5)*span:pl+v*span;
  const box=v=>{const x=at(v),w=String(label(v)).length*fs*.62,anchor=v===0?'start':(v===last?'end':'middle'),ax=v===0?pl:(v===last?pr:x),left=anchor==='start'?ax:(anchor==='end'?ax-w:ax-w/2),right=anchor==='start'?ax+w:(anchor==='end'?ax:ax+w/2);return{v,x,anchor,ax,left,right};};
  const seq=[];for(let v=0;v<=last;v+=stepTurns)seq.push(v);if(seq[seq.length-1]!==last)seq.push(last);
  const keep=[];for(const v of seq){const b=box(v),p=keep[keep.length-1];if(p&&b.left<p.right+TICK_PAD){if(v===last){keep.pop();keep.push(b);}continue;}keep.push(b);}
  const sub=Math.max(1,Math.round(stepTurns/2)),majors=new Set(seq),minorX=[];
  for(let v=0;v<=last;v+=sub){if(majors.has(v))continue;minorX.push(at(v));}
  return {pts:keep,minors:minorX};}
/** 刻度渲染成 SVG：次级短线 → x 轴基线 → 主刻度短线 + 标签 */
function tickSvg(res,n,pl,pr,bottom,label){const minor=res.minors.map(x=>`<line class="grid-minor" x1="${x.toFixed(1)}" y1="${bottom}" x2="${x.toFixed(1)}" y2="${bottom+3}"/>`).join(''),base=`<line class="axis-line" x1="${pl}" y1="${bottom}" x2="${pr}" y2="${bottom}"/>`,major=res.pts.map(p=>`<line class="grid-line" x1="${p.x.toFixed(1)}" y1="${bottom}" x2="${p.x.toFixed(1)}" y2="${bottom+5}"/><text class="axis-text" x="${p.ax.toFixed(1)}" y="${bottom+15}" text-anchor="${p.anchor}">${label(p.v)}</text>`).join('');return minor+base+major;}
function scrollLines(series,opt={}){const n=Math.max(1,series[0]?.vals?.length||0),slotW=opt.slotW==null?26:opt.slotW,baseW=opt.baseW||640,w=Math.max(baseW,n*slotW+60),ph=opt.h||170,h=ph+14,pl=5,pr=w-6,top=12,bottom=ph-6,max=opt.yMax||Math.max(...series.flatMap(s=>s.vals),1)*1.1,Y=v=>bottom-(v/max)*(bottom-top);const paths=series.map((s,si)=>{const step=(pr-pl)/((n-1)||1),path=s.vals.map((v,i)=>`${i?'L':'M'}${(pl+i*step).toFixed(1)},${Y(v).toFixed(1)}`).join(''),area=path+` L${pl},${bottom} Z`;return (opt.area?`<path class="si-area" d="${area}" fill="${s.fill||'color-mix(in srgb,var(--accent) 8%,transparent)'}"/>`:'')+`<path class="si-line" pathLength="1" d="${path}" fill="none" stroke="${s.color||'var(--accent)'}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`;}).join('');let xlab='';if(opt.xLabels){xlab=tickSvg(tickPoints(n,pl,pr,{slot:false,label:opt.xLabels}),n,pl,pr,bottom,opt.xLabels);}return `<div class="scl-wrap"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="width:${w}px;height:${h}px">${paths}${xlab}</svg></div>`;}
/** 可横向滚动的堆叠柱图（详情里用）。y 轴由外部单独一列固定显示，这里只画绘图区本体，
 *  几何参数（pl/pr/top/bottom）与 scrollLines、scYaxis 保持一致，三张图才能对齐。 */
function scrollStack(rows,opt={}){const n=Math.max(1,rows.length),slotW=opt.slotW==null?26:opt.slotW,baseW=opt.baseW||640,w=Math.max(baseW,n*slotW+60),ph=opt.h||170,h=ph+14,pl=5,pr=w-6,top=12,bottom=ph-6,totals=rows.map(r=>(Number(r.a)||0)+(Number(r.b)||0)+(Number(r.c)||0)),max=opt.yMax||Math.max(...totals,1),slot=(pr-pl)/n,bw=Math.max(2,Math.min(14,slot*.62)),colors=STACK_BAR_COLORS;let s='';rows.forEach((r,i)=>{const x=pl+i*slot+(slot-bw)/2;let yb=bottom;['a','b','c'].forEach((k,ki)=>{const v=Number(r[k])||0;if(v<=0)return;const bh=v/max*(bottom-top);yb-=bh;s+=`<rect class="si-bar" x="${x.toFixed(1)}" y="${yb.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(.7,bh).toFixed(1)}" fill="${colors[ki]}" rx="1"/>`;});});let xlab='';if(opt.xLabels){xlab=tickSvg(tickPoints(n,pl,pr,{slot:true,label:opt.xLabels}),n,pl,pr,bottom,opt.xLabels);}return `<div class="scl-wrap"><svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="width:${w}px;height:${h}px">${s}${xlab}</svg></div>`;}
/** 详情弹层里的逐轮图：只画图，外面不再套一层卡片；y 轴单独一列固定，只滚绘图区 */
const DETAIL_PH=280;
function detailPlot(axisMax,axisOpt,body,dw,above){return `${above||''}<div class="w-detail-plot si-rise" style="--dw:${dw}px"><div class="sc-yaxis">${scYaxis(axisMax,{format:axisOpt.format,h:DETAIL_PH})}</div><div class="w-detail-scroll">${body}</div></div>`;}
function scYaxis(max,opt={}){const ph=opt.h||170,h=ph+14,top=12,bottom=ph-6;let o='';const n=Math.max(2,opt.ticks||8);Array.from({length:n},(_,i)=>i/(n-1)).forEach(p=>{const v=max*(1-p),y=top+p*(bottom-top);o+=`<line class="grid-line" x1="46" y1="${y}" x2="50" y2="${y}"/><text class="axis-text" x="46" y="${y+3}" text-anchor="end">${(opt.format||(v=>Math.round(v)))(v)}</text>`});return `<svg viewBox="0 0 50 ${h}">${o}</svg>`;}
const TOKEN_STACK_LEGEND=["输入（命中缓存）","输入（未命中缓存）","输出"];
const STACK_BAR_COLORS=["color-mix(in srgb,var(--accent) 72%,transparent)","color-mix(in srgb,var(--accent) 32%,transparent)","color-mix(in srgb,var(--si-amber) 62%,transparent)"];
/** 堆叠图的图例：单独渲染，便于放在图表卡片外面 */
function chartLegendHtml(legend){return `<div class="chart-legend">${(legend||[]).map((t,i)=>`<span class="cl-item"><i style="background:${STACK_BAR_COLORS[i%STACK_BAR_COLORS.length]}"></i>${esc(t)}</span>`).join("")}</div>`;}
function stack(rows,opt={}){const vals=rows.map(r=>r.a+r.b+r.c),w=opt.w||640,ph=opt.h||170,h=ph+18,axisW=42,pad=8,pl=axisW+pad,pr=w-pad,top=12,bottom=ph-8,max=Math.max(...vals,1)*1.08,slot=(pr-pl)/(rows.length||1),bw=Math.max(3,Math.min(12,slot*.62)),colors=STACK_BAR_COLORS;const posMax=Math.max(...vals,1),posMin=Math.min(...vals.filter(v=>v>0)),span=(posMax&&posMin)?posMax/posMin:1,gamma=Math.max(.35,Math.min(1,Math.pow(1/span,1/3)*1.6))||1;const lg=(opt.legend&&!opt.legendOutside)?chartLegendHtml(opt.legend):"";let s="";rows.forEach((r,i)=>{const tot=(Number(r.a)||0)+(Number(r.b)||0)+(Number(r.c)||0),totH=tot>0?Math.pow(tot/posMax,gamma)*(bottom-top):0;let yb=bottom;["a","b","c"].forEach((k,ki)=>{const v=Number(r[k])||0,bh=tot>0?totH*(v/tot):0,x=pl+i*slot+(slot-bw)/2,y=yb-bh;if(bh<=0)return;s+=`<rect class="si-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="6" fill="${colors[ki]}" style="animation-delay:${(i*.015+ki*.03).toFixed(2)}s"></rect>`;yb=y;});});return lg+`<svg viewBox="0 0 ${w} ${h}">${axis(vals,{w,h:ph,axisW,plotL:pl,plotR:pr,top,bottom,max,ticks:opt.ticks||5,format:fmtTokens})}${s}${xAxis(rows.length,{plotL:pl,plotR:pr,bottom,h,labels:opt.xLabels,ticks:opt.xticks,bars:true})}</svg>`;}
function donutChart(segs,{size=148,r=52,sw=15,center="–",sub="",gap=0}={}){const C=2*Math.PI*r,cx=size/2,cy=size/2,total=segs.reduce((s,x)=>s+(x.v||0),0)||1;let off=0,arcs="";segs.forEach(seg=>{const len=(seg.v/total)*C;const draw=Math.max(len-gap,0.01);arcs+=`<circle class="si-sect" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${draw.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-off+C).toFixed(2)}" style="--to:${(-off).toFixed(2)};animation-delay:${(off/C*.12).toFixed(2)}s"></circle>`;off+=len;});return `<div style="position:relative;width:${size}px;height:${size}px"><svg viewBox="0 0 ${size} ${size}" style="transform:rotate(-90deg);display:block;width:${size}px;height:${size}px"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="color-mix(in srgb,var(--text) 7%,transparent)" stroke-width="${sw}"/>${arcs}</svg><div class="ring-core" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:2px;box-sizing:border-box;padding:0 ${Math.max(2,Math.round(size*.14))}px"><strong style="font-size:${Math.max(10,Math.min(15,Math.round((size-Math.max(2,Math.round(size*.16))*2)/(Math.max(4,String(center).length)*0.66))))}px;line-height:1;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(center)}</strong><span>${esc(sub)}</span></div></div>`;}

/* ── 渲染 ── */
const state={view:"usage",page:"usage-overview",provider:"deepseek",stats:null,sessionStats:null,ledger:null,balance:null,sessions:null,totalCost:null,pricing:null,events:null};let usageHeatEnterPending=true,costHeatEnterPending=true,providerHeatEnterPending=true,tokHeatEnterPending=true,cacheHeatEnterPending=true,taskFanEnterPending=true;
// 上下文用量分级阀值（百分比）：超过 warn 转橘黄提醒，超过 crit 转红告警
const CTX_WARN_PCT=47,CTX_CRIT_PCT=80;
/** 会话切换时先把份额环的弧段顺时针扫回起点，等新数据到了再扫出去（像指针归零再指出）。 */
function retractShareRing(){
  try{
    const svg=document.querySelector('#wProviderShare .w-share-donut>svg');
    if(!svg)return;
    for(const c of Array.from(svg.querySelectorAll('.w-share-segment'))){
      const start=Number(c.dataset.start||0);
      // 顺时针转出：弧段沿圆周向前移出视野（offset 减 100），不是反向扫回
      const to=String((-start-100).toFixed(2));
      c.style.setProperty('--to',to);
      c.classList.remove('si-sect');
      void c.getBoundingClientRect();
      c.classList.add('si-sect');
      c.addEventListener('animationend',()=>{try{c.classList.remove('si-sect');c.setAttribute('stroke-dashoffset',to);}catch{}},{once:true});
    }
  }catch{}
}

/** 实时预览的份额环：同一供应商复用同一节点，只改弧段属性，让过渡真正跑起来。 */
function patchShareCard(host,segs,providerCount,providerNames){
  let card=host.querySelector('.w-share-card');
  if(!card){
    host.innerHTML='<div class="card w-share-card" data-detail="providers"><div class="w-share-title"><b>本会话供应商</b><small></small></div><div class="w-share-body"><div class="w-share-donut"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="w-share-track" cx="50" cy="50" r="40"></circle></svg></div><div class="w-share-legend"></div></div></div>';
    card=host.querySelector('.w-share-card');
  }
  if(!card)return;
  const small=card.querySelector('.w-share-title>small');
  const smallTxt=`${providerCount} 个供应商`;
  if(small&&small.textContent!==smallTxt)small.textContent=smallTxt;
  const svg=card.querySelector('.w-share-donut>svg');
  const legendBox=card.querySelector('.w-share-legend');
  if(!svg||!legendBox)return;
  const arcs=new Map();
  for(const c of Array.from(svg.querySelectorAll('.w-share-segment')))arcs.set(c.dataset.key,c);
  const legend=new Map();
  for(const el of Array.from(legendBox.querySelectorAll('.w-share-item')))legend.set(el.dataset.key,el);
  const keepA=new Set(),keepL=new Set();
  segs.forEach((seg,idx)=>{
    const key=String(seg.p.provider);
    const label=String(providerNames[seg.p.provider]||seg.p.provider);
    const len=Math.max(0,seg.pct-1.2);
    let c=arcs.get(key);
    const to=String((-seg.start).toFixed(2));
    c=c||null;
    const needSweep=!c||state.shareRingSweep;
    if(!c){
      c=document.createElementNS('http://www.w3.org/2000/svg','circle');
      c.setAttribute('class','w-share-segment');
      c.setAttribute('cx','50');c.setAttribute('cy','50');c.setAttribute('r','40');c.setAttribute('pathLength','100');
      c.dataset.key=key;
      svg.appendChild(c);
    }
    c.dataset.start=String(seg.start);
    keepA.add(key);
    c.setAttribute('stroke',seg.color);
    c.setAttribute('stroke-dasharray',`${len.toFixed(2)} ${(100-len).toFixed(2)}`);
    c.style.setProperty('--to',to);
    if(needSweep){
      // 复刻「今日输入构成」的入场：弧段从起点扫到目标角度；扫完摘类，后续变化改走过渡
      c.setAttribute('stroke-dashoffset',String((-seg.start+100).toFixed(2)));
      c.classList.remove('si-sect');
      void c.getBoundingClientRect();
      c.classList.add('si-sect');
      c.addEventListener('animationend',()=>{try{c.classList.remove('si-sect');c.setAttribute('stroke-dashoffset',to);}catch{}},{once:true});
    }else{
      c.setAttribute('stroke-dashoffset',to);
    }
    let li=legend.get(key);
    if(!li){li=document.createElement('div');li.className='w-share-item';li.dataset.key=key;li.innerHTML='<i></i><span></span>';li.style.setProperty('--legend-delay',(idx*0.07).toFixed(2)+'s');legendBox.appendChild(li);}
    keepL.add(key);
    const dot=li.querySelector('i'),sp=li.querySelector('span');
    if(dot)dot.style.background=seg.color;
    if(sp&&sp.textContent!==label)sp.textContent=label;
  });
  for(const [k,c] of arcs)if(!keepA.has(k))c.remove();
  for(const [k,el] of legend)if(!keepL.has(k))el.remove();
  state.shareRingSweep=false;
}

/** 实时预览的供应商列表：按 provider 复用节点，只更新文本。 */
function patchProviderList(host,rows){
  const existing=new Map();
  for(const el of Array.from(host.children)){const k=el.dataset&&el.dataset.provider;if(k)existing.set(k,el);}
  const keep=new Set();
  rows.forEach((row,idx)=>{
    let el=existing.get(row.key);
    if(!el){
      el=document.createElement('div');
      el.className='card w-provider';
      el.setAttribute('data-detail','provider');
      el.dataset.provider=row.key;
      el.innerHTML='<div class="w-provider-name"><strong></strong></div><div class="w-provider-cell"><span>Token</span><b></b></div><div class="w-provider-cell"><span>余额</span><b></b></div>';
      el.style.setProperty('--drill-delay',(idx*0.09).toFixed(2)+'s');
      host.appendChild(el);
    }
    keep.add(row.key);
    const name=el.querySelector('.w-provider-name>strong');
    if(name&&name.textContent!==row.label)name.textContent=row.label;
    const cells=el.querySelectorAll('.w-provider-cell>b');
    const tokTxt=fmtTokens(row.tokens||0);
    if(cells[0]&&cells[0].textContent!==tokTxt)cells[0].textContent=tokTxt;
    if(cells[1]){
      if(cells[1].textContent!==row.balance)cells[1].textContent=row.balance;
      cells[1].style.color=row.warning?'var(--warn)':'';
    }
    if(host.children[idx]!==el)host.insertBefore(el,host.children[idx]||null);
  });
  for(const [k,el] of existing){
    if(keep.has(k))continue;
    el.classList.add('retracting');
    el.addEventListener('animationend',()=>el.remove(),{once:true});
    setTimeout(()=>{try{el.remove();}catch{}},700);
  }
}

function renderWidget(){
  const st=state.stats;const bal=state.balance?.balances||[];
  const ctxPct=Math.max(0,Math.min(100,Number(st?.contextPercent)||0));
  const ring=$("#wRing");if(ring){ring.style.setProperty("--pct",String(ctxPct));
    ring.classList.toggle("lv-warn",ctxPct>CTX_WARN_PCT&&ctxPct<=CTX_CRIT_PCT);
    ring.classList.toggle("lv-crit",ctxPct>CTX_CRIT_PCT);}
  if(st){const s=$("#wTitle");if(s)s.textContent=st.title||"当前会话";const m=$("#wMeta");if(m)m.textContent=st.turns!=null?`第 ${st.turns} 轮`:"";}
  const ringV=$("#wRingVal");if(ringV)ringV.textContent=ctxPct.toFixed(0)+"%";
  const ringFill=$("#wRing .ring-progress");if(ringFill){ringFill.style.strokeDasharray=`${ctxPct.toFixed(1)} ${(100-ctxPct).toFixed(1)}`;ringFill.style.opacity=ctxPct>0?"1":"0";}
  const hitAvg=(()=>{const av=Number(st?.avgHitPercent);if(st?.avgHitPercent!=null&&Number.isFinite(av))return av;const se=(st?.series||[]).filter(s=>s.hit!=null);if(!se.length)return null;return se.reduce((a,s)=>a+Number(s.hit),0)/se.length;})();
  const last=st?.series?.length?st.series[st.series.length-1]:null;const set=(id,v)=>{const e=$(id);if(!e)return;const s=String(v);if(e.dataset.odValue===s&&(e.children.length||e.__odBusyUntil>performance.now()))return;e.textContent=s;};set("#wTokTotal",st?fmtFullTok(st.sessionTokens):"–");const wTokEl=document.getElementById("wTokTotal");if(wTokEl&&st)wTokEl.style.setProperty("--digits",String(fmtFullTok(st.sessionTokens).length));set("#wHitAvg",hitAvg!=null?fmtPct(hitAvg):"–");setHitClass($("#wHitAvg"),hitAvg);const cacheHit=Math.max(0,Number(st?.sumCacheRead)||0),cacheMiss=Math.max(0,Number(st?.sumInput)||0),outputTok=Math.max(0,(Number(st?.sumOutput)||0)+(Number(st?.sumReasoning)||0)),inputTok=cacheHit+cacheMiss,ioTotal=inputTok+outputTok||1,cacheTotal=cacheHit+cacheMiss||1,inputPct=inputTok/ioTotal*100,outputPct=outputTok/ioTotal*100,hitPct=cacheHit/cacheTotal*100,missPct=cacheMiss/cacheTotal*100;set("#wCompInputPct",inputPct.toFixed(1)+"%");set("#wCompOutputPct",outputPct.toFixed(1)+"%");set("#wCompHitPct",hitPct.toFixed(1)+"%");set("#wCompMissPct",missPct.toFixed(1)+"%");const inputBar=$("#wCompInputBar"),outputBar=$("#wCompOutputBar"),hitBar=$("#wCompHitBar"),missBar=$("#wCompMissBar");if(inputBar)inputBar.style.width=inputPct+"%";if(outputBar)outputBar.style.width=outputPct+"%";if(hitBar)hitBar.style.width=hitPct+"%";if(missBar)missBar.style.width=missPct+"%";const threshold=Math.round(Number(st?.compactThreshold||0.8)*100);const remTrack=$("#wRemTrack");if(remTrack)remTrack.style.width=ctxPct+"%";const thresholdMark=$("#wThresholdMark");if(thresholdMark)thresholdMark.style.left=threshold+"%";const thresholdLabel=$("#wThresholdLabel");if(thresholdLabel){thresholdLabel.style.left=threshold+"%";thresholdLabel.textContent=threshold+"%";}set("#wTokRound",last?fmtTokens(last.total):"–");set("#wCostRound",last?fmtCost(last.cost):"–");set("#wTurnsRound",st&&st.turns!=null?String(st.turns):"–");set("#wHitRound",last&&last.hit!=null?fmtPct(last.hit):"–");setHitClass($("#wHitRound"),last?.hit);set("#wCost",st?fmtCost(st.sessionCostCny):"–");set("#wWindow",st&&st.contextWindow!=null?`${fmtTokens(st.lastWindowTokens||0)} / ${fmtTokens(st.contextWindow)}`:"–");set("#wUsed",st?`已用 ${fmtTokens(st.lastWindowTokens||0)}`:"已用 –");set("#wRem",st&&st.remainingToCompact!=null?`距压缩 ${fmtTokens(st.remainingToCompact)}`:"距压缩 –");
  const providerNames={deepseek:"DeepSeek",moonshot:"Moonshot",mimo:"MiMo",zhipu:"智谱",agnes:"Agnes",openai:"OpenAI",gemini:"Gemini","openai-codex":"ChatGPT Plus / Pro","xai-oauth":"xAI Grok",xai:"xAI"};const colors=["var(--accent)","#9d5f4d","#4a6b4a","#8a78a8","#b58b4b"];const used=Array.isArray(st?.providers)&&st.providers.length?st.providers:[{provider:st?.provider||"unknown",tokens:st?.sessionTokens||0,turns:st?.turns||0,cost:st?.sessionCostCny}];const totalUsed=used.reduce((a,p)=>a+(Number(p.tokens)||0),0)||1;let angle=0;const segs=used.map((p,i)=>{const pct=(Number(p.tokens)||0)/totalUsed*100;const start=angle;angle+=pct;return {p,pct,start,end:angle,color:colors[i%colors.length]};});const shareCard=$("#wProviderShare");if(shareCard){patchShareCard(shareCard,segs,used.length,providerNames);}
  const usedProviderIds=new Set(used.map(p=>p.provider));const quotaItems=bal.filter(b=>usedProviderIds.has(b.provider)&&b?.status==="ok"&&(b.kind==="quota"||b.remainingPercent!=null));const quotaList=$("#wQuotaList");if(quotaList){if(!quotaItems.length){quotaList.innerHTML="";}else{const itemsHtml=quotaItems.map(q=>{const windows=Array.isArray(q.windows)&&q.windows.length?q.windows:[q];const limiting=windows.filter(Boolean).reduce((min,x)=>(x.remainingPercent??100)<(min.remainingPercent??100)?x:min,windows[0]||{});const remain=Math.max(0,Math.min(100,Number(limiting.remainingPercent??q.remainingPercent)||0)),usedPct=100-remain;return `<div class="card w-quota w-quota-item" data-detail="quota" data-provider="${esc(q.provider)}"><div class="row"><span>${esc(q.name||q.provider||"额度窗口")}</span><b>${remain.toFixed(0)}% 剩余</b></div><div class="w-quota-meta"><span>${esc(quotaWindowName(limiting))}</span><span>${esc(fmtResetAt(limiting.resetAt??q.resetAt))}</span></div><div class="w-quota-track"><i style="width:${remain}%"></i></div><div class="w-quota-foot"><span>已用 ${usedPct.toFixed(0)}%</span><span>剩余 ${remain.toFixed(0)}%</span></div></div>`;}).join("");quotaList.innerHTML=`<div class="card w-quota-group"><div class="w-qg-title"><b>额度窗口</b><small>${quotaItems.length} 家</small></div>${itemsHtml}</div>`;}}const wprov=$("#wProviders");if(wprov){const balMap=new Map(bal.map(b=>[b.provider,b]));patchProviderList(wprov,segs.map(s=>{const b=balMap.get(s.p.provider);const status=b?.status==="ok"?"正常":(b?.status||"不可查询");const balance=b?.status==="ok"?(b.summary||"–"):(b?.status==="no_key"?"未配置":"–");return {key:String(s.p.provider),label:String(providerNames[s.p.provider]||s.p.provider),tokens:s.p.tokens||0,balance:esc(balance),warning:status!=="正常"};}));}normalizeNumbers(root,true);}
const EV={range:"2h"};
async function loadEvents(){const hours=EV.range==="2h"?2:24;const r=await fetchJson("/api/events?hours="+hours+"&limit=300").catch(()=>null);if(r&&!r.error)state.events=r;}
function renderUsageOverview(){
  const lg=state.ledger,st=state.stats,tc=state.totalCost||{};
  const dayArr=Object.entries(lg?.days||{}).sort((a,b)=>a[0].localeCompare(b[0]));const dayKeys=dayArr.map(x=>x[0]);const maxT=Math.max(...dayArr.map(([,v])=>v.tokens||0),1);const days=dayArr.map(([d,v])=>({d:d.slice(5),l:Math.min(4,Math.round((v.tokens||0)/maxT*4))}));
  const $=document.querySelector.bind(document);
  const set=(id,v)=>{const e=$(id);if(!e)return;const s=String(v);if(e.dataset.odValue===s&&(e.children.length||e.__odBusyUntil>performance.now()))return;e.textContent=s;};
  // KPI
  const totalTok=Object.values(lg?.days||{}).reduce((a,d)=>a+(d.tokens||0),0);const totalCall=lg?.calls||0;const totalErr=lg?.errors||0;
  // 账本明细被宿主裁到最近一段，把覆盖起始日写出来，避免把「窗口内的和」读成「全部历史」
  const cov=lg?.coverage||null;const rngEl=document.getElementById('kTokRange');if(rngEl)rngEl.textContent=cov&&cov.firstDay?'记录自 '+cov.firstDay+' 起':'';
  set("#kTok",fmtFullTok(totalTok));const kTokEl=document.getElementById("kTok");if(kTokEl)kTokEl.style.setProperty("--digits",String(fmtFullTok(totalTok).length));fitHeroNumbers();set("#kCost",fmtCost(tc.totalCost));set("#kCall",String(totalCall));set("#kErr",totalErr?String(totalErr):"0");set("#kHit",lg?.tokens?.hitRate!=null?fmtPct(lg.tokens.hitRate*100):"–");setHitClass($("#kHit"),lg?.tokens?.hitRate!=null?lg.tokens.hitRate*100:null);
  // Token 构成区（输入 / 输出 / 缓存命中 / 未命中 / 命中率）
  const tk=lg?.tokens||{};const tkBox=$("#tokenBody");if(tkBox){const ti=tk.input||0,to=tk.output||0,th=tk.cacheHit||0;const segSum=Math.max(th+ti+to,1);const seg=[[th,"输入（命中缓存）","hit"],[ti,"输入（未命中缓存）","in"],[to,"输出","out"]];const hr=tk.hitRate!=null?(tk.hitRate*100).toFixed(1):"–";tkBox.innerHTML=`<div class="tok-comp"><div class="tok-track">${seg.map(([val,lab,cls])=>{const raw=val/segSum*100;if(raw<=0.05)return"";const pct=Math.max(3.5,Math.min(100,raw));return `<i class="t-${cls}" data-w="${pct.toFixed(2)}" style="width:0%" title="${lab} ${fmtTokens(val)}"></i>`;}).join("")}</div><div class="tok-legend"><span class="t-hit"><i></i>输入（命中缓存） <b>${fmtTokens(th)}</b></span><span class="t-in"><i></i>输入（未命中缓存） <b>${fmtTokens(ti)}</b></span><span class="t-out"><i></i>输出 <b>${fmtTokens(to)}</b></span><em>命中率 <b>${hr}%</b></em></div></div>`;requestAnimationFrame(()=>{tkBox.querySelectorAll(".tok-track i").forEach((el,i)=>setTimeout(()=>{el.style.width=el.dataset.w+"%";},i*70));});}
  // 日历热力图
  // 每日费用趋势（非累计）
  const costArr=Object.values(lg?.days||{}).map(d=>d.cost||0);const dayKeysAll=Object.keys(lg?.days||{});
  const bgBox=$("#budgetChart");const bgW=Math.max(320,Math.round(boxW(bgBox,640)-2));bgBox.innerHTML=line(costArr,{w:bgW,h:234,ticks:6,format:fmtCost,stroke:"var(--accent)",xLabels:i=>dayKeysAll[i]?.slice(5)||"",xticks:8});
  // 供应商 → 模型层级大卡（按时间范围）
  const rangePU=PROV.unit;const rp=lg?.rangeProviders?.[rangePU]||lg?.providers||{};const rm=lg?.rangeModels?.[rangePU]||lg?.models||{};
  const pprov=Object.entries(rp).sort((a,b)=>b[1].tokens-a[1].tokens).slice(0,6);
  const pMax=pprov.length?Math.max(...pprov.map(x=>x[1].tokens)):1;
  const tTree=$("#providerTree");if(tTree){const byProv={};for(const [mn,mv] of Object.entries(rm)){const pv=mv.provider||"unknown";(byProv[pv]=byProv[pv]||[]).push([mn,mv]);}tTree.innerHTML=pprov.length?pprov.map(([n,v])=>{const pct=Math.round(v.tokens/pMax*100);const provModels=(byProv[n]||[]).sort((a,b)=>b[1].tokens-a[1].tokens).slice(0,5);return `<div class="pvtree-group"><div class="pvtree-head"><b>${esc(n)}</b><span class="pvtree-tok">${fmtTokens(v.tokens)}</span></div><div class="track"><i style="width:${pct}%"></i></div><div class="pvtree-models">${provModels.length?provModels.map(([mn,mv])=>{const mpct=Math.round(mv.tokens/pMax*100);return `<div class="pvmodel"><span>${esc(mn)}</span><div class="track"><i style="width:${mpct}%"></i></div><b>${fmtTokens(mv.tokens)}</b></div>`;}).join(""):`<span class="pvmodel-empty">无模型</span>`}</div></div>`;}).join(""):`<div class="empty">暂无供应商数据</div>`;}
  // 今日消耗 Token
  const todayTxt=`今日 ${fmtDay(new Date()).slice(5).replace("-","/")}`;
  const todayBox=$("#todayStatsBody");if(todayBox){const todayKey=fmtDay(new Date());const td=lg?.days?.[todayKey]||{};const hitRate=td.hitRate!=null?(td.hitRate*100):null;todayBox.innerHTML=`<div class="today-stats"><div class="ts-main"><div class="ts-tok"><span>今日 Token 总量</span><b>${fmtTokens(td.tokens||0)}</b></div><div class="ts-hit"><span>今日缓存命中率</span><b${hitCls(hitRate)}>${hitRate!=null?fmtPct(hitRate):"–"}</b></div></div><div class="ts-mini"><div class="mini-card"><span>今日费用</span><b>${fmtCost(td.cost||0)}</b></div><div class="mini-card"><span>今日调用</span><b>${td.calls||0}${td.err?` <em style="color:var(--si-red);font-style:normal;font-size:10px">失败 ${td.err}</em>`:''}</b></div></div></div>`;}
  // 模型明细表
  const modelRows=Object.entries(tc.perModel||{}).sort((a,b)=>b[1]-a[1]);
  const tModel=$("#modelDetail");if(tModel){const modelList=Object.entries(lg?.models||{}).sort((a,b)=>(Number(b[1].cost)||0)-(Number(a[1].cost)||0));const mdHead='<div class="model-detail-head"><span>模型</span><span>调用</span><span>Token</span><span>命中率</span><span>今日</span><span>总计</span></div>';const maxTok=Math.max(...modelList.map(([,v])=>Number(v.tokens)||0),1);tModel.innerHTML=modelList.length?mdHead+modelList.map(([m,v])=>{const hr=v.hitRate!=null?(v.hitRate*100).toFixed(1)+'%':'–';const tm=Object(tc.todayModel||{})[m];const tk=Number(v.tokens)||0;const w=Math.max(2,Math.round(tk/maxTok*100));return `<div class="tr model-detail-row"><code class="md-name">${esc(m)}</code><code class="md-num">${v.calls||0}</code><code class="md-tok md-num"><i style="width:${w}%"></i><span>${fmtTokens(tk)}</span></code><code class="md-hit md-num${hitCls(v.hitRate*100)}">${hr}</code><code class="md-num">${tm!=null?fmtCost(tm):'–'}</code><b class="md-num">${fmtCost(v.cost||0)}</b></div>`;}).join(""):`<div class="empty">暂无模型数据</div>`;}
  // 事件时间线
  const evAll=[...(state.events?.entries||[]),...(state.events?.diags||[]).map(d=>({__diag:true,ts:d.ts,text:d.text}))].sort((a,b)=>(Date.parse(b.ts||"")||0)-(Date.parse(a.ts||"")||0));const evSpan=(EV.range==="2h"?2:24)*3600e3;const evCut=Date.now()-evSpan;const evs=evAll.filter(ev=>{const t=ev.ts?Date.parse(ev.ts):NaN;return !Number.isFinite(t)||t>=evCut;});
  const evSeg=$("#evRangeSeg");if(evSeg)syncSeg(evSeg,EV.range);const evLb=$("#evRangeLabel");if(evLb)evLb.textContent=(EV.range==="2h"?"近2h":"近24h")+(evs.length?" · "+evs.length+" 条":"");const tEv=$("#usageEvents");if(tEv){tEv.innerHTML=evs.length?evs.slice(0,50).map(ev=>{const tm=ev.ts?fmtHM(new Date(ev.ts)):"–";if(ev.__diag)return `<div class="tr event-row diag-row"><code>${tm}</code><div class="ev-body"><b class="ev-err">插件诊断</b><span>${esc(ev.text||"")}</span></div></div>`;const ok=ev.status==="ok";const toks=Number(ev.input||0)+Number(ev.output||0);const dms=ev.durationMs!=null?Number(ev.durationMs):null;const dur=dms!=null?`<span class="ev-dur">${dms>=1000?(dms/1000).toFixed(1)+"s":dms+"ms"}</span>`:"";const hr2=ev.hitRatio!=null?`<span class="ev-hr">命中 ${(ev.hitRatio*100).toFixed(0)}%</span>`:"";return `<div class="tr event-row"><code>${tm}</code><div class="ev-body"><b class="${ok?"":"ev-err"}">${esc(ev.model)}</b><span>${esc(ev.agentId)}${ev.subsystem&&ev.subsystem!=="other"?" · "+esc(ev.subsystem):""}</span></div>${dur}${hr2}<span class="ev-cost">${ev.cost!=null?fmtCost(ev.cost):"–"}</span><span class="ev-tok">${toks?fmtTokens(toks):""}</span></div>`;}).join(""):`<div class="empty">暂无调用记录</div>`;}
  // 来源分布
  const srcBox=$("#taskCat");if(srcBox){const subs=lg?.subsystems||{};const cn={utility:"工具",session:"会话",memory:"记忆",automation:"自动化",vision:"视觉",compaction:"压缩",subagent:"子代理",other:"其他"};const sArr=Object.entries(subs).sort((a,b)=>b[1].tokens-a[1].tokens),sMax=sArr.length?Math.max(...sArr.map(x=>x[1].tokens)):1;const barsHtml=sArr.map(([k,v])=>{const pct=Math.round(v.tokens/sMax*100),cnLab=cn[k]||k;return `<div class="src-row"><span>${esc(cnLab)}</span><div class="track"><i style="width:${pct}%"></i></div><b>${fmtTokens(v.tokens)}</b></div>`;}).join("");srcBox.innerHTML=sArr.length?barsHtml:`<div class="empty">暂无数据</div>`;}
  const pu=$("#provUnitSeg");if(pu)syncSeg(pu,PROV.unit);
}
/** 供应商行按 key 复用节点：已有的只更新属性与文本（让过渡生效），新增的才播入场动画，多余的移除。 */
function patchProviderRows(pb,rows){
  if(!rows.length){if(!pb.querySelector('.empty'))pb.innerHTML='<div class="empty">暂无供应商</div>';return;}
  const empty=pb.querySelector('.empty');if(empty)empty.remove();
  const existing=new Map();for(const el of Array.from(pb.children)){const k=el.dataset&&el.dataset.key;if(k)existing.set(k,el);}
  const keep=new Set();
  rows.forEach((row,idx)=>{
    let el=existing.get(row.key);
    if(!el){
      el=document.createElement('div');
      el.className='card w-detail-item si-rise';
      el.dataset.key=row.key;
      el.innerHTML='<div class="w-detail-item-head"><span></span><b></b></div><div class="w-detail-provider-bar"><i></i></div>';
      el.style.setProperty('--enter-delay',(idx*0.05).toFixed(2)+'s');
      pb.appendChild(el);
    }
    keep.add(row.key);
    const span=el.querySelector('.w-detail-item-head>span');
    const b=el.querySelector('.w-detail-item-head>b');
    const bar=el.querySelector('.w-detail-provider-bar>i');
    const label=String(row.label);
    if(span&&span.textContent!==label)span.textContent=label;
    const pctTxt=row.pct.toFixed(1)+'%';
    if(b&&b.textContent!==pctTxt)b.textContent=pctTxt;
    if(bar){bar.style.setProperty('--pct',Math.max(0,Math.min(100,row.pct)).toFixed(2)+'%');bar.style.setProperty('--bar',row.color);}
    if(pb.children[idx]!==el)pb.insertBefore(el,pb.children[idx]||null);
  });
  for(const [k,el] of existing)if(!keep.has(k))el.remove();
}

function renderUsageSession(){
  const st=state.sessionStats||state.stats;const $=document.querySelector.bind(document);if(!st||!st.series||!st.series.length){$("#sessionEmpty").innerHTML=`<div class="empty">当前会话暂无逐轮数据</div>`;return;}
  const ser=st.series;const totals=ser.map(s=>s.total||0);const costs=ser.map(s=>s.cost||0);let hitFill=null;const hits=ser.map(s=>{if(s.hit!=null)hitFill=Number(s.hit);return hitFill==null?0:hitFill;});
  const tokMax=Math.max(...totals,1e-9);$("#ctxY").innerHTML=scYaxis(tokMax,{format:fmtTokens,h:200});$("#ctxChart").innerHTML=scrollLines([{vals:totals,color:"var(--accent)",fill:"color-mix(in srgb,var(--accent) 10%,transparent)"}],{area:true,slotW:0,ticks:6,yMax:tokMax,h:200,baseW:boxW($("#ctxChart"),640),xLabels:i=>`#${i+1}`});
  const costSum=costs.reduce((a,c)=>a+(Number(c)||0),0);if(costSum<=0){const mdl=st.model||'';const prow=((state.pricing&&state.pricing.rows)||[]).find(r=>r.model===mdl);const unlisted=!prow||prow.status==='unlisted';$("#costY").innerHTML=scYaxis(0,{format:fmtCost,h:200});$("#costChart").innerHTML='<div class="empty">'+(unlisted?'模型 '+esc(mdl||'—')+' 价格未收录，费用暂无法计算':'本会话费用为 0'+(mdl?' · '+esc(mdl):''))+'</div>';}else{const costMax=Math.max(...costs,1e-9);$("#costY").innerHTML=scYaxis(costMax,{format:fmtCost,h:200});$("#costChart").innerHTML=scrollLines([{vals:costs,color:"var(--accent)",fill:"color-mix(in srgb,var(--accent) 10%,transparent)"}],{area:true,slotW:0,ticks:6,h:200,baseW:boxW($("#costChart"),640),yMax:costMax,xticks:8,xLabels:i=>`#${i+1}`});}const stackData=ser.map(s=>({a:s.cacheInc||0,b:s.input||0,c:s.output||0}));const stackMax=Math.max(...stackData.map(r=>r.a+r.b+r.c),1e-9);$("#stackY").innerHTML=scYaxis(stackMax,{format:fmtTokens,h:200});$("#stackLegend").innerHTML='<span style="--c:var(--si-amber)"><i></i>输入·命中缓存</span><span style="--c:var(--accent)"><i></i>输入·未命中</span><span style="--c:var(--green)"><i></i>输出</span>';$("#stackChart").innerHTML=scrollLines([{vals:stackData.map(r=>r.a),color:"var(--si-amber)"},{"vals":stackData.map(r=>r.b),color:"var(--accent)"},{vals:stackData.map(r=>r.c),color:"var(--green)"}],{slotW:0,ticks:6,yMax:stackMax,h:200,baseW:boxW($("#stackChart"),640),xLabels:i=>`#${i+1}`});
  $("#cacheY").innerHTML=scYaxis(100,{format:v=>v.toFixed(0)+"%",h:200});$("#cacheChart").innerHTML=scrollLines([{vals:hits,color:"var(--green)",fill:"color-mix(in srgb,var(--green) 10%,transparent)"}],{area:true,slotW:0,ticks:6,yMax:100,h:200,baseW:boxW($("#cacheChart"),640),xLabels:i=>`#${i+1}`});
  requestAnimationFrame(()=>{$$('.scroll-chart .chart-scroll').forEach(el=>{el.scrollLeft=el.scrollWidth-el.clientWidth;});});
  const cacheHit=Math.max(0,Number(st.sumCacheRead)||0),cacheMiss=Math.max(0,Number(st.sumInput)||0),outputTok=Math.max(0,(Number(st.sumOutput)||0)+(Number(st.sumReasoning)||0)),inputTok=cacheHit+cacheMiss,ioTotal=inputTok+outputTok||1,cacheTotal=cacheHit+cacheMiss||1,inputPct=inputTok/ioTotal*100,outputPct=outputTok/ioTotal*100,hitPct=cacheHit/cacheTotal*100,missPct=cacheMiss/cacheTotal*100;
  const set=(id,v)=>{const e=$(id);if(!e)return;const s=String(v);if(e.dataset.odValue===s&&(e.children.length||e.__odBusyUntil>performance.now()))return;e.textContent=s;};
  set("#sTok",fmtFullTok(st.sessionTokens));const sTokEl=document.getElementById("sTok");if(sTokEl)sTokEl.style.setProperty("--digits",String(fmtFullTok(st.sessionTokens).length));fitHeroNumbers();set("#sHit",hits.length?fmtPct(hits.reduce((a,b)=>a+b,0)/hits.length):"–");setHitClass($("#sHit"),hits.length?hits.reduce((a,b)=>a+b,0)/hits.length:null);set("#sCost",fmtCost(st.sessionCostCny));set("#sTurn",String(ser.length));set("#sCtx",fmtPct(st.contextPercent));
  set("#sInPct",inputPct.toFixed(1)+"%");set("#sOutPct",outputPct.toFixed(1)+"%");set("#sHitPct",hitPct.toFixed(1)+"%");set("#sMissPct",missPct.toFixed(1)+"%");
  const inBar=$("#sInBar"),outBar=$("#sOutBar"),hitBar=$("#sHitBar"),missBar=$("#sMissBar");if(inBar)inBar.style.width=inputPct+"%";if(outBar)outBar.style.width=outputPct+"%";if(hitBar)hitBar.style.width=hitPct+"%";if(missBar)missBar.style.width=missPct+"%";
  const providerNames={deepseek:"DeepSeek",moonshot:"Moonshot",mimo:"MiMo",zhipu:"智谱",agnes:"Agnes",openai:"OpenAI",gemini:"Gemini","openai-codex":"ChatGPT Plus / Pro","xai-oauth":"xAI Grok",xai:"xAI"};const provs=Array.isArray(st.providers)&&st.providers.length?st.providers:[{provider:st.provider||"unknown",tokens:st.sessionTokens||0,turns:st.turns||0,models:[]}];/* 卡片本体按「模型」排：把供应商聚合里带的模型维度展平（后端已给出每个供应商下各模型的 token） */const modelRows=[];for(const p of provs){const ms=Array.isArray(p.models)&&p.models.length?p.models:[{model:st.model||"unknown",tokens:Number(p.tokens)||0}];for(const m of ms)modelRows.push({key:"m:"+String(m.model||"unknown"),label:String(m.model||"unknown"),tokens:Number(m.tokens)||0});}modelRows.sort((a,b)=>b.tokens-a.tokens);const totalUsed=modelRows.reduce((a,m)=>a+(Number(m.tokens)||0),0)||1;const colors=["var(--accent)","#9d5f4d","#4a6b4a","#8a78a8","#b58b4b"];const pb=$("#sProviderBody");if(pb){patchProviderRows(pb,modelRows.map((m,i)=>({key:m.key,label:m.label,pct:(Number(m.tokens)||0)/totalUsed*100,color:colors[i%colors.length]})));}
}
// 会话页要看哪个会话：用户在下拉里手选过就锁定那个；否则跟随当前会话（state.stats.file）；都没有则取最新一个。
// 判定必须在「请求会话统计之前」完成，否则首屏会先渲染成无数据、下一轮轮询才补上，
// 签名随之变化、白跳一次（滚动结构退回纯文本、卡片高度变化）。
/* 会话列表只看未归档的：归档的留在档案里，不进工作台的下拉 */
function activeSessions(){return (state.sessions?.sessions||[]).filter(s=>!s.archived);}
/* 按本机时区分桶：今天 / 本周（以周一为界）/ 更早 */
function sessionGroupOf(ts){const t=Date.parse(ts||"")||0;if(!t)return "earlier";const now=new Date();const startDay=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();if(t>=startDay)return "today";const dow=(now.getDay()+6)%7;if(t>=startDay-dow*86400000)return "week";return "earlier";}
function resolveSessionPick(){const ss=activeSessions();const cur=state.userSelectedFile||state.stats?.file||state.activeFile;if(cur&&ss.some(s=>s.name===cur))return cur;/* 手选过的会话不因列表暂时缺项就被抢走：轮询把它改回列表头，会把会话切走并重播一遍入场动画 */if(state.userSelectedFile)return state.userSelectedFile;return ss[0]?.name||null;}
function sessionMenuItems(ss){const cur=state.userSelectedFile||state.stats?.file||state.activeFile;const groups=[["today","今天"],["week","本周"],["earlier","更早"]];const buckets=new Map(groups.map(([k])=>[k,[]]));for(const s of ss){(buckets.get(sessionGroupOf(s.mtime||s.modified))||buckets.get("earlier")).push(s);}let html="";for(const [key,label] of groups){const list=(buckets.get(key)||[]).slice().sort((a,b)=>(Date.parse(b.mtime||b.modified||0)||0)-(Date.parse(a.mtime||a.modified||0)||0));if(!list.length)continue;html+=`<div class="session-group">${label}</div>`+list.map(s=>{const on=cur&&s.name===cur;return `<div class="session-item${on?" active":""}" data-file="${esc(s.name)}"><div class="session-item-title">${esc(s.title||s.name)}</div>${s.model?`<div class="session-item-model">${esc(s.model)}</div>`:""}${s.turns?`<div class="session-item-meta">第 ${s.turns} 轮</div>`:""}</div>`;}).join("");}return html||`<div class="session-empty">暂无未归档会话</div>`;}
function renderUsageSessions(){const ss=activeSessions();const menu=$("#sessionMenu"),lab=$("#sessionTriggerLabel");if(!menu)return;if(!ss.length){menu.innerHTML=`<div class="session-empty">暂无会话</div>`;if(lab)lab.textContent="暂无会话";return;}const match=resolveSessionPick();state.userSelectedFile=match;menu.innerHTML=sessionMenuItems(ss);const ms=ss.find(s=>s.name===match);if(lab)lab.textContent=ms?(ms.title||ms.name):(match||"检测中…");menu.querySelectorAll(".session-item").forEach(it=>it.addEventListener("click",()=>{pickSession(it.dataset.file);}));}
function positionSessionMenu(){const m=$("#sessionMenu"),t=$("#sessionTrigger");if(!m||!t||m.hidden)return;const r=t.getBoundingClientRect();const vw=window.innerWidth||document.documentElement.clientWidth||0;const desired=Math.max(r.width,560);const w=Math.min(desired,vw-24);m.style.left=Math.round(r.left)+"px";m.style.top=Math.round(r.bottom+6)+"px";m.style.width=Math.round(w)+"px";}
function toggleSessionMenu(){const m=$("#sessionMenu"),drop=$("#sessionDrop"),t=$("#sessionTrigger");if(!m||!drop)return;if(!m.hidden){closeSessionMenu();return;}m.__siHome=drop;if(m.parentElement!==document.body)document.body.appendChild(m);m.hidden=false;requestAnimationFrame(()=>{positionSessionMenu();m.classList.add("open");if(t)t.classList.add("open");});}
function closeSessionMenu(){const m=$("#sessionMenu"),t=$("#sessionTrigger");if(m&&!m.hidden){m.classList.remove("open");m.hidden=true;const home=m.__siHome||$("#sessionDrop");if(home&&m.parentElement!==home)home.appendChild(m);m.style.left="";m.style.top="";m.style.width="";}if(t)t.classList.remove("open");}
function pickSession(file){if(!file){state.sessionStats=null;renderUsageSession();return;}state.userSelectedFile=file;state.manualPickAt=Date.now();lastRenderedSession=file;closeSessionMenu();const pg=document.getElementById('usage-session');if(pg)pg.classList.add('si-quiet');fetchJson("/api/stats?file="+encodeURIComponent(file)).then(r=>{if(pg)pg.classList.remove('si-quiet');if(state.userSelectedFile!==file)return;if(r&&!r.error){state.sessionStats=r;renderUsageSession();if(pg)requestAnimationFrame(()=>animateNumbers(pg));}}).catch(()=>{}).finally(()=>{requestAnimationFrame(()=>{if(pg)pg.classList.remove('si-quiet');});});renderUsageSessions();}
/* 延迟分布：按容器实测像素作图，viewBox 比例与容器一致，图正好填满卡片剩余高度 */
let latRO=null,latSig="";
function drawLatHist(){const box=document.getElementById("latHist");if(!box)return;const hAll=Math.round(box.clientHeight||0);if(hAll<160)return;const lat=state.ledger?.latency?.buckets||{};const lats=[lat.lt1||0,lat["1_3"]||0,lat["3_10"]||0,lat.gt10||0];const lmx=Math.max(...lats,1);const lnames=["<1s","1–3s","3–10s",">10s"];const fmtN=v=>String(Math.round(v));const w=Math.max(320,Math.round(box.clientWidth)||520);const sig=w+"x"+hAll+"|"+lats.join(",");if(sig===latSig)return;latSig=sig;box.innerHTML=bars(lats,{w,h:Math.max(150,hAll-18),format:fmtN,xLabels:i=>lnames[i],xticks:4,yMax:lmx*1.15,fill:"color-mix(in srgb,var(--accent) 58%,transparent)"});}
function watchLatHist(){const box=document.getElementById("latHist");if(!box)return;if(latRO)latRO.disconnect();latRO=new ResizeObserver(()=>drawLatHist());latRO.observe(box);}
// ── 图表宽度守卫 ──
// 按容器宽度作画的图表（逐轮图、每日趋势、供应商折线）在页面还没显示（display:none）时量到的是 0，
// 那时会退回 640 兜底宽度，等页面显示出来就成了一屏画不下、底下多出一条横向滚动条；
// 而进入会话页并不一定会重画（已选过会话时 setPage 直接返回），要等下一轮轮询才修正。
// 这里记住每次量到的真实宽度让它复用，并盯住这些容器：宽度一变化就按新宽度重画。
const boxWCache=new WeakMap();
function boxW(el,fallback){if(!el)return fallback;const w=Math.round(el.clientWidth||0);if(w>0){boxWCache.set(el,w);return w;}return boxWCache.get(el)||fallback;}
const CHART_GUARD=[{ids:["ctxChart","costChart","stackChart","cacheChart"],render:()=>renderUsageSession()},{ids:["budgetChart"],render:()=>renderUsageOverview()},{ids:["providerCostLine","providerCostHeat"],render:()=>renderProviderCostPanels()}];
let chartGuardRO=null,chartGuardTimer=0;const chartGuardPending=new Set();
function initChartWidthGuard(){if(surface!=="page"||typeof ResizeObserver==="undefined")return;if(chartGuardRO)chartGuardRO.disconnect();const owner=new Map(),seen=new Map();for(const g of CHART_GUARD){for(const id of g.ids){const el=document.getElementById(id);if(el){owner.set(el,g.render);seen.set(el,Math.round(el.clientWidth||0));}}}chartGuardRO=new ResizeObserver(entries=>{const now=[];for(const e of entries){const el=e.target,w=Math.round(el.clientWidth||0),was=seen.get(el);if(w<=0||w===was)continue;seen.set(el,w);const fn=owner.get(el);if(!fn)continue;if(was===0)now.push(fn);else chartGuardPending.add(fn);}for(const fn of now){try{fn();}catch{}}if(chartGuardPending.size){clearTimeout(chartGuardTimer);chartGuardTimer=setTimeout(()=>{const q=[...chartGuardPending];chartGuardPending.clear();for(const fn of q){try{fn();}catch{}}},80);}});owner.forEach((_,el)=>chartGuardRO.observe(el));}
function renderUsageDistribution(){
  const lg=state.ledger;const $=document.querySelector.bind(document);const lat=lg?.latency?.buckets||{};const lats=[lat.lt1||0,lat["1_3"]||0,lat["3_10"]||0,lat.gt10||0];
  drawLatHist();watchLatHist();
  const set=(id,v)=>{const e=$(id);if(!e)return;const s=String(v);if(e.dataset.odValue===s&&(e.children.length||e.__odBusyUntil>performance.now()))return;e.textContent=s;};set("#dP50",lg?.latency?.p50?fmtPct((lg.latency.p50/1000).toFixed(1)):"–");set("#dP95",lg?.latency?.p95?fmtPct((lg.latency.p95/1000).toFixed(1)):"–");
}
const NAME_CN={deepseek:"DeepSeek",moonshot:"Moonshot",mimo:"MiMo",zhipu:"智谱","zhipu-coding":"智谱 Coding",agnes:"Agnes",openai:"OpenAI",gemini:"Gemini","openai-codex":"ChatGPT Plus / Pro","xai-oauth":"xAI Grok",xai:"xAI",ollama:"Ollama",freetoken:"FreeToken"};
function renderApiOverview(){
  const bal=state.balance?.balances||[],unsup=state.balance?.unsupported||[],tc=state.totalCost||{};
  const $=document.querySelector.bind(document);const list=$("#providerList .provider-list");if(!list)return;
  // 配置即唯一真相源：卡片集合严格等于 HanaAgent 里真正启用的供应商（/api/providers）。
  // 余额适配器和「无官方接口」说明只用来补状态，不再单独产生卡片，避免删了配置还留幽灵卡。
  const cfgList=state.providers?.providers||[];
  const cfgName={};for(const p of cfgList){if(p.name)cfgName[p.id]=p.name;}
  // 配置即唯一真相源：总余额副行（订阅窗口用量、额度）也只在「宿主仍配着这个供应商」时出现。
  // 否则账本里的历史记录会把已经删掉的供应商（比如 Codex）一直挂在总余额下面。
  const cfgIds=new Set(cfgList.map(p=>p.id));
  // 本地部署的供应商（base_url 指向本机）单独一类：它们没有余额概念，灯用亮粉
  const isLocalUrl=u=>/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(String(u||""));
  const localIds=new Set(cfgList.filter(p=>p.local===true||isLocalUrl(p.baseUrl)).map(p=>p.id));
  const balMap=new Map(bal.map(b=>[b.provider,b]));
  const unsupMap=new Map(unsup.map(u=>[u.provider,u]));
  const full=cfgList.map(p=>{const id=p.id,b=balMap.get(id);if(b)return Object.assign({},b,{name:b.name||cfgName[id]||NAME_CN[id]||id});const u=unsupMap.get(id);if(u)return {provider:id,name:cfgName[id]||NAME_CN[id]||id,status:"unsupported",note:u.note,reachable:u.reachable===true,kind:"none",label:"说明"};return {provider:id,name:cfgName[id]||NAME_CN[id]||id,status:"no_adapter",kind:"none",label:"已配置"};});
  // 灯色分诊：绿=可正常读取，粉=本地部署，亮红=有门路但没读到，灰=无门路（不可得）。
  // 关键区分：reachable=true 的 unsupported 是「有接口但当前条件不满足」，算错误，不是「没有」。
  const isBad=b=>String(b.status).startsWith("http_")||b.status==="error"||b.status==="parse_failed"||b.status==="no_key"||(b.status==="unsupported"&&b.reachable===true);
  const toneOf=b=>b.status==="ok"?"ok":(localIds.has(b.provider)?"local":(isBad(b)?"err":"muted"));
  // 排序：绿 → 粉 → 红 → 灰，同色内部保持宿主配置顺序
  const toneOrder={ok:0,local:1,err:2,muted:3};
  full.sort((a,b)=>toneOrder[toneOf(a)]-toneOrder[toneOf(b)]);
  const okCount=full.filter(x=>toneOf(x)==="ok").length;
  const set=(id,v)=>{const e=$(id);if(!e)return;const s=String(v);if(e.dataset.odValue===s&&(e.children.length||e.__odBusyUntil>performance.now()))return;e.textContent=s;};
  set("#aProv",String(full.length));set("#aOk",String(okCount));
  set("#aErr",String(full.length-okCount));
  // 总体预览：总消耗 = 全部费用累计；总余额 = 同币种预付余额求和（不同币种不硬加，列在副行）
  set("#tCost",tc.totalCost!=null?fmtCost(tc.totalCost):"–");
  const totalTokens=Object.values(state.ledger?.days||{}).reduce((n,d)=>n+Number(d?.tokens||0),0);set("#tCostSub",totalTokens>0?fmtTokens(totalTokens):"–");
  const balItems=bal.filter(b=>b.status==="ok"&&b.kind==="balance"&&b.total!=null);
  const byCur={};balItems.forEach(b=>{const c=b.currency||"CNY";byCur[c]=(byCur[c]||0)+Number(b.total);});
  const curKeys=Object.keys(byCur);
  const primary=curKeys.includes("CNY")?"CNY":curKeys[0];
  const breakRows=balItems.map(b=>{const money=(b.currency==="USD"?"$":"¥")+Number(b.total).toFixed(2);return '<span class="bl-row"><i></i>'+esc(b.name||b.provider)+'<b>'+money+'</b></span>';});
  const quotaRows=bal.filter(b=>b.status==="ok"&&b.kind==="quota"&&cfgIds.has(b.provider)&&Number.isFinite(Number(b.remainingPercent))).map(b=>'<span class="bl-row"><i></i>'+esc(b.name||b.provider)+'<b>'+esc(b.summary||Number(b.remainingPercent).toFixed(0)+"%")+'</b></span>');
  const others=curKeys.filter(x=>x!==primary).map(x=>'<span class="bl-row"><i></i>'+esc(x)+'<b>'+byCur[x].toFixed(2)+'</b></span>');
  const modes=state.ledger?.billingModes||{},win=state.ledger?.providerWindows||{};
  // 订阅额度类（OAuth / Coding Plan）：钱花在包月上，官方又未必给配额接口，
  // 于是至少把窗口用量摆出来——近 5 小时与近 7 天的 token 与调用数。
  const subRows=Object.keys(modes).filter(id=>cfgIds.has(id)&&modes[id]==="subscription"&&!bal.some(b=>b.provider===id&&b.kind==="quota"&&b.status==="ok")).map(id=>{
    const w=win[id];if(!w)return '';
    const nm=cfgName[id]||NAME_CN[id]||id;
    const txt='5h '+fmtTokens(w.h5?.tokens||0)+' · 7d '+fmtTokens(w.d7?.tokens||0);
    return '<span class="bl-row"><i></i>'+esc(nm)+'<b>'+esc(txt)+'</b></span>';
  }).filter(Boolean);
  const balanceRows=breakRows.concat(others,quotaRows,subRows);const balanceEl=document.getElementById("tBalSub");
  if(primary){const sym=primary==="CNY"?"¥":"$";const balNum=byCur[primary];const w=Number(balNum);const tBalEl=document.getElementById("tBal");if(tBalEl){tBalEl.textContent=sym+balNum.toFixed(2);tBalEl.classList.remove("empty");}if(tBalEl)tBalEl.classList.toggle("low",primary==="CNY"&&Number.isFinite(w)&&w<10);if(balanceEl)balanceEl.innerHTML=balanceRows.join("")||'<span class="bl-row"><i></i>暂无可统计余额</span>';}
  else{const tb=document.getElementById("tBal");if(tb){tb.textContent="–";tb.classList.add("empty");}if(balanceEl)balanceEl.innerHTML=(quotaRows.concat(subRows).join(""))||'<span class="bl-row"><i></i>无可统计余额</span>';}
  const balTip=bal.filter(b=>b.status==="ok"&&b.kind==="balance"&&b.total!=null).map(b=>b.name+" "+b.summary).join(" · ");
  const tCost=document.getElementById("tCost");if(tCost&&balTip)tCost.title=balTip;
  renderPricingTable();
  renderCostBrief();
  renderCostPanel();
  renderSpendPanel();
  renderBalUpdated();
  
  const rl=state.rules||{};state.notifiedSet=state.notifiedSet||new Set();
  Object.entries(rl).forEach(([pid,r])=>{if(!r||!r.enabled)return;const b=bal.find(x=>x.provider===pid);if(!b||b.status!=="ok")return;const isBalance=b.kind==="balance";const current=isBalance?Number(b.total):Number(b.remainingPercent);const limit=isBalance?Number(r.amount??5):Number(r.pct??20);if(!Number.isFinite(current)||!Number.isFinite(limit))return;if(current<=limit&&!state.notifiedSet.has(pid)){state.notifiedSet.add(pid);const value=isBalance?((b.currency==="USD"?"$":"¥")+current.toFixed(2)):current.toFixed(0)+"%";const threshold=isBalance?((b.currency==="USD"?"$":"¥")+limit.toFixed(2)):limit.toFixed(0)+"%";hana.toast.show({message:(b.name||pid)+" 余额仅剩 "+value+"（阈值 "+threshold+"）"}).catch(()=>{});}});
  if(state.balance!==state.alertBalanceRef){state.alertBalanceRef=state.balance;state.failureCounts=state.failureCounts||{};state.failureNotified=state.failureNotified||new Set();Object.entries(rl).forEach(([pid,r])=>{if(!r||!r.enabled)return;const b=bal.find(x=>x.provider===pid);if(!b)return;const failed=b.status&&b.status!=="ok"&&b.status!=="no_key"&&b.status!=="unsupported";if(failed){state.failureCounts[pid]=(state.failureCounts[pid]||0)+1;if(state.failureCounts[pid]>=Number(r.fail||3)&&!state.failureNotified.has(pid)){state.failureNotified.add(pid);hana.toast.show({message:(b.name||pid)+" 连续更新失败 "+state.failureCounts[pid]+" 次"}).catch(()=>{});}}else{state.failureCounts[pid]=0;state.failureNotified.delete(pid);}});}

  if(!full.length){list.innerHTML='<div class="empty">'+(state.providersErr?'供应商配置读取失败，稍后自动重试':'宿主里还没有启用任何供应商')+'</div>';return;}
  const refreshing=state.refreshingProviders||new Set();
  list.innerHTML=full.map(b=>{
    const ok=b.status==='ok';
    const unsup=b.status==='unsupported';
    const noKey=b.status==='no_key';
    const noAdapter=b.status==='no_adapter';
    const tone=toneOf(b);
    const local=tone==='local';
    const bad=tone==='err';
    const pct=Number.isFinite(Number(b.remainingPercent))?Math.max(0,Math.min(100,Number(b.remainingPercent))):null;
    const statTxt=ok?'正常':local?'本地部署':(unsup?(b.reachable?'未查到':'无官方接口'):bad?'读取失败':(noAdapter?'无探测接口':(noKey?'凭据缺失':esc(String(b.status)))));
    const dotCls=tone;
    const val=ok?esc(b.summary||'–'):'–';
    const kindTxt=({balance:'预付余额',quota:'订阅配额',cost:'官方成本'})[b.kind]||(local?'本地模型':(noAdapter?'已配置':''))||'';
    const stateDesc=ok?'可检测余额与连接状态':local?'本地部署，没有可读取的余额接口':(unsup?esc(b.note||'无官方余额接口'):bad?'有余额接口，但本次读取失败':(noAdapter?'已配置，插件暂无该供应商的余额探测':(noKey?'凭证不完整，无法读取':'连接异常，暂时无法读取')));
    const busy=refreshing.has(b.provider);
    // 额度类：每个窗口一行（档位标签 + 剩余条 + 百分比）。窗口数量与档位完全跟着接口给的数据走，
    // 不给死磕 5h/7d：几分钟、几小时、几天、几月都能显示，卡高随行数自动变
    const wins=(b.kind==='quota'&&Array.isArray(b.windows)&&b.windows.length)?b.windows:[];
    const mainInfo=!ok?'':(wins.length
      ?'<div class="pv-wins">'+wins.map(w=>{
        const p=Math.max(0,Math.min(100,Number(w.remainingPercent??0)));
        const cls=p<15?'crit':(p<40?'low':'');
        return '<div class="pv-win"><span class="nm">'+esc(w.short||w.label||'额度')+'</span>'
          +'<span class="pvbar"><i class="'+cls+'" style="width:'+p.toFixed(0)+'%"></i></span>'
          +'<span class="pc'+(''+(cls?' '+cls:''))+'">'+p.toFixed(0)+'%</span></div>';
      }).join('')+'</div>'
      :'<b>'+val+'</b>'+(pct!=null?'<div class="track" title="剩余 '+pct.toFixed(0)+'%"><i style="width:'+pct.toFixed(0)+'%"></i></div>':''));
    return '<div class="card provider-item" data-provider="'+esc(b.provider)+'" title="点击查看供应商详情">'
      +'<div class="pv-main"><div class="pv-name"><strong>'+esc(b.name||b.provider)+'</strong><small>'+kindTxt+'</small></div><span class="pv-state-desc">'+stateDesc+'</span></div>'
      +'<div class="pv-tail" data-refresh="'+esc(b.provider)+'" title="点击刷新该供应商连接">'+(busy?'<i class="pv-pending"></i>':'<i class="pv-dot '+dotCls+'" title="'+statTxt+'"></i>')+'</div>'
      +'<div class="pv-info">'+mainInfo+'</div>'
      +'</div>';}).join('');
  // 卡片整批重建后，旧光晕元素连同引用一起作废；不清就会在鼠标不动时挂在卡片上不灭
  clearGlow();
}

const SPEND={mode:"line",unit:"day"};
function spendSyncHead(provider){const te=$("#spendTitle");if(te)te.textContent={day:"近 30 天费用",month:"按月费用",year:"按年费用"}[SPEND.unit];const se=$("#spendSub");if(se)se.textContent=provider?(SPEND.unit==="day"?"过去 30 日 · 单供应商账本":SPEND.unit==="month"?"按月聚合 · 单供应商账本":"按年聚合 · 单供应商账本"):(SPEND.unit==="day"?"过去 30 日 · 全局用量账本":SPEND.unit==="month"?"按月聚合 · 全局用量账本":"按年聚合 · 全局用量账本");syncSeg(document.getElementById("spendUnitSeg"),SPEND.unit);syncSeg(document.getElementById("spendModeSeg"),SPEND.mode);}
function spendData(source=state.ledger){const days=source?.days||{};const keys=Object.keys(days).sort();
if(SPEND.unit==="day"){const out=[];for(let i=29;i>=0;i--){const d=fmtDay(new Date(Date.now()-i*864e5));out.push([d.slice(5),Number(days[d]?.cost)||0]);}return out;}
if(SPEND.unit==="month"){if(!keys.length)return[];const map={};keys.forEach(k=>{const m=k.slice(0,7);map[m]=(map[m]||0)+Number(days[k]?.cost||0);});let cur=keys[0].slice(0,7);const endCur=fmtDay(new Date()).slice(0,7);const out=[];let guard=0;while(cur<=endCur&&guard<240){out.push([cur,map[cur]||0]);const parts=cur.split("-").map(Number);cur=parts[1]===12?(parts[0]+1)+"-01":parts[0]+"-"+String(parts[1]+1).padStart(2,"0");guard++;}return out.slice(-24);}
const ymap={};keys.forEach(k=>{const y=k.slice(0,4);ymap[y]=(ymap[y]||0)+Number(days[k]?.cost||0);});return Object.keys(ymap).sort().map(y=>[y,ymap[y]]);}
function renderSpendPanel(provider){const box=$("#providerSpend");if(!box)return;const source=provider?state.providerLedger:state.ledger;if(!source){box.innerHTML=provider?'<div class="empty">正在读取该供应商费用账本…</div>':'<div class="empty">账本不可用</div>';return;}const data=spendData(source);const max=Math.max(...data.map(x=>x[1]),1e-9);
if(SPEND.mode==="heat"){box.innerHTML='<div class="heat" style="grid-template-columns:repeat('+Math.min(Math.max(data.length,6),45)+',1fr)">'+data.map((d,di)=>'<i class="l'+Math.round(Math.min(4,d[1]/max*4))+'" style="--heat-delay:'+((di%14)*30)+'ms" title="'+esc(d[0])+' · '+fmtCost(d[1])+'"></i>').join("")+"</div>";}
else{box.innerHTML=line(data.map(d=>d[1]),{format:fmtCost,stroke:"var(--accent)",xLabels:i=>data[i]?data[i][0]:"",xticks:Math.min(9,data.length)});}
spendSyncHead(provider);}
function syncSeg(seg,val){if(!seg)return;const opts=[].slice.call(seg.querySelectorAll("[data-v]"));const idx=Math.max(0,opts.findIndex(o=>o.dataset.v===val));opts.forEach((o,i)=>o.classList.toggle("active",i===idx));const th=seg.querySelector(".seg-thumb");if(th){th.style.transform="translateX("+(idx*100)+"%)";}}
function flashSeg(seg){if(!seg)return;const th=seg.querySelector(".seg-thumb");if(!th)return;th.classList.remove("seg-flash");void th.offsetWidth;th.classList.add("seg-flash");}
const COST={unit:"hour",mode:"line"};
// 档位 → 数据点数：近 7 天 / 近 30 天从 day 序列尾部切
function heatGridStyle(n){return "";}
// 固定跨度档（近24h / 近7天 / 近30天）
const HEAT_SPAN={hour:24*3600e3,d7:7*86400e3,d30:30*86400e3};
// 格子刻度：0=90，100=现在
const HEAT_TICKS=[0,12.5,25,37.5,50,62.5,75,87.5,100];
// 把「倒数第 ago 格」换算成时刻。
// day 档浮动：一格一天，对齐本地 0 点（格数就是天数）
function heatAt(unit,N,ago){if(unit==="day"){const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-ago);return d;}const now=Math.floor(Date.now()/60000)*60000;return new Date(now-ago*(HEAT_SPAN[unit]/N));}
// 按档位给出可读标签：24h 档到分钟，其余到日期
function heatLabel(unit,N,ago){if(ago===0)return"现在";const d=heatAt(unit,N,ago);if(unit==="hour")return fmtDay(d)===fmtDay(new Date())?fmtHM(d):"昨天 "+fmtHM(d);return (d.getMonth()+1)+"/"+d.getDate();}
// 浮层专用：比刻度多带时分（按天档已是一整天，不带）
function heatTip(unit,N,ago){if(ago===0)return"现在";const d=heatAt(unit,N,ago);if(unit==="hour")return fmtDay(d)===fmtDay(new Date())?fmtHM(d):"昨天 "+fmtHM(d);const md=(d.getMonth()+1)+"/"+d.getDate();return unit==="day"?md:md+" "+fmtHM(d);}
// 单格时长（毫秒）
// 热力图格子的自绘浮层（替代原生 title）
const siTip=(()=>{let el=null,timer=0;
  const get=()=>{if(!el){el=document.createElement("div");el.className="si-tip";document.body.appendChild(el);}return el;};
  const show=(txt,x,y)=>{const e=get();e.textContent=txt;e.classList.add("on");const r=e.getBoundingClientRect();let left=x+14,top=y-r.height-12;if(left+r.width>innerWidth-8)left=innerWidth-8-r.width;if(left<8)left=8;if(top<8)top=y+18;e.style.left=left+"px";e.style.top=top+"px";};
  const hide=()=>{if(el)el.classList.remove("on");};
  const hit=t=>t&&t.closest?t.closest(".heat i[data-tip]"):null;
  document.addEventListener("mouseover",e=>{const c=hit(e.target);if(!c)return;clearTimeout(timer);timer=setTimeout(()=>{if(c.isConnected)show(c.dataset.tip,e.clientX,e.clientY);},70);});
  document.addEventListener("mouseout",e=>{if(!hit(e.target))return;clearTimeout(timer);hide();});
  window.addEventListener("scroll",hide,true);
  return{hide};
})();
function renderCostPanel(){const box=$("#costViz");if(!box)return;const tb=state.ledger?.timeBuckets||{};const N=256;const src=tb[COST.unit];const data=Array.isArray(src)?src.slice(-N):[];while(data.length<N)data.unshift(0);const last=N-1;const labels={hour:"小时",d7:"天",d30:"天",day:"天"};const title={hour:"近 24 小时费用",d7:"近 7 天费用",d30:"近 30 天费用",day:"近 100 天费用"};const label=ago=>heatLabel(COST.unit,N,ago);const costLevels=heatLevels(data);
if(COST.mode==="heat"){const animateHeat=costHeatEnterPending;costHeatEnterPending=false;const ticks=HEAT_TICKS;const tickHtml=ticks.map(t=>{const idx=Math.min(last,Math.round(t/100*last));const ago=last-idx;const lab=label(ago);const pos=t===0?4:t===100?96:t;const tr=t===0?"translateX(0)":t===100?"translateX(-100%)":"translateX(-50%)";return '<span class="tick-lab" style="position:absolute;left:'+pos+'%;transform:'+tr+'">'+lab+'</span>';}).join('');box.innerHTML='<div class="heat cost-heat'+(animateHeat?' heat-enter':'')+'" style="position:relative'+heatGridStyle(N)+'">'+data.map((v,i)=>{const ago=last-i;const tip=heatTip(COST.unit,N,ago);return '<i class="l'+heatLv(v,costLevels)+'" style="--heat-delay:'+((i%14)*30)+'ms" data-tip="'+tip+' · '+fmtCost(v)+'"></i>';}).join('')+"</div>"+'<div class="cost-ticks" style="position:relative;height:14px;margin-top:6px">'+tickHtml+'</div>';}else{const xl=i=>i===last?"现在":label(last-i);box.innerHTML=line(data,{w:860,h:210,format:fmtCost,stroke:"var(--accent)",xLabels:xl,xticks:9});}
const cm=$("#costModeSeg"),cu=$("#costUnitSeg");syncSeg(cm,COST.mode);syncSeg(cu,COST.unit);const wrap=$("#spendTitle");if(wrap&&wrap.closest("#api-overview"))wrap.textContent=title[COST.unit];}
const TOK={unit:"hour",mode:"line"};
const CACHE={unit:"hour",mode:"line"};
const PROV={unit:"hour"};
function renderTokenPanel(){const box=$("#tokViz");if(!box)return;const tb=state.ledger?.tokenBuckets||{},N=256,src=tb[TOK.unit],data=Array.isArray(src)?src.slice(-N):[];while(data.length<N)data.unshift(0);const last=N-1;const label=ago=>heatLabel(TOK.unit,N,ago),max=Math.max(...data,1e-9);const tokLevels=heatLevels(data);if(TOK.mode==="heat"){const animate=tokHeatEnterPending;tokHeatEnterPending=false;const ticks=HEAT_TICKS,tickHtml=ticks.map(t=>{const ago=last-Math.min(last,Math.round(t/100*last)),pos=t===0?4:t===100?96:t,tr=t===0?"translateX(0)":t===100?"translateX(-100%)":"translateX(-50%)";return '<span class="tick-lab" style="position:absolute;left:'+pos+'%;transform:'+tr+'">'+label(ago)+'</span>';}).join("");box.innerHTML='<div class="heat cost-heat'+(animate?" heat-enter":"")+'" style="position:relative'+heatGridStyle(N)+'">'+data.map((v,i)=>'<i class="l'+heatLv(v,tokLevels)+'" style="--heat-delay:'+((i%14)*30)+'ms" data-tip="'+heatTip(TOK.unit,N,last-i)+' · '+fmtTokens(v)+'"></i>').join("")+"</div>"+'<div class="cost-ticks" style="position:relative;height:14px;margin-top:6px">'+tickHtml+"</div>";}else{const xl=i=>i===last?"现在":label(last-i);box.innerHTML=line(data,{w:860,h:236,format:fmtTokens,stroke:"var(--accent)",fill:"color-mix(in srgb,var(--accent) 10%,transparent)",xLabels:xl,xticks:9});}syncSeg($("#tokModeSeg"),TOK.mode);syncSeg($("#tokUnitSeg"),TOK.unit);}function renderCachePanel(){const box=$("#cacheViz");if(!box)return;const tb=state.ledger?.cacheRateBuckets||{},N=256,src=tb[CACHE.unit],data=Array.isArray(src)?src.slice(-N):[];while(data.length<N)data.unshift(0);const last=N-1;const label=ago=>heatLabel(CACHE.unit,N,ago),max=Math.max(...data,1);const cacheLevels=heatLevels(data);if(CACHE.mode==="heat"){const animate=cacheHeatEnterPending;cacheHeatEnterPending=false;const ticks=HEAT_TICKS,tickHtml=ticks.map(t=>{const ago=last-Math.min(last,Math.round(t/100*last)),pos=t===0?4:t===100?96:t,tr=t===0?"translateX(0)":t===100?"translateX(-100%)":"translateX(-50%)";return '<span class="tick-lab" style="position:absolute;left:'+pos+'%;transform:'+tr+'">'+label(ago)+'</span>';}).join("");box.innerHTML='<div class="heat cost-heat'+(animate?' heat-enter':'')+'" style="position:relative'+heatGridStyle(N)+'">'+data.map((v,i)=>'<i class="l'+heatLv(v,cacheLevels)+'" style="--heat-delay:'+((i%14)*30)+'ms" data-tip="'+heatTip(CACHE.unit,N,last-i)+' · '+Number(v).toFixed(1)+'%"></i>').join("")+"</div>"+'<div class="cost-ticks" style="position:relative;height:14px;margin-top:6px">'+tickHtml+'</div>';}else{const xl=i=>i===last?"现在":label(last-i);box.innerHTML=line(data,{w:860,h:236,format:fmtPct,yMax:100,stroke:"var(--green)",fill:"color-mix(in srgb,var(--green) 10%,transparent)",xLabels:xl,xticks:9});}syncSeg($("#cacheModeSeg"),CACHE.mode);syncSeg($("#cacheUnitSeg"),CACHE.unit);}
const PROVIDER_COST={mode:"line",unit:"hour",view:"money"};
function renderProviderCostPanel(){const box=$("#providerSpend");if(!box)return;if(!state.providerLedger){box.innerHTML='<div class="empty">正在读取该供应商费用账本…</div>';return;}const tb=state.providerLedger.timeBuckets||{};const N=256;const src=tb[PROVIDER_COST.unit];const data=Array.isArray(src)?src.slice(-N):[];while(data.length<N)data.unshift(0);const last=N-1;const label=ago=>heatLabel(PROVIDER_COST.unit,N,ago);const max=Math.max(...data,1e-9);const provSpendLevels=heatLevels(data);if(PROVIDER_COST.mode==="heat"){const ticks=HEAT_TICKS,tickHtml=ticks.map(t=>{const ago=last-Math.min(last,Math.round(t/100*last));const pos=t===0?4:t===100?96:t,tr=t===0?"translateX(0)":t===100?"translateX(-100%)":"translateX(-50%)";return '<span class="tick-lab" style="position:absolute;left:'+pos+'%;transform:'+tr+'">'+label(ago)+'</span>';}).join("");box.innerHTML='<div class="heat cost-heat" style="position:relative'+heatGridStyle(N)+'">'+data.map((v,i)=>'<i class="l'+heatLv(v,provSpendLevels)+'" data-tip="'+heatTip(PROVIDER_COST.unit,N,last-i)+' · '+fmtCost(v)+'"></i>').join("")+"</div>"+'<div class="cost-ticks" style="position:relative;height:14px;margin-top:6px">'+tickHtml+"</div>";}else{const xl=i=>i===last?"现在":label(last-i);box.innerHTML=line(data,{w:860,h:210,format:fmtCost,stroke:"var(--accent)",xLabels:xl,xticks:9});}syncSeg(document.getElementById("providerCostModeSeg"),PROVIDER_COST.mode);syncSeg(document.getElementById("providerCostUnitSeg"),PROVIDER_COST.unit);}
function renderProviderCostPanels(){const lineBox=$("#providerCostLine"),heatBox=$("#providerCostHeat");if(!lineBox||!heatBox)return;if(!state.providerLedger){lineBox.innerHTML='<div class="empty">正在读取该供应商账本…</div>';heatBox.innerHTML='<div class="empty">正在读取该供应商账本…</div>';return;}
  // 没有余额查询门路的供应商（本地部署、官方无接口）改看 Token 消耗：账本里本来就有 tokenBuckets
  const tokenView=PROVIDER_COST.view==="token";const fmt=tokenView?fmtTokens:fmtCost;const tb=(tokenView?state.providerLedger.tokenBuckets:state.providerLedger.timeBuckets)||state.providerLedger.timeBuckets||{},N=256,src=tb[PROVIDER_COST.unit],data=Array.isArray(src)?src.slice(-N):[];while(data.length<N)data.unshift(0);const last=N-1;const label=ago=>heatLabel(PROVIDER_COST.unit,N,ago),max=Math.max(...data,1e-9);const provPanelsLevels=heatLevels(data);const pvCw=Math.round(boxW(lineBox,0)),pvW=pvCw>320?pvCw-2:640,pvH=Math.min(340,Math.max(180,Math.round(pvW*0.28)));lineBox.innerHTML=line(data,{w:pvW,h:pvH,format:fmt,stroke:"var(--accent)",xLabels:i=>i===last?"现在":label(last-i),xticks:9});const animateHeat=providerHeatEnterPending;providerHeatEnterPending=false;const ticks=HEAT_TICKS,tickHtml=ticks.map(t=>{const ago=last-Math.min(last,Math.round(t/100*last)),pos=t===0?4:t===100?96:t,tr=t===0?"translateX(0)":t===100?"translateX(-100%)":"translateX(-50%)";return '<span class="tick-lab" style="position:absolute;left:'+pos+'%;transform:'+tr+'">'+label(ago)+'</span>';}).join("");heatBox.innerHTML='<div class="heat cost-heat'+(animateHeat?' heat-enter':'')+'" style="position:relative'+heatGridStyle(N)+'">'+data.map((v,i)=>'<i class="l'+heatLv(v,provPanelsLevels)+'" style="--heat-delay:'+((i%14)*30)+'ms" data-tip="'+heatTip(PROVIDER_COST.unit,N,last-i)+' · '+fmt(v)+'"></i>').join("")+"</div>"+'<div class="cost-ticks" style="position:relative;height:14px;margin-top:6px">'+tickHtml+"</div>";syncSeg(document.getElementById("providerCostUnitSeg"),PROVIDER_COST.unit);}
function renderBalUpdated(){const el=document.getElementById("balUpdated");if(!el)return;const at=state.balance?.at;if(!at){el.textContent="";return;}const mins=Math.round((Date.now()-at)/60000);el.textContent="余额更新于 "+mins+" 分钟前";}
function renderCostBrief(){const box=$("#briefList");if(!box)return;const pr=state.pricing;if(!pr||!Array.isArray(pr.rows)||!pr.rows.length){box.innerHTML='<div class="brief-empty"><b>暂无计费规则</b><span>点击查看完整价格快讯</span></div>';return;}const groups=new Map();pr.rows.forEach(r=>{const pid=r.provider||"未分类";if(!groups.has(pid))groups.set(pid,{models:new Set(),max:0,priced:0});const g=groups.get(pid);g.models.add(r.model);const values=[Number(r.miss),Number(r.hit),Number(r.out)].filter(Number.isFinite);if(values.length){g.priced++;g.max=Math.max(g.max,...values);}});const nameOf=id=>{const b=(state.balance?.balances||[]).find(x=>x.provider===id);return b?.name||id;};const items=[...groups.entries()].sort((a,b)=>(b[1].priced>0)-(a[1].priced>0)||b[1].max-a[1].max);const sub=$("#costBrief .st-wrap em");if(sub)sub.textContent="按供应商 · 每百万 Token";box.innerHTML=items.slice(0,5).map(([pid,g],i)=>'<div class="brief-provider-row"><em class="brief-rank r'+(i+1)+'">'+(i+1)+'</em><strong>'+esc(nameOf(pid))+'</strong><span>'+g.models.size+' 个模型</span><b>'+ (g.priced?'最高 '+fmtCost(g.max):'待补齐价格') +'</b></div>').join('');}
// 列名只在表头出现一次，行里不再逐行重复；窄屏表头收起，改由每格自己的小标签顶着（CSS 里切）
const PRICE_HEAD='<div class="price-head-row"><div class="pr-model"><strong>模型</strong></div><div class="pr-cells price-grid"><span class="pr-cell"><em>未命中</em></span><span class="pr-cell"><em>命中</em></span><span class="pr-cell"><em>输出</em></span><span class="pr-cell source-col"><em>来源</em></span></div></div>';
function renderPricingTable(){const box=$("#pricingList");if(!box)return;const pr=state.pricing;if(!pr||!Array.isArray(pr.rows)||!pr.rows.length){box.innerHTML='<div class="empty">暂无计费规则</div>';return;}const groups=new Map();pr.rows.forEach(r=>{const pid=r.provider||"未分类";if(!groups.has(pid))groups.set(pid,{models:new Map()});const g=groups.get(pid);if(!g.models.has(r.model))g.models.set(r.model,{id:r.model,tiers:{},note:r.note||""});g.models.get(r.model).tiers[r.tier||"flat"]=r;});const nameOf=id=>{const b=(state.balance?.balances||[]).find(x=>x.provider===id);return b?.name||id;};const score=m=>Math.max(...Object.values(m.tiers).flatMap(r=>[Number(r.miss)||0,Number(r.hit)||0,Number(r.out)||0]));const groupScore=g=>Math.max(...[...g.models.values()].map(score));const groupHtml=[...groups.entries()].sort((a,b)=>groupScore(b[1])-groupScore(a[1])).map(([pid,g])=>{const models=[...g.models.values()].sort((a,b)=>score(b)-score(a)).map(m=>{const peak=m.tiers.peak||m.tiers.flat||m.tiers.offPeak||{},off=m.tiers.offPeak;const col=(key,label)=>'<span class="pr-cell price-col"><em>'+label+'</em><b>'+fmtCost(peak[key])+'</b>'+(off?'<small>谷时 '+fmtCost(off[key])+'</small>':'')+'</span>';return '<div class="model-cost-row" title="'+esc(m.note||"")+'"><div class="pr-model"><strong>'+esc(m.id)+'</strong></div><div class="pr-cells price-grid">'+col("miss","未命中")+col("hit","命中")+col("out","输出")+'<span class="pr-cell source-col"><em>来源</em><b>'+esc(m.note||"未标注")+'</b></span></div></div>';}).join('');return '<section class="price-group"><header class="price-group-head"><div><strong>'+esc(nameOf(pid))+'</strong><small>'+g.models.size+' 个模型</small></div><div class="group-cost"><b>按最高单价排序</b></div></header>'+PRICE_HEAD+models+'</section>';}).join('');box.innerHTML=groupHtml;const meta=$("#pricingMeta");if(meta)meta.textContent="价格单位：元 / 百万 Token · 计费库 "+(pr.db?(pr.db.ok?"云端":"内置快照（云端拉取失败）"):"—")+" · 配置快照 "+(pr.snapshotAt||"未知")+" · 按最高单价由高到低";}
function setLoading(on){const btn=document.getElementById("refreshBtn"),ic=document.getElementById("btnIc"),tx=document.getElementById("btnTx");if(!btn)return;btn.disabled=on;if(on){btn.classList.add("loading");if(ic){ic.textContent="↻";ic.classList.remove("done");}if(tx)tx.textContent="刷新中";}else{btn.classList.remove("loading");if(ic){ic.textContent="✓";ic.classList.add("done");}if(tx)tx.textContent="已刷新";setTimeout(()=>{if(ic&&!btn.classList.contains("loading")){ic.textContent="↻";ic.classList.remove("done");}if(tx&&!btn.classList.contains("loading"))tx.textContent="刷新";},1000);}}
// 打开外部链接：只走宿主的外部打开能力（交给系统默认浏览器）。
// 旧路径 /api/open 在 v2 App 里已降级为空操作（不能拉起外部进程），那条分支已移除。
function openExternal(url){const aFallback=()=>{try{const a=document.createElement("a");a.href=url;a.target="_blank";a.rel="noopener noreferrer";document.body.appendChild(a);a.click();a.remove();return true;}catch(e){return false;}};try{const p=hana.external?.open?hana.external.open({url}):null;if(p&&typeof p.then==="function"){p.catch(aFallback);}else if(!p){aFallback();}}catch(e){aFallback();}}
async function doRefresh(){usageHeatEnterPending=true;costHeatEnterPending=true;providerHeatEnterPending=true;tokHeatEnterPending=true;cacheHeatEnterPending=true;taskFanEnterPending=true;setLoading(true);try{await loadPage(true);state.userSelectedFile=null;await loadActiveSession();const f=state.activeFile;if(f){const r=await fetchJson("/api/stats?file="+encodeURIComponent(f)).catch(()=>null);if(r&&!r.error)state.sessionStats=r;renderUsageSession();renderUsageSessions();}requestAnimationFrame(()=>animateNumbers(root,true));}finally{setLoading(false);}}
function bindTopActions(){const rb=document.getElementById("refreshBtn");rb?.addEventListener("click",doRefresh);
  const ra=document.getElementById("refreshAllBtn");ra?.addEventListener("click",refreshAllProviders);
  const pulse=(b)=>b?.addEventListener("click",()=>{b.classList.remove("click-pulse");void b.offsetWidth;b.classList.add("click-pulse");setTimeout(()=>b.classList.remove("click-pulse"),480);});
  pulse(rb);}
setTimeout(bindTopActions,100);
function setVal(id,v){const e=document.querySelector(id);if(e)e.textContent=v;}
const QUICK_LINKS={deepseek:[["API Key","https://platform.deepseek.com"],["账单","https://platform.deepseek.com/usage"]],moonshot:[["API Key","https://platform.kimi.com"]],mimo:[["API Key","https://platform.xiaomimimo.com"]],zhipu:[["API Key","https://open.bigmodel.cn"],["控制台","https://open.bigmodel.cn/console"]],"openai-codex":[["控制台","https://chatgpt.com/codex"]],xai:[["控制台","https://console.x.ai"]],gemini:[["控制台","https://aistudio.google.com"]]};
function renderProviderModelRank(){const box=$("#providerModelRank");if(!box)return;const ledger=state.providerLedger?.provider===state.provider?state.providerLedger:null;if(!ledger){box.innerHTML='<div class="empty">正在读取该供应商用量…</div>';return;}const rows=Object.entries(ledger.models||{}).map(([model,v])=>({model,cost:Number(v?.cost)||0,calls:Number(v?.calls)||0})).sort((a,b)=>b.cost-a.cost||b.calls-a.calls);if(!rows.length){box.innerHTML='<div class="empty">暂无模型费用记录</div>';return;}const max=Math.max(...rows.map(x=>x.cost),1e-9);box.innerHTML=rows.map((x,i)=>'<div class="model-rank-row"><span class="model-rank-no">'+(i+1)+'</span><div class="model-rank-main"><strong title="'+esc(x.model)+'">'+esc(x.model)+'</strong><div class="track"><i style="width:'+(x.cost/max*100).toFixed(0)+'%"></i></div></div><b>'+fmtCost(x.cost)+'</b></div>').join('');}
function renderApiDetail(){
  const bal=state.balance?.balances||[],unsupported=state.balance?.unsupported||[];const cfg=((state.providers?.providers)||[]).find(p=>p.id===state.provider)||null;const hit=bal.find(b=>b.provider===state.provider)||unsupported.find(b=>b.provider===state.provider)||(cfg?{provider:cfg.id,name:cfg.name||NAME_CN[cfg.id]||cfg.id,status:"no_adapter",kind:"none"}:null)||bal[0]||unsupported[0];
  const nm=hit?.name||state.provider,val=hit?.summary||"–",k=hit?.kind||(hit?.status==="unsupported"?"unsupported":"balance");
  const stat=hit?(hit.status==="ok"?"正常":hit.status==="no_key"?"凭据缺失":hit.status==="unsupported"?"无官方接口":hit.status==="no_adapter"?"已配置":hit.note||"不可查询"):"不可查询";
  setVal("#pdTitle",(nm||"供应商")+" 详情");
  const providerLedger=state.providerLedger?.provider===state.provider?state.providerLedger:null;renderProviderModelRank();const providerTokens=providerLedger?Object.values(providerLedger.days||{}).reduce((n,d)=>n+Number(d?.tokens||0),0):0;// 本地部署的供应商没有余额可读，主位改看它的累计 Token（口径与供应商卡片那边一致）
  const isLocalCfg=!!(cfg&&(cfg.local===true||/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(String(cfg.baseUrl||""))));
  const statIsNote=!isLocalCfg&&!(hit&&hit.status==="ok");
  const balanceLabel=isLocalCfg?"累计 Token":(hit?.label||"可用余额");
  const statText=isLocalCfg?(providerTokens>0?fmtTokens(providerTokens):"–"):okStatText();
  const statsEl=$("#pdStats");
  // 额度类：与余额类同一套视觉——大数字（最紧的那一档）+ 逐窗口条，不用卡片底
  const quotaMain=(hit&&hit.kind==="quota"&&Array.isArray(hit.windows)&&hit.windows.length)?(()=>{
    const tight=hit.windows.reduce((m,w)=>(Number(w.remainingPercent??0)<Number(m.remainingPercent??0)?w:m),hit.windows[0]);
    const plan=hit.plan?'<em class="pd-plan">'+esc(hit.plan)+'</em>':'';
    const rows=hit.windows.map(w=>{
      const p=Math.max(0,Math.min(100,Number(w.remainingPercent??0)));
      const cls=p<15?"crit":(p<40?"low":"");
      return '<div class="pw-row"><span class="nm">'+esc(w.short||w.label||"额度")+'</span>'
        +'<span class="pwbar"><i'+(cls?' class="'+cls+'"':'')+' style="width:'+p.toFixed(0)+'%"></i></span>'
        +'<span class="pc'+(cls?' '+cls:'')+'">'+p.toFixed(0)+'%</span></div>';
    }).join("");
    return '<div class="provider-balance-main"><span>'+esc(hit.label||"套餐剩余")+plan+'</span><b>'+Number(tight.remainingPercent??0).toFixed(0)+'%</b></div>'
      +'<div class="provider-token-stat"><span>'+esc((tight.label||"额度")+"剩余")+'</span></div>'
      +'<div class="pd-wins">'+rows+'</div>';
  })():"";
  if(statsEl)statsEl.innerHTML=quotaMain||('<div class="provider-balance-main"><span>'+esc(balanceLabel)+'</span><b'+(statIsNote?' class="balance-note"':'')+'>'+esc(statText)+'</b></div>'+(!isLocalCfg&&providerTokens>0?'<div class="provider-token-stat"><span>累计 Token</span><b>'+esc(fmtTokens(providerTokens))+'</b></div>':''));
  function okStatText(){return hit?(hit.status==="ok"?(hit.summary||"正常"):stat):"不可查询";}
  const thR=(state.rules||{})[state.provider]||{};const isBalance=hit?.kind==="balance";const canThreshold=hit?.status==="ok"&&(isBalance?Number.isFinite(Number(hit.total)):Number.isFinite(Number(hit.remainingPercent)));
  const thE=$("#thEnabled"),thP=$("#thPct"),thF=$("#thFail"),thS=$("#thresholdSaveStatus"),thL=$("#thresholdLabel"),thU=$("#thresholdUnit");
  if(thL)thL.textContent=isBalance?"余额低于":"剩余低于";
  if(thU)thU.textContent=isBalance?(hit?.currency==="USD"?"美元":"元"):"%";
  if(thE){thE.checked=!!thR.enabled;thE.disabled=!canThreshold;}
  if(thP){thP.min="1";thP.max=isBalance?"100000":"95";thP.step="1";thP.value=isBalance?Math.max(1,Math.round(thR.amount!=null?thR.amount:5)):Math.max(1,Math.round(thR.pct!=null?thR.pct:20));thP.disabled=!canThreshold;}
  if(thF){thF.value=thR.fail!=null?thR.fail:3;thF.disabled=!canThreshold;}
  if(thS)thS.textContent=canThreshold?"已保存":"当前供应商暂无可检测余额";
  // 入口按钮：本地供应商给「启动应用」（拉本机 exe），其余给控制台链接；链接优先取后端目录，QUICK_LINKS 兜底
  const cfgEntry=(state.providers?.providers||[]).find(p=>p.id===state.provider)||null;
  // 下面两个图表：有余额/配额门路的看钱（不变），没有的改看 Token 消耗量（判定由后端下发 view 字段）
  const tokenView=cfgEntry?.view==="token";
  PROVIDER_COST.view=tokenView?"token":"money";
  const costHead=document.querySelector(".provider-cost-section .provider-cost-head h3");
  if(costHead)costHead.textContent=tokenView?"Token 消耗":"费用概览";
  const pdLinks=((cfgEntry&&Array.isArray(cfgEntry.links)&&cfgEntry.links.length)?cfgEntry.links:(QUICK_LINKS[state.provider]||[])).map(l=>Array.isArray(l)?{label:l[0],url:l[1]}:(l||{}));
  const quickHost=$("#pdQuick");
  if(quickHost){
    const pid=state.provider;
    quickHost.innerHTML=(pdLinks.length?'<button type="button" data-open="'+esc(pdLinks[0].url)+'" title="打开 '+esc(pdLinks[0].label||'官网')+'">↗</button>':'<button type="button" disabled title="暂无入口">↗</button>');
    renderLaunchHint(pid);
    // 是不是本地供应商、有没有可用的程序，由后端判（预设 → 用户指定），前端不猜
    hana.api.fetch("/api/local-providers",{signal:AbortSignal.timeout(15000)}).then(r=>r.json()).then(j=>{
      if(!j||!Array.isArray(j.providers))return;
      const lp=j.providers.find(x=>x.id===pid);
      if(!lp)return;
      const btn=document.createElement("button");
      btn.type="button";btn.className="pd-launch";btn.dataset.launch=pid;
      btn.textContent=lp.program?("启动 "+lp.name):"指定程序";
      btn.dataset.base=btn.textContent;
      btn.title=lp.program?lp.program:("未指定 "+lp.name+" 的程序，点击选择");
      quickHost.append(btn);
      if(!lp.program)return;
      fetchJson("/api/launch-provider?dry=1&provider="+encodeURIComponent(pid)).then(s=>{
        if(s&&s.running){btn.classList.add("running");btn.textContent="运行中";btn.title=(lp.name||pid)+" 已在运行，点击可重新检测";}
      }).catch(()=>{});
    }).catch(()=>{});
  }
  // 阀值提醒只对有余额门路的供应商有意义；本地部署这类没有余额可读，那块位置改看这个供应商的 Token 结构
  const thCard=document.querySelector("#api-detail .provider-threshold-card");
  if(thCard)thCard.hidden=tokenView;
  const dataCard=$("#pdDataCard");
  if(dataCard){
    dataCard.hidden=!tokenView;
    if(tokenView){
      const tk=(providerLedger&&providerLedger.tokens)||{};
      const hi=Number(tk.cacheHit)||0,mi=Number(tk.input)||0,ou=Number(tk.output)||0,sum=hi+mi+ou;
      const box=$("#pdDataRows");
      if(box){
        if(!sum){box.innerHTML='<div class="empty">暂无 Token 记录</div>';}
        else{
          // 三段构成条：命中输入 / 未命中输入 / 输出。最小 3% 保证极小占比也看得见。
          const w=v=>v>0?Math.max(3,Math.round(v/sum*1000)/10):0;
          box.innerHTML='<div class="pd-tok">'
            +'<div class="pd-tok-track"><i class="hit" style="width:'+w(hi)+'%"></i><i class="miss" style="width:'+w(mi)+'%"></i><i class="out" style="width:'+w(ou)+'%"></i></div>'
            +'<div class="pd-tok-legend">'
            +'<span class="hit"><i></i>命中输入<b>'+fmtTokens(hi)+'</b></span>'
            +'<span class="miss"><i></i>未命中输入<b>'+fmtTokens(mi)+'</b></span>'
            +'<span class="out"><i></i>输出<b>'+fmtTokens(ou)+'</b></span>'
            +'</div>'
            +'<div class="pd-tok-rate"><span>缓存命中率</span><b>'+(tk.hitRate!=null?fmtPct(tk.hitRate*100):'–')+'</b></div>'
            +'</div>';
        }
      }
    }
  }
  renderProviderCostPanels();
}
/* ── 本地供应商的启动按钮 ──
   程序在哪由后端定（默认安装目录优先，其次用户在设置里指定的），这里只管按钮状态与引导。
   面板会定时重绘，所以提示存在状态里、每次重绘按状态重新画，而不是只往 DOM 里塞一次。 */
const launchHints = new Map();

function renderLaunchHint(pid) {
  const head = document.querySelector("#api-detail .d-head");
  if (!head) return;
  const el = head.parentElement.querySelector(".pd-launch-hint");
  const text = launchHints.get(pid) || "";
  if (!text) {
    if (el) el.remove();
    return;
  }
  const box = el || document.createElement("div");
  box.className = "pd-launch-hint";
  box.textContent = text;
  if (!el) head.after(box);
}

function setLaunchHint(pid, text) {
  if (text) launchHints.set(pid, text);
  else launchHints.delete(pid);
  renderLaunchHint(pid);
}

/** 弹系统文件选择器指定程序，存进 App 配置；取消或失败返回 null */
async function chooseLocalProgram(pid) {
  let picked = null;
  try {
    const res = await hanaV2.resources.pick({ mode: "file" });
    const ref = res && Array.isArray(res.resources) ? res.resources[0] : null;
    picked = (ref && (ref.path || ref.localPath)) || null;
  } catch (error) {
    setLaunchHint(pid, "无法打开文件选择器：" + String(error?.message || error));
    return null;
  }
  if (!picked) return null; // 用户取消
  try {
    await hana.api.fetch("/api/local-program", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: pid, path: picked }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    setLaunchHint(pid, "程序路径保存失败：" + String(error?.message || error));
    return null;
  }
  return picked;
}

/** 点启动的完整流程：拉起 → 等端口 → 没起来就把原因和该去哪儿改摆出来 */
async function runLocalLaunch(pid, btn, baseLabel) {
  if (!btn || btn.classList.contains("loading")) return;
  const settle = (text, running, title) => {
    btn.classList.remove("loading");
    btn.classList.toggle("running", !!running);
    btn.textContent = text;
    btn.title = title || "";
  };
  btn.classList.add("loading");
  btn.textContent = "启动中…";

  let payload = null;
  try {
    const res = await hana.api.fetch("/api/launch-provider?provider=" + encodeURIComponent(pid), {
      signal: AbortSignal.timeout(30000),
    });
    payload = await res.json();
  } catch (error) {
    settle(baseLabel, false);
    setLaunchHint(pid, "启动请求失败：" + String(error?.message || error));
    return;
  }

  // 还没指定程序：弹选择器，指完接着启动
  if (payload && payload.code === "NOT_CONFIGURED") {
    settle(baseLabel, false);
    const picked = await chooseLocalProgram(pid);
    if (picked) await runLocalLaunch(pid, btn, baseLabel);
    return;
  }

  if (payload && payload.running) {
    setLaunchHint(pid, "");
    settle("运行中", true, baseLabel + " 正在运行");
    return;
  }
  if (payload && payload.started) {
    settle(baseLabel, false, payload.exe || "");
    // 已拉起但服务没就绪：把原因和该去哪儿改留在页面上（面板会重绘，所以存在状态里）
    setLaunchHint(pid, payload.hint || ("未能确认服务已就绪（已拉起 " + (payload.exe || "程序") + "）。请在设置中核对程序路径。"));
    return;
  }
  settle(baseLabel, false);
  setLaunchHint(pid, (payload && (payload.message || payload.code)) || "启动失败");
}

/* ── 数字转轮：纯数字文本逐位滚动到目标（与 v1.2 版同款效果） ── */
function odometer(el,target,instant){el.style.whiteSpace='nowrap';const str=String(target),digits=[],frag=document.createDocumentFragment();// 上下渐隐遮罩的形状写在 CSS 变量 --od-mask（panel-v2.css 的 :root）里，
  // 调深浅、换曲线都不用碰这段滚轮逻辑。两个前缀都要写：只写 mask-image 在旧内核上不生效。
  const MASK='-webkit-mask-image:var(--od-mask);mask-image:var(--od-mask)';const isD=ch=>ch>='0'&&ch<='9';
  // 父元素若有负字距，滚动盒的内容宽会比字符本身窄，数字右侧会被裁。
  // 用 padding 把宽度补回来，再用负 margin 抵消占位：水平间距和垂直位置都不变。
  const _lsPx=parseFloat(getComputedStyle(el).letterSpacing);const _lsFix=isFinite(_lsPx)&&_lsPx<0;
  // 右侧净空 = 抵消负字距被吃掉的那部分 + 一点墨迹余量。
  // 墨迹（字形实际占宽）会超出字宽，overflow:hidden 会按盒宽把它剃掉；
  // 这一点通过 CSS 变量 --od-pad-r 下发，由 CSS 用 padding-right 开盒、
  // 再用同值负 margin 抵消布局影响（字距与水平位置不变）。
  const _fsPx=parseFloat(getComputedStyle(el).fontSize)||16;
  const padFix=(( _lsFix?-_lsPx:0)+Math.max(1.5,_fsPx*0.05)).toFixed(2)+'px';
  const prevRaw=String(el.dataset.odValue||'');const prevNums=[...prevRaw].filter(isD);const tgtNums=[...str].filter(isD);let ni=0;for(const ch of str){if(isD(ch)){const to=parseInt(ch,10);const fromRight=tgtNums.length-1-ni;const pi=prevNums.length-1-fromRight;const from=pi>=0?parseInt(prevNums[pi],10):0;ni++;const od=document.createElement('span');od.className='od';od.dataset.odCh=ch;od.style.cssText='display:inline-block;position:relative;overflow:hidden;height:1em;line-height:1em;text-align:center;font-size:inherit;font-family:inherit;font-weight:inherit;color:inherit;--od-pad-r:'+padFix+';'+MASK;const strip=document.createElement('span');strip.className='od-strip';strip.style.cssText='display:block;will-change:transform';const hi=9;for(let i=0;i<=hi;i++){const c=document.createElement('span');c.className='od-d';c.style.cssText='display:block;height:1em;line-height:1em;text-align:center';c.textContent=String(i);strip.appendChild(c);}strip.style.transform='translateY('+(-from)+'em)';strip.dataset.odTo=String(to);od.appendChild(strip);digits.push({od,strip,from,to});frag.appendChild(od);}else{frag.appendChild(document.createTextNode(ch));}}el.textContent='';el.appendChild(frag);el.dataset.odValue=str;if(!digits.length)return;const dur=1000;el.__odBusyUntil=performance.now()+dur+780;alignNumbers(el);setTimeout(()=>{alignNumbers(el);requestAnimationFrame(()=>alignNumbers(el));},dur+200);digits.forEach(({od,strip,from,to})=>{if(instant){strip.style.transform='translateY('+(-to)+'em)';strip.style.willChange='';od.classList.add('od-done');return;}if(from===to){strip.style.transform='translateY('+(-to)+'em)';strip.style.willChange='';od.classList.add('od-done');setTimeout(()=>{strip.style.transform='translateY('+(-to)+'em)';strip.style.willChange='';od.classList.add('od-done');},dur+140);return;}let t0=null;const frame=now=>{if(t0===null)t0=now;const p=Math.min(1,(now-t0)/dur),ease=p<.5?4*p*p*p:1-Math.pow(-2*p+2,3)/2,v=from+(to-from)*ease;strip.style.transform='translateY('+Math.round(-v*_fsPx)+'px)';if(p<1)requestAnimationFrame(frame);else{strip.style.transform='translateY('+(-to)+'em)';strip.style.willChange='';od.classList.add('od-done');}};requestAnimationFrame(frame);setTimeout(()=>{strip.style.transform='translateY('+(-to)+'em)';strip.style.willChange='';od.classList.add('od-done');},dur+140);});}
// 页面被挂起（窗口失焦 / 后台）时 requestAnimationFrame 会被浏览器冻结，
// 滚动数字会停在半途，屏幕上就留下一串“上下被切、只露中间”的残缺数字。
// 恢复可见（或重新获得焦点）时，把所有没落到位的滚动条立即归位。
/* ── 数位宽度 ──
   每个滚动条里 0-9 全部就位，盒子宽度由内容自然撑开（即最宽数字的宽），
   任何字体下都不会把数字挤住或裁掉，也不需要额外测量字宽。 */
function settleOdometers(){let n=0;document.querySelectorAll('.od-strip[data-od-to]').forEach(s=>{const to=Number(s.dataset.odTo);if(!Number.isFinite(to))return;const m=/translateY\((-?[\d.]+)em\)/.exec(s.style.transform||'');if(m&&Math.abs(parseFloat(m[1])+to)<0.01)return;s.style.transform='translateY('+(-to)+'em)';s.style.willChange='';s.classList.add('od-done');n++;});return n;}
function watchOdometers(){document.addEventListener('visibilitychange',()=>{if(!document.hidden)settleOdometers();});window.addEventListener('focus',()=>settleOdometers());window.addEventListener('pageshow',()=>settleOdometers());
  // 失去焦点那一刻就要归位：窗口切走时 pending 的 rAF 会被丢弃，
  // 等回到前台才收尾就晚了，屏幕上会一直留着一串残缺数字。blur 是同步事件，不依赖帧。
  window.addEventListener('blur',()=>settleOdometers());
  // 字体真正加载完成后度量会变：若不重算，就会先按 fallback 字体对齐，过一两秒再跳一下。
  try{if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>alignNumbers());if(document.fonts&&document.fonts.addEventListener)document.fonts.addEventListener('loadingdone',()=>alignNumbers());}catch(e){}}
// ── 数字结构归一化 ──
// 容器重建后数字短暂变回纯文本，与滚动结构的字符间距不同，看起来就是“过了会儿跳一下”。
// 每次渲染后把所有纯数字文本立即转成静态滚动结构（不播动画），两种状态外观就一致了。
// ── 数字与单位对齐（实测补偿）──
// 滚动结构有 overflow:hidden，它的基线是盒底，而周围文字的基线在盒底上方一点，
// 所以盒内数字看起来就比旁边的单位“高”。而那个偏移量由字体决定（任何固定写法
// 都只在特定字体下成立），所以只能实测：把盒子先归零，量出“盒内当前数字的字形底部”
// 与“同字体同字号真实文本底部”的差，再按差补偿。
// 对齐需要知道“od 盒底相对其内部数字字形底高出多少”，即 1em 行框内“基线到框底”的距离。
// 该值 = halfLeading + descent，其中 halfLeading = (1em - (ascent+descent)) / 2。
// 优先用 canvas 直接读字体的 ascent/descent；拿不到再退回行内双元素实测。
function odDescentPx(el){try{const cs=getComputedStyle(el);const fs=parseFloat(cs.fontSize)||16;const ctx=odDescentPx._c||(odDescentPx._c=document.createElement('canvas').getContext('2d'));ctx.font=(cs.fontStyle||'normal')+' '+(cs.fontWeight||'400')+' '+(cs.fontSize||'16px')+' '+(cs.fontFamily||'monospace');const m=ctx.measureText('0');const a=m.fontBoundingBoxAscent,d=m.fontBoundingBoxDescent;if(typeof a==='number'&&typeof d==='number'&&a>0&&d>0){const v=(fs-(a+d))/2+d;if(v>0&&v<fs*0.4)return v;}}catch(e){}
  try{const cs=getComputedStyle(el);const base='font-family:'+cs.fontFamily+';font-size:'+cs.fontSize+';font-weight:'+cs.fontWeight+';font-style:'+cs.fontStyle+';';const t1=document.createElement('span');t1.textContent='0';t1.style.cssText=base+'line-height:1em;visibility:hidden;';const t2=document.createElement('span');t2.textContent='0';t2.style.cssText=base+'display:inline-block;overflow:hidden;height:1em;line-height:1em;visibility:hidden;';el.appendChild(t1);el.appendChild(t2);const r1=document.createRange();r1.selectNodeContents(t1);const b1=r1.getBoundingClientRect().bottom;const b2=t2.getBoundingClientRect().bottom;t1.remove();t2.remove();const fs=parseFloat(cs.fontSize)||16;const d=b1-b2;return isFinite(d)&&d>-1&&d<fs*0.4?d:0;}catch(e){return 0;}}
// 注意：不能用 vertical-align 补偿。od 是行内最高的元素，下移它会把行框基线一起拖下去，
// 旁边的文本跟着移动，补偿全被抵消（实测残差 42px 而补偿 19px，完全抵消）。
// transform 不参与布局计算，行框不动，平移量才是精确的。
// ── 数字与单位对齐（基线探针实测）──
// 逐位数字被放进 overflow:hidden 的 1em 盒子里；这种盒子的基线取「盒底」，
// 于是盒内数字相对本行基线整体偏移。偏多少由字体、字号、行高三者共同决定，
// 按字体度量推算的公式只能逼近 —— 实测仍差几个像素，数字于是在两种渲染状态间跳。
// 改成用「基线探针」直接量：探针 = 0 尺寸 + overflow:hidden 的 inline-block，
// 它的 bottom 就是它所在那一行的基线。分别放进①本行 ②某个数字块内部，
// 两个 bottom 之差就是数字相对本行的偏移，反号补偿（transform 不动布局，一次即准）。
function alignNumbers(rootEl){const R=rootEl||root;if(!R)return;R.querySelectorAll('.od').forEach(od=>{const el=od.parentElement;if(!el)return;
  // 行内流里 od 是 overflow:hidden 的 inline-block，基线取的是底边，所以要往下补一个 descent。
  // flex 容器里 od 只是个普通 flex item，由 align-items 居中，行内基线规则不参与，
  // 再叠这层补偿就会把数字压低、旁边的单位符号看着浮到数字上面。
  const dsp=getComputedStyle(el).display;
  if(dsp==='flex'||dsp==='inline-flex'){if(od.style.transform)od.style.transform='';el.classList.remove('od-host');return;}
  const d=odDescentPx(el);if(!(d>0))return;od.style.transform='translateY('+d.toFixed(2)+'px)';
  // 行内流场景下 od 会把这一行的行盒撑高（约 0.15em），锁住宿主自身高度，下方内容就不会被顶下去。
  el.classList.add('od-host');});}
function normalizeNumbers(rootEl,durMs){const R=rootEl||root;if(!R)return;R.querySelectorAll('b[id],strong[id]').forEach(el=>{if(el.closest('svg')||el.children.length)return;if(!el.getClientRects().length)return;const t=(el.textContent||'').trim();if(!isPlainNumber(t))return;
  // 刚从占位（–/空）变成数字：这一刻要播转轮进场动画。
  // 不然静默刷新路径会把它直接落位，看上去就是「–」原地跳成了数字。
  const fresh=!el.dataset.odValue;odometer(el,t,!(durMs>0||fresh),durMs||1000);});alignNumbers(R);}
function isPlainNumber(t){if(!t||t.length>20)return false;if(!/[0-9]/.test(t))return false;if(/[\u4e00-\u9fff]/.test(t))return false;if(/[A-Za-z]/.test(t.replace(/[kKmMbB]/g,'')))return false;return true;}
function animateNumbers(rootEl){if(!rootEl)return;rootEl.querySelectorAll('b,strong').forEach(el=>{if(el.closest('svg')||el.children.length)return;/* 当前轮详情头部是自己排版的，滚动动画会把数字换成绝对定位的数字条、内在宽度归零，把布局挤断 */if(el.closest('.w-turn-head'))return;if(!el.getClientRects().length)return;const t=(el.textContent||'').trim();if(!isPlainNumber(t))return;odometer(el,t);});alignNumbers(rootEl);}
let numEnter=true;
function playNumbers(){numEnter=false;requestAnimationFrame(()=>animateNumbers(root));}
function renderPageAll(quiet){renderUsageOverview();renderTokenPanel();renderCachePanel();renderUsageSession();renderUsageSessions();renderUsageDistribution();renderApiOverview();renderApiDetail();if(!quiet){playNumbers();requestAnimationFrame(()=>{try{document.querySelectorAll('.scroll-chart .chart-scroll').forEach(el=>{el.scrollLeft=el.scrollWidth;});}catch{}});}normalizeNumbers(root,quiet?420:1000);};function renderAll(){if(surface==="widget")renderWidget();else renderPageAll();}
let focusedFile=null;let activeSessionFile=null;let focusedEntryId=null;let focusedFileFailUntil=0;async function getFocusedSessionFile(){if(v2ActiveFile)return v2ActiveFile;if(Date.now()<focusedFileFailUntil)return focusedFile;try{const r=await fetch(hostApiUrl("/api/sessions/messages?limit=5"),{credentials:"include",signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error("focus "+r.status);const d=await r.json();const msg=(Array.isArray(d?.messages)?[...d.messages].reverse():[]).find(x=>typeof x?.entryId==="string"&&x.entryId.trim());const entryId=msg?.entryId?.trim()||null;if(entryId&&entryId===focusedEntryId&&focusedFile)return focusedFile;if(entryId){const mapped=await fetchJson("/api/resolve-entry?entryId="+encodeURIComponent(entryId));if(typeof mapped?.file==="string"&&mapped.file.endsWith(".jsonl")){focusedEntryId=entryId;focusedFile=mapped.file;focusedFileFailUntil=0;return focusedFile;}}}catch{}try{const active=await fetchJson("/api/active");if(typeof active?.file==="string"&&active.file.endsWith(".jsonl")){focusedFile=active.file;focusedFileFailUntil=0;return focusedFile;}}catch{}focusedFileFailUntil=Date.now()+5000;return focusedFile;}
let widgetRefreshSeq=0;/** 宿主关闭「窗口按钮独立置顶」时，那三个按钮会悬浮到卡片上、压住右上角的「实时」标签；
 *  这类模式下给卡片顶部右侧让出位置。开关打开（按钮独立）时不加，维持原样。 */
function applyHostAvoid(avoid){try{const w=root.querySelector('.widget');if(w)w.classList.toggle('avoid-host-buttons',avoid);}catch{}}
async function loadWidget(){const thisRefresh=++widgetRefreshSeq;const requestedFile=activeSessionFile;const switching=lastWidgetSession!==null&&requestedFile!==lastWidgetSession;if(switching){retractShareRing();state.shareRingSweep=true;}const statsPath=requestedFile?"/api/stats?file="+encodeURIComponent(requestedFile):"/api/stats";const [stats,balance,uiEnv]=await Promise.all([fetchJson(statsPath).catch(()=>null),fetchJson("/api/balance",12000).catch(()=>null),fetchJson("/api/ui-env").catch(()=>null)]);if(thisRefresh!==widgetRefreshSeq||requestedFile!==activeSessionFile)return;applyHostAvoid(uiEnv?.overlappingWindowButtons===true);state.stats=stats;state.balance=balance;const sessionChanged=requestedFile!==lastWidgetSession;if(sessionChanged)lastWidgetSession=requestedFile;paintQuiet(()=>renderWidget(),widgetBooted&&!sessionChanged);if(sessionChanged){requestAnimationFrame(()=>{try{animateNumbers(root);}catch{}});}widgetBooted=true;}
// ── 静默刷新机制 ──
// 轮询重绘不应该重播整页入场动画：静默模式下临时挂 .si-quiet（把 animation/transition 压到 0.001s），
// 数据完全没变时干脆不重绘；数值在没变时不会被重写，滚动结构得以保留，画面保持稳定。
function playSessionEnter(){try{for(const id of ['usage-session','usage-overview']){const el=document.getElementById(id);if(!el)continue;el.classList.remove('si-session-in');void el.offsetWidth;el.classList.add('si-session-in');}}catch{}}

let pageBooted=false,widgetBooted=false,lastFastSig=null,lastSlowSig=null;
// 会话切换要重播入场动画：记住上一次渲染的会话，变了就不走静默渲染
let lastRenderedSession=null,lastWidgetSession=null;
// ── KPI 每秒通道 ──
// 总览页顶部那六个数字（总量 / 起算日 / 命中率 / 总费用 / 调用数 / 异常）单独 1Hz 刷新，
// 其余数据仍走 10s 主轮询；服务端 /api/hero-stats 复用主轮询同一份缓存，不会把账本重算十遍。
// 规矩与轮询一致：不做入场动画，只在数值真变了才写 DOM（odometer 只在值变化时滚）。
function applyHeroStats(r){
  if(!r||r.error)return;
  const put=(id,v)=>{const e=document.getElementById(id);if(!e)return;const s=String(v);if(e.dataset.odValue===s&&(e.children.length||e.__odBusyUntil>performance.now()))return;e.textContent=s;};
  const tok=fmtFullTok(r.tokens);put("kTok",tok);
  const tokEl=document.getElementById("kTok");if(tokEl)tokEl.style.setProperty("--digits",String(tok.length));
  put("kCost",fmtCost(r.totalCost));put("kCall",String(r.calls||0));put("kErr",String(r.errors||0));
  const hit=r.hitRate!=null?Number(r.hitRate)*100:null;
  put("kHit",hit!=null?fmtPct(hit):"–");setHitClass(document.getElementById("kHit"),hit);
  const rngEl=document.getElementById("kTokRange");if(rngEl)rngEl.textContent=r.firstDay?"记录自 "+r.firstDay+" 起":"";
  normalizeNumbers(document.getElementById("usage-overview"),420);
}
let heroTickBusy=false;
async function pollHeroStats(){
  // 不再看 document.hidden：宿主 iframe 可能一直报 hidden，那会把这个每秒通道自己捻死
  // （主轮询本来就没这个守卫）。只跳“总览不是当前页”那种确实没必要刷的情况。
  if(heroTickBusy)return;
  if(state.view!=="usage"||state.page!=="usage-overview")return;
  heroTickBusy=true;
  try{applyHeroStats(await fetchJson("/api/hero-stats",4000));}catch{}finally{heroTickBusy=false;}
}
// ── 卡片的 token / 费用每秒跟一次（与 KPI 通道同一节奏）──
// 只更新那几个数字，不重绘整张卡；数据走 /api/stats?fast=1（会话级用量，单会话只有几百条，
// 服务端按 1.2 秒缓存放宽，所以 1Hz 不会把宿主读爆）。
function applyWidgetTotals(st){
  if(!st||st.error||!Array.isArray(st.series))return;
  const put=(id,v)=>{const e=document.getElementById(id);if(!e)return;const s=String(v);if(e.dataset.odValue===s&&(e.children.length||e.__odBusyUntil>performance.now()))return;e.textContent=s;};
  const tok=fmtFullTok(st.sessionTokens);put("wTokTotal",tok);
  const tkEl=document.getElementById("wTokTotal");if(tkEl)tkEl.style.setProperty("--digits",String(tok.length));
  put("wCost",fmtCost(st.sessionCostCny));
  const s2=st.series,hitAvg=s2.length?s2.reduce((a,x)=>a+(Number(x.hit)||0),0)/s2.length:null;
  put("wHitAvg",hitAvg!=null?fmtPct(hitAvg):"–");setHitClass(document.getElementById("wHitAvg"),hitAvg);
  normalizeNumbers(document.querySelector(".widget"),420);
  // 数字位数变了，内容需求跟着变，重判一次升/叠放
  try{syncWidgetGap();}catch(e){}
}
let wTotalsBusy=false;
async function pollWidgetTotals(){
  if(wTotalsBusy)return;
  wTotalsBusy=true;
  try{
    const f=activeSessionFile;
    applyWidgetTotals(await fetchJson(f?"/api/stats?fast=1&file="+encodeURIComponent(f):"/api/stats?fast=1",4000));
    // 数字变了，内容需求也跟着变（位数多的数字要更宽），重新判一次升/叠放
    syncWidgetGap();
  }catch{}finally{wTotalsBusy=false;}
}
// ── 升/叠放 + 间距：一律量成 px 写内联，过渡才生效 ──
// 为什么不能在 CSS 里直接过渡：百分比 margin 的 computed 值不会随容器宽度变化，
// 所以卡片拉宽时浏览器认为“值没变”，transition 永远不触发（实测两种触发方式都是瞬间到位）。
// 改成用 ResizeObserver 量出卡片宽度、换算成 px 写进内联样式，
// CSS 里的 transition:margin-left 就能真正跑起来（拖动时是柔和的跟随）。
//
// 排布（一排 / 叠放）也在这里决定：不拍“多少 px 就换行”这种跟内容无关的阈值，
// 而是算内容需求 need = 环宽 + 间距下限 + 数字实际宽度，卡片可用宽度小于 need 才叠放。
// 于是切换点会随数字位数自己动：数字短就可以更窄才换行，让右半部分一直贴到卡片右边缘。
// 回切留 6px 余量，免得在边界上反复翻。
function wTextW(el){if(!el)return 0;try{const r=document.createRange();r.selectNodeContents(el);return r.getBoundingClientRect().width||0;}catch(e){return el.scrollWidth||0;}}
// 数字变短时，真正卡住宽度的会是下排两个子格（它们的标题不折行），
// 所以内容需求取「上排数字」与「下排两子格」中更宽的那个，免得自然折行先发生、而叠放样式没跟上。
function widgetNeed(){
  const card=document.querySelector('.widget .ring-state');
  if(!card)return null;
  const ring=card.querySelector('.w-ring'),tok=card.querySelector('#wTokTotal'),cs=getComputedStyle(card);
  const padX=(parseFloat(cs.paddingLeft)||0)+(parseFloat(cs.paddingRight)||0);
  const avail=Math.max(0,card.clientWidth-padX);
  let textW=0;
  if(tok){const ods=tok.querySelectorAll('.od');
    if(ods.length){const a=ods[0].getBoundingClientRect(),b=ods[ods.length-1].getBoundingClientRect();textW=b.right-a.left;}
    else textW=wTextW(tok);}
  let subW=0;
  const side=card.querySelectorAll('.w-context-side>div');
  if(side.length>=2){for(const d of side){const s=d.querySelector('span'),b=d.querySelector('b');subW+=Math.max(wTextW(s),wTextW(b));}subW+=18;}
  const ringW=ring?ring.offsetWidth:104;
  return {avail,need:Math.round(ringW)+12+Math.round(Math.max(textW,subW))+10};
}
function syncWidgetGap(){
  if(surface!=='widget')return;
  const card=document.querySelector('.widget .ring-state');
  const data=card&&card.querySelector('.w-overview-data'),ring=card&&card.querySelector('.w-ring');
  if(!card||!data)return;
  const m=widgetNeed();if(!m)return;
  const wasStacked=card.dataset.stacked==='1';
  const stacked=wasStacked?m.avail<m.need+6:m.avail<m.need;
  const flip=stacked!==wasStacked;
  const before=flip&&ring?{r:ring.getBoundingClientRect(),d:data.getBoundingClientRect()}:null;
  if(flip)card.dataset.stacked=stacked?'1':'';
  // 间距：卡片越宽越松，斜率 20%、基线 -60px、下限 12px（与 CSS 里那套数值一致）
  const gap=stacked?0:Math.max(12,Math.round(m.avail*0.2-60));
  if(flip){ring.style.transition='none';data.style.transition='none';}
  data.style.marginLeft=gap+'px';
  if(flip&&before&&ring){
    // ── 横竖切换的过渡（FLIP）──
    // flex-direction 变了没法用 CSS 过渡，所以：先记下旧布局里两块的位置，
    // 改完排布强制重排拿到新位置，再把它们反推回旧位置（无过渡），下一帧过渡到新位置（transform 归零）。
    void card.offsetHeight;
    const a=ring.getBoundingClientRect(),b=data.getBoundingClientRect();
    const dx=Math.round(before.r.x-a.x),dy=Math.round(before.r.y-a.y);
    const ex=Math.round(before.d.x-b.x),ey=Math.round(before.d.y-b.y);
    if(dx||dy||ex||ey){
      try{
        ring.style.transform=`translate(${dx}px,${dy}px)`;
        data.style.transform=`translate(${ex}px,${ey}px)`;
        requestAnimationFrame(()=>{
          ring.style.transition='transform .34s cubic-bezier(.22,.72,.28,1)';
          data.style.transition='transform .34s cubic-bezier(.22,.72,.28,1)';
          ring.style.transform='';data.style.transform='';
          setTimeout(()=>{ring.style.transition='';data.style.transition='';},400);
        });
        flipCount++;
        try{window.__hanakoWidgetFlips=flipCount;}catch(e){}
      }catch(e){}
    }
  }
  wGapPrev={stacked};
}
let wGapPrev=null,flipCount=0;
function widgetFlipCount(){return flipCount;}
// 页面上大号数字：按位数在容器内自适应（位数多就缩小），保证它不会溢出自己那一栏。
// 会话页的 Token 用简写（如 345.55M），位数本来就不多，所以字号能保持在接近上限的大小。
// CSS 里那条 max/min + cqw 的规则实测未生效（同样声明写成内联则正确），所以直接在 JS 里写内联：
// 内联优先级最高，cqw 也已验证是按 .uh-tok 的宽度解析的。
// 会话页的命中率跟随 Token 用同一字号（对齐 CSS 注释里「同字号、底边对齐」的原意）。
// 位数取 --digits（渲染时写好的字符串长度）——不能用 textContent，滚动时里面是 0-9 的数字条。
/** 会话页：本会话 Token 写全位数，字号恒定：基准按 10 个字符的宽度定，位数不足则左对齐留白，
 *  超过基准才跟着缩（再长就顶到分割线了）。不按当位数反推字号，否则数字会随位数变大变小。
 *  字宽比不能假定 0.6em（实际在 0.5~0.62em 之间），所以用同一套字体量一次等宽数字的宽来定。 */
function tokCharEm(host){
  const probe=document.createElement('span');
  probe.style.cssText='position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-size:100px';
  probe.textContent='0000000000';
  host.appendChild(probe);
  const em=probe.getBoundingClientRect().width/(10*100);
  probe.remove();
  return em>0.2&&em<1.2?em:0;
}
function fitHeroNumbers(){
  if(surface==='widget')return;
  const fmt=el=>Math.max(1,Math.min(24,Number(el.style.getPropertyValue('--digits'))||8));
  const TOK_BASE=10;   // 字号基准的字符数：相当于「十万级数字」的长度
  const fitTok=el=>{
    if(!el)return;
    const basis=Math.max(TOK_BASE,Math.min(fmt(el),24));
    const box=el.closest('.uh-tok');
    const main=el.closest('.uh-main');
    el.style.fontSize='max(26px,min(84px,calc(160cqw/'+basis+')))';   // 量不到时的兜底
    const mw=main?Math.round(main.clientWidth||0):0;
    const half=mw>0?Math.max(60,(mw-61)/2):0;   // 两块平分时的宽度（中间是 30+1+30）
    const em=tokCharEm(el);
    if(half<=0||em<=0)return;
    // 字号按「10 个字符正好占满半行」定，之后不再随位数变化；1.005 是给舍入留的余量
    const px=Math.max(26,Math.min(140,half/(basis*em*1.005)));
    el.style.fontSize=px.toFixed(2)+'px';
    // 块宽跟着数字走：数字右边缘就是块右边缘，两侧到分割线的间隔因此相等
    const r=document.createRange();r.selectNodeContents(el);
    const w=Math.ceil(r.getBoundingClientRect().width);
    if(box&&w>0){box.style.flex='0 0 '+w+'px';box.style.width=w+'px';}
  };
  const tok=document.getElementById('sTok');
  fitTok(tok);
  if(tok){const hit=document.getElementById('sHit');if(hit){const v=getComputedStyle(tok).fontSize;if(v)hit.style.fontSize=v;}}
  const kTok=document.getElementById('kTok');
  if(kTok)kTok.style.fontSize='max(26px,min(84px,calc(160cqw/'+fmt(kTok)+')))';
}
let widgetGapRO=null;
function watchWidgetGap(){
  if(surface!=='widget'||typeof ResizeObserver==='undefined')return;
  const w=document.querySelector('.widget');if(!w)return;
  syncWidgetGap();
  if(widgetGapRO)widgetGapRO.disconnect();
  widgetGapRO=new ResizeObserver(()=>syncWidgetGap());
  widgetGapRO.observe(w);
}
function paintQuiet(fn,quiet){
  if(!quiet)return paintForce(fn);
  // 静默渲染：把这一次新插进来的节点标成静态，之后不再播入场动画。
  // 注意 MutationObserver 的回调是异步微任务，fn() 同步返回时它还没跑，
  // 必须用 takeRecords() 同步取回记录，否则收不到任何节点。
  const mo=new MutationObserver(()=>{});
  mo.observe(root,{childList:true,subtree:true});
  root.classList.add('si-quiet');
  try{fn();}catch(e){}
  const added=[];
  for(const m of mo.takeRecords())for(const n of m.addedNodes)if(n.nodeType===1)added.push(n);
  mo.disconnect();
  for(const el of added){try{el.classList.add('si-instant');}catch(e){}}
  requestAnimationFrame(()=>requestAnimationFrame(()=>root.classList.remove('si-quiet')));
}
// ── 数据签名（分快慢两组） ──
// 快组：本地账本与会话数据，首屏就能定。慢组：要联网的余额与计费库。
// 两组各记基准、各自判定。慢组数据落定时必须把基准补齐，否则下一轮算出的签名
// 会与「缺慢数据的首屏基准」不同，白白触发一次全量重绘（滚动结构退回纯文本、卡片高度变化）。
const SIG_DROP=/^(updatedAt|updated_at|checkedAt|fetchedAt|ts|time|at|now|elapsedMs|ageMs)$/;
function stableJson(o){try{return JSON.stringify(o,(k,v)=>SIG_DROP.test(k)?undefined:v)||'';}catch{return '';}}
function dataSig(){
  return [stableJson(state.ledger),stableJson(state.stats),stableJson(state.sessionStats),stableJson(state.totalCost),stableJson(state.sessions),stableJson(state.events)].join('|');
}
function slowSig(){return [stableJson(state.balance),stableJson(state.pricing)].join('|');}
let pageLoading=false;
async function loadPage(force){
  if(pageLoading)return;
  pageLoading=true;
  const q=force?"?force=1":"";
  // 快组：本地账本 / 会话数据，先出数字。
  // 会话统计不在这里发：它取决于「看哪个会话」，而那个判定要用到本次拿到的会话列表，所以排在 await 之后。
  const fast=[fetchJson("/api/stats").then(r=>state.stats=r).catch(()=>state.stats=null),fetchJson("/api/ledger-stats"+q).then(r=>state.ledger=r).catch(()=>state.ledger=null),fetchJson("/api/sessions").then(r=>state.sessions=r).catch(()=>state.sessions=null),fetchJson("/api/total-cost").then(r=>state.totalCost=r).catch(()=>state.totalCost=null),fetchJson("/api/rules").then(r=>state.rules=r).catch(()=>state.rules={}),fetchJson("/api/providers").then(r=>{state.providers=r;state.providersErr=false;pageProvSig=provSigOf(r);}).catch(()=>{state.providersErr=true;}),fetchJson("/api/events?hours="+(EV.range==="2h"?2:24)+"&limit=300").then(r=>state.events=r).catch(()=>state.events=null)];
  try{
    await Promise.all(fast);
    // 先定下会话页的数据源再拉它：手选优先，否则跟随当前会话（见 resolveSessionPick）。
    // 反过来「先拉后定」的话，首屏会先渲染成无逐轮数据、下一轮轮询才补上，签名因此变化、白跳一次。
    const sessPick=resolveSessionPick();
    const sessionChanged=Boolean(sessPick)&&sessPick!==lastRenderedSession;
    if(sessionChanged){lastRenderedSession=sessPick;if(realSwitch)playSessionEnter();}
    if(sessPick){state.userSelectedFile=sessPick;try{const r=await fetchJson("/api/stats?file="+encodeURIComponent(sessPick));state.sessionStats=(r&&!r.error)?r:null;}catch{state.sessionStats=null;}}
    else state.sessionStats=null;
    // 会话切过的时候不静默：让本会话那几张卡重播入场动画，而不是硬切
    // 但“首轮自己稳定”不算切换：刚启动时 pick 会从列表第一个/活跃会话漂到真实焦点会话一次，
    // 那不是用户动作。如果按切换处理，第一轮主轮询会把整页当成切换重播一遍完整入场动画（闪一下）。
    // 判据：只有用户手动选过（pickSession 里落的 manualPickAt）才算真切换。
    const realSwitch = sessionChanged && Date.now() - (state.manualPickAt || 0) < 20000;
    const quiet=!force&&pageBooted&&!realSwitch;
    // 非静默渲染（会重播完整入场动画）在启动之后不该再出现；出现就记一条，便于查。
    if(!quiet&&pageBooted)reportDiag("ui:enter-render","force="+force+" sessionChanged="+sessionChanged+" realSwitch="+realSwitch+" pick="+(sessPick||"-"));
    const sig=dataSig();
    // 先落 pageBooted 再渲染：渲染里任何一处抱错，不能让本函数永远回到“首次渲染”分支。
    // 否则每次轮询都走非静默路径、在同一处再抱，后面的慢组（余额/计费库）永远排不上，
    // 供应商区块就卡在首帧那个空态里再也不更新。
    pageBooted=true;
    if(!quiet||sig!==lastFastSig){lastFastSig=sig;paintQuiet(()=>renderPageAll(quiet),quiet);}
    // 慢组：带外部网络的余额 / 计费库，回来后静默补一次，不挡首屏。
    // 同样按签名判定，且无论渲不渲染都把基准补齐，避免下一轮出现一次多余的全量重绘。
    Promise.all([fetchJson("/api/balance"+q,12000).then(r=>state.balance=r).catch(()=>state.balance=null),fetchJson("/api/pricing").then(r=>state.pricing=r).catch(()=>state.pricing=null)]).then(()=>{const ss=slowSig();const dirty=!quiet||ss!==lastSlowSig;lastSlowSig=ss;if(dirty)paintQuiet(()=>{renderApiOverview();renderApiDetail();normalizeNumbers(root,0);},quiet);}).catch(()=>{}).finally(()=>{pageLoading=false;});
  }catch(e){pageLoading=false;}
}
async function saveRules(provider,payload){try{const r=await pluginApiFetch("/api/rules",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(Object.assign({provider},payload))});const j=await r.json().catch(()=>null);if(j&&j.ok&&state.rules){state.rules=Object.assign({},state.rules,{[provider]:j.saved});}return j;}catch(e){return null;}}
state.refreshingProviders=state.refreshingProviders||new Set();
async function refreshOneProvider(provider){if(!provider||state.refreshingProviders.has(provider))return;numEnter=true;providerHeatEnterPending=true;state.refreshingProviders.add(provider);renderApiOverview();try{const before=state.balance?JSON.stringify(state.balance.balances.find(b=>b.provider===provider)||{}):'';const r=await pluginApiFetch('/api/balance?force=1');const j=await r.json().catch(()=>null);if(j&&Array.isArray(j.balances)){state.balance=j;}}catch(e){diagFail("/api/balance?force=1（"+provider+"）",e);}finally{state.refreshingProviders.delete(provider);renderApiOverview();playNumbers();}}

async function refreshAllProviders(){numEnter=true;costHeatEnterPending=true;usageHeatEnterPending=true;providerHeatEnterPending=true;const btn=document.getElementById('refreshAllBtn');if(!btn||btn.classList.contains('loading'))return;const ic=document.getElementById('refreshAllIc'),tx=document.getElementById('refreshAllTx');btn.classList.add('loading');if(tx)tx.textContent='刷新中';try{const r=await pluginApiFetch('/api/balance?force=1');const j=await r.json().catch(()=>null);if(j&&Array.isArray(j.balances)){state.balance=j;state.refreshingProviders=new Set();}}catch(e){diagFail("/api/balance?force=1（整体刷新）",e);}finally{btn.classList.remove('loading');if(ic)ic.textContent='↻';if(tx)tx.textContent='整体刷新';renderApiOverview();playNumbers();}}
/* ── 恢复段：会话焦点 / 交互 / 详情组件 / shell / 启动 ── */
function sessionFileFromPath(value){if(typeof value!=="string"||!value.trim())return null;const name=value.trim().replace(/\\/g,"/").split("/").pop();return name&&name.endsWith(".jsonl")?name:null;}
function onHostContextSwitch(evt){if(evt.source!==window.parent)return;const msg=evt.data||{};if(msg.type!=="hana.host.context")return;const p=msg.payload||{};const next=sessionFileFromPath(p.sessionPath??p.path??p.file??p.sessionId);if(!next||next===activeSessionFile)return;activeSessionFile=next;focusedFile=next;focusedEntryId=null;focusedFileFailUntil=0;loadWidget();}
let focusSyncBusy=false;
async function syncFocusedSession(){if(focusSyncBusy||document.hidden)return;focusSyncBusy=true;try{const file=await getFocusedSessionFile();if(!file||file===activeSessionFile)return;activeSessionFile=file;await loadWidget();}finally{focusSyncBusy=false;}}

function setView(v){state.view=v;$$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.view===v));const navEl=document.querySelector('.nav');if(navEl)navEl.dataset.view=v;$$('.view').forEach(p=>p.classList.toggle('active',p.id==='view-'+v));}
async function loadActiveSession(){let file=null;/* 取「当前会话」的优先级：① 宿主 SDK 的当前会话（本地变量，零请求）→ ② 旧的 /api/active → ③ 已取到的 stats 文件。
   ② 要走宿主全量列会话，实测常年撞满超时（8s），只当兜底，并把超时压到 4s；正常情况下根本不会走到它。 */if(v2ActiveFile&&v2ActiveFile.endsWith(".jsonl"))file=v2ActiveFile;if(!file){try{const r=await fetchJson("/api/active",4000).catch(()=>null);if(r?.file)file=r.file;}catch{file=null;}}if(!file){const st=state.stats;if(st?.file)file=st.file;}if(file)state.activeFile=file;renderUsageSessions();}
function setPage(id,scope){if(scope==='usage')state.page=id;const view=document.getElementById('view-'+scope);if(!view)return;view.dataset.page=id;view.querySelectorAll('.subtab').forEach(b=>b.classList.toggle('active',b.dataset.page===id));view.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id===id));/* 切换页面属于“进场”场景：重渲染一次让图表与数字重播完整的入场动画（不同于轮询的就地更新） */requestAnimationFrame(()=>{try{renderPageAll(false);}catch(e){}});/* 会话页要等「看哪个会话」定下来才有数据：没数据时不先播一遍动画，等数据到位只播一次，避免进来播一遍、几秒后再播一遍 */const autoSession=id==='usage-session'&&!state.userSelectedFile;const sessionReady=autoSession&&!!state.sessionStats;(!autoSession||sessionReady)&&requestAnimationFrame(()=>animateNumbers(view));if(autoSession){(async()=>{reportDiag("ui:enter-session-page","pick="+(resolveSessionPick()||"-"));let f=resolveSessionPick();if(!f){await loadActiveSession();f=state.activeFile;}if(!f||state.userSelectedFile)return;state.userSelectedFile=f;lastRenderedSession=f;try{const r=await fetchJson('/api/stats?file='+encodeURIComponent(f));if(state.userSelectedFile!==f)return;if(!r||r.error)return;const first=!state.sessionStats;state.sessionStats=r;renderUsageSession();const pg=document.getElementById('usage-session');if(first&&!sessionReady){reportDiag("ui:session-page-data","file="+f);if(pg)requestAnimationFrame(()=>animateNumbers(pg));}}catch{}})();}}
function scrollTop(){try{const rootEl=document.querySelector('.shell')||root;if(rootEl)rootEl.scrollTop=0;document.documentElement.scrollTop=0;document.body.scrollTop=0;if(window.scrollTo)window.scrollTo(0,0);}catch(e){}}
function nav(view,page){setView(view);setPage(page,view);scrollTop();}
function showProvider(id){state.provider=id;state.providerLedger=null;numEnter=true;providerHeatEnterPending=true;$$('.provider-item').forEach(x=>x.classList.toggle('active',x.dataset.provider===id));renderApiDetail();nav('api','api-detail');fetchJson('/api/ledger-stats?provider='+encodeURIComponent(id)).then(r=>{if(state.provider===id){state.providerLedger=r;renderApiDetail();}}).catch(()=>{});}

function detailRows(rows,list=false){if(!rows.length)return'';const cls=list===true?' w-list':list==='pair'?' w-pair':list==='spaced'?' w-spaced':'';return `<div class="w-detail-grid${cls}">${rows.map(row=>{const [k,v,pct,color]=row,isArr=Array.isArray(v),disp=isArr?'':String(v??'–'),forceWide=row[2]===true||isArr,wide=(disp.length>18||forceWide)?' wide':'',hasBar=!isArr&&typeof pct==='number'&&Number.isFinite(pct);let body='';if(isArr){body=v.length?'<div class="m-list">'+v.map((m,i)=>{if(m&&typeof m==='object'){const pc=Math.max(0,Math.min(100,Number(m.pct)||0));return '<div class="m-entry" style="animation-delay:'+(.12+i*.04).toFixed(2)+'s"><div class="m-head"><code>'+esc(m.name||m.model||'未知模型')+'</code><b>'+pc.toFixed(1)+'%</b></div><div class="track"><i style="width:'+pc+'%"></i></div></div>';}return '<code>'+esc(String(m))+'</code>';}).join('')+'</div>':'<span class="empty">暂无调用记录</span>';}return `<div class="card w-detail-item${wide}${hasBar?' w-detail-provider-item':''} si-rise"><div class="w-detail-item-head"><span>${esc(k)}</span>${isArr?'':'<b>'+esc(disp)+'</b>'}</div>${body}${hasBar?`<div class="w-detail-provider-bar"><i style="--pct:${Math.max(0,Math.min(100,pct))}%;--bar:${color||'var(--accent)'}"></i></div>`:''}</div>`;}).join('')}</div>`;}
function detailMeter(pct,label,value,marker=null){const p=Math.max(0,Math.min(100,Number(pct)||0));return `<div class="card w-detail-visual si-rise"><div class="w-detail-vhead"><span>${esc(label)}</span><b>${esc(value)}</b></div><div class="w-detail-meter"><i style="width:${p}%"></i>${marker!=null?`<em style="left:${Math.max(0,Math.min(100,marker))}%"></em>`:''}</div></div>`;}
/** 上下文构成：只画已用部分的构成（系统提示词 / 对话内容），每项一行全宽长条，右侧是占比与实际量。
 *  系统提示词是估算值（宿主只给 systemPrompt 文本，不给 token 数），所以带 ~ 前缀。 */
function detailContextSplit(st){
  const used=Number(st?.lastWindowTokens)||0,raw=Number(st?.systemPromptTokens);
  if(!(used>0))return '';
  const sys=Number.isFinite(raw)?Math.max(0,Math.min(raw,used)):null;
  const conv=Math.max(0,used-(sys??0));
  const parts=[];
  if(sys!=null)parts.push({n:'系统提示词',v:sys,c:'linear-gradient(90deg,color-mix(in srgb,#8a78a8 62%,transparent),#8a78a8)',est:true});
  parts.push({n:'对话内容',v:conv,c:'linear-gradient(90deg,color-mix(in srgb,var(--accent) 55%,transparent),var(--accent))'});
  // 占比极小的项给个最小宽度，不然它在条上完全看不见（与详情里其他条同一套观感）
  const rows=parts.map(p=>{
    const pct=p.v/used*100;
    const w=p.v>0?Math.min(100,Math.max(0.6,pct)):0;
    return `<div class="w-ctx-row"><div class="h"><span>${esc(p.n)}</span><em>${pct.toFixed(1)}%</em><b>${p.est?'~':''}${fmtTokens(p.v)}</b></div><div class="w-detail-meter"><i style="width:${w.toFixed(2)}%;background:${p.c}"></i></div></div>`;
  }).join('');
  return `<div class="card w-detail-visual si-rise"><div class="w-detail-vhead"><span>上下文构成</span><b>已用 ${fmtTokens(used)}</b></div><div class="w-ctx-rows">${rows}</div></div>`;
}
function detailKpis(items){return `<div class="w-detail-kpis">${items.map(([k,v],i)=>`<div class="card si-rise" style="animation-delay:${(.08+i*.06).toFixed(2)}s"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`;}
/** 当前轮详情的头部：Token 最大座左，右侧轮次与费用两项 */
function detailTurnHead(last,turns){return `<div class="card w-detail-visual si-rise w-turn-head"><div class="w-turn-main"><span>当前轮 Token</span><b>${fmtTokens(last.total)}</b></div><div class="w-turn-side"><div class="w-turn-kpi"><span>轮次</span><b>${esc(String(turns??'–'))}</b></div><div class="w-turn-kpi"><span>费用</span><b>${fmtCost(last.cost)}</b></div><div class="w-turn-kpi"><span>命中率</span><b>${fmtPct(last.hit)}</b></div></div></div>`;}
/** 并列的两张构成卡（输入/输出、命中/未命中）；窄了自动变成一列 */
function detailPairs(cards){return `<div class="w-detail-pairs">${cards.join('')}</div>`;}
/**
 * 当前轮详情头部：宽度够（大号数字 + 右侧三项能并排）就用一行，不够保持两行。
 * 宽度自己算：这几个元素作为 flex 子项时自动基准会被算成整行宽度，交给浏览器判断会永远换行。
 */
function layoutTurnHead(){
  const head=document.querySelector('#wDetailBody .w-turn-head');
  if(!head)return;
  const main=head.querySelector('.w-turn-main'),side=head.querySelector('.w-turn-side');
  if(!main||!side)return;
  head.classList.remove('inline');
  main.style.flex='';side.style.flex='';
  const cs=getComputedStyle(head);
  const avail=head.clientWidth-parseFloat(cs.paddingLeft||0)-parseFloat(cs.paddingRight||0);
  // 文字宽度要用 Range 量：像大号数字那种在网格里会被拉伸的块，元素框宽等于容器宽，量出来不准
  const textW=el=>{if(!el)return 0;const r=document.createRange();r.selectNodeContents(el);return r.getBoundingClientRect().width;};
  const mainW=Math.max(textW(main.querySelector('b')),textW(main.querySelector('span')));
  // 右侧三项也按内容宽度算：两行布局下它们是平分宽度的格子，框宽不等于内容宽
  const sideW=[...side.children].reduce((a,k,i)=>a+Math.max(textW(k.querySelector('span')),textW(k.querySelector('b')))+(i?16:0),0);
  if(mainW+18+sideW+4<=avail){
    head.classList.add('inline');
    // 主区不缩：它一缩，大号数字就会压到右侧三项上去
    main.style.flex='1 0 '+Math.ceil(mainW)+'px';
    side.style.flex='0 0 '+Math.ceil(sideW)+'px';
  }
}
function detailPairCard(title,a,b){const total=(Number(a.v)||0)+(Number(b.v)||0)||1,ap=(Number(a.v)||0)/total*100,bp=100-ap;// 占比极小的那一段给个最小宽度，不然它在条上完全看不见（照参考图的观感）
const w=v=>v>0?Math.max(0.8,v):0;return `<div class="card w-detail-pair si-rise"><div class="w-detail-pair-title">${esc(title)}</div><div class="w-detail-pair-bar"><i style="width:${w(ap)}%;background:${a.c}"></i><i style="width:${w(bp)}%;background:${b.c}"></i></div><div class="w-detail-pair-stats"><div class="left"><span>${esc(a.n)} <em>${ap.toFixed(1)}%</em></span><b>${fmtTokens(a.v)}</b></div><div class="right"><span>${esc(b.n)} <em>${bp.toFixed(1)}%</em></span><b>${fmtTokens(b.v)}</b></div></div></div>`;}
function detailHitTrend(series){const data=series.slice(-20);if(!data.length)return'';const w=300,h=116,pl=34,pr=10,pt=10,pb=24,pw=w-pl-pr,ph=h-pt-pb,xy=(v,i)=>[pl+pw*(i/(data.length-1||1)),pt+ph*(1-Math.max(0,Math.min(100,v))/100)];let d='';data.forEach((s,i)=>{const [x,y]=xy(Number(s.hit)||0,i);d+=(i?'L':'M')+x.toFixed(1)+' '+y.toFixed(1);});const grids=[0,50,100].map(v=>{const y=pt+ph*(1-v/100);return `<line x1="${pl}" y1="${y}" x2="${w-pr}" y2="${y}"/><text x="${pl-6}" y="${y+3}" text-anchor="end">${v}%</text>`;}).join('');const ticks=[0,Math.floor((data.length-1)/2),data.length-1].filter((v,i,a)=>a.indexOf(v)===i).map(i=>{const[x]=xy(0,i);return `<text x="${x}" y="${h-5}" text-anchor="middle">#${data[i].i??i+1}</text>`;}).join('');const last=data[data.length-1],[lx,ly]=xy(Number(last.hit)||0,data.length-1);return `<div class="card w-detail-visual si-rise"><div class="w-detail-vhead"><span>最近 ${data.length} 轮缓存命中率</span><b>${fmtPct(last.hit)}</b></div><svg class="w-trend" viewBox="0 0 ${w} ${h}"><g class="w-trend-grid">${grids}<line x1="${pl}" y1="${pt}" x2="${pl}" y2="${h-pb}"/>${ticks}</g><path class="w-trend-line" pathLength="1" d="${d}"/><circle class="w-trend-dot" cx="${lx}" cy="${ly}" r="3"/></svg></div>`;}
function detailDonut(parts,label){const total=parts.reduce((a,p)=>a+(Number(p.v)||0),0)||1;let acc=0;const segs=parts.map(p=>{const pct=(Number(p.v)||0)/total*100,start=acc;acc+=pct;return{pct,start,c:p.c,n:p.n};});const circles=segs.map((s,i)=>{const gap=Math.min(1.4,s.pct*.18),len=Math.max(0,s.pct-gap);return `<circle class="w-donut-segment" cx="50" cy="50" r="39" pathLength="100" stroke="${s.c}" stroke-dashoffset="${(-s.start-gap/2).toFixed(2)}" style="--seg:${len.toFixed(2)};--rest:${(100-len).toFixed(2)};--seg-delay:${(.08+i*.1).toFixed(2)}s"></circle>`;}).join('');return `<div class="card w-detail-visual si-rise"><div class="w-detail-vhead"><span>${esc(label)}</span></div><div class="w-donut-layout"><div class="w-donut-ring"><svg viewBox="0 0 100 100"><circle class="w-donut-track" cx="50" cy="50" r="39"></circle>${circles}</svg></div><div class="w-donut-copy"><span>总计</span><b>${fmtTokens(total)}</b><div class="w-donut-legend">${parts.map((p,i)=>`<span><i style="background:${p.c}"></i>${esc(p.n)} <em>${segs[i].pct.toFixed(1)}%</em></span>`).join('')}</div></div></div></div>`;}

function releaseDetailMotion(root){setTimeout(()=>root?.querySelectorAll('.si-rise').forEach(el=>{el.classList.remove('si-rise');el.style.animationDelay='';el.style.removeProperty('--enter-delay');}),1300);}
/** 详情里的逐轮图默认停在「最新」那一侧：横轴左旧右新，所以滚到最右 */
function scrollDetailToEnd(root){try{if(!root)return;root.querySelectorAll('.w-detail-scroll').forEach(el=>{el.scrollLeft=el.scrollWidth-el.clientWidth;});}catch{}}
// ── 前端自刷新 ──
// 代码改完这边会同步到安装目录并重载 App，但已经打开的页面不会自己变新。
// 这里盯一下前端资源指纹，一变就刷新；详情弹层开着时先等它关掉，别把正在看的东西冲掉。
let buildStamp=null;
async function checkBuildStamp(){try{const r=await fetchJson("/api/build-stamp");if(!r||!r.stamp)return;if(buildStamp===null){buildStamp=r.stamp;return;}if(buildStamp===r.stamp)return;const d=document.getElementById("wDetail");if(d&&!d.hidden)return;buildStamp=r.stamp;location.reload();}catch{}}
function closeWidgetDetail(){const el=$('#wDetail');if(!el)return;el.classList.remove('open');setTimeout(()=>{el.hidden=true;},180);}
function openWidgetDetail(kind,providerId){const st=state.stats||{},series=st.series||[],last=series[series.length-1]||{},used=Array.isArray(st.providers)&&st.providers.length?st.providers:[{provider:st.provider||'unknown',tokens:st.sessionTokens||0,turns:st.turns||0,models:st.models||[]}],total=used.reduce((a,p)=>a+(Number(p.tokens)||0),0)||1,names={deepseek:'DeepSeek',moonshot:'Moonshot',mimo:'MiMo',zhipu:'智谱',agnes:'Agnes',openai:'OpenAI',gemini:'Gemini','openai-codex':'ChatGPT Plus / Pro','xai-oauth':'xAI Grok',xai:'xAI'},avgHit=series.length?series.reduce((a,s)=>a+(Number(s.hit)||0),0)/series.length:null;let title='详情',rows=[],visual='',after='',list=false;
if(kind==='provider'){const p=used.find(x=>x.provider===providerId)||used[0]||{},b=(state.balance?.balances||[]).find(x=>x.provider===p.provider),pct=(Number(p.tokens)||0)/total*100,models=(()=>{const raw=Array.isArray(p.models)?p.models.filter(x=>x&&(x.model||x.id)):[];const tok=raw.reduce((a,x)=>a+(Number(x.tokens)||0),0),trn=raw.reduce((a,x)=>a+(Number(x.turns)||0),0),den=tok||trn||1,basis=tok?'tokens':'turns';return raw.map(x=>({name:x.model||x.id,tokens:Number(x.tokens)||0,turns:Number(x.turns)||0,pct:((tok?(Number(x.tokens)||0):(Number(x.turns)||0))/den)*100,basis}));})();title=(names[p.provider]||p.provider||'供应商')+' 详情';list='spaced';rows=[['供应商',names[p.provider]||p.provider,true],[(models[0]?.basis==='tokens'?'模型 Token 占比':'模型轮次占比')+(models.length?' · '+models.length:''),models],['轮数',String(p.turns||0)],['Token',fmtTokens(p.tokens||0)],['占比',pct>=10?pct.toFixed(0)+'%':pct.toFixed(1)+'%'],['可用余额',b?.status==='ok'?(b.summary||'–'):'不可查询']];visual=detailMeter(pct,'本会话 Token 占比',pct>=10?pct.toFixed(0)+'%':pct.toFixed(1)+'%');}
else if(kind==='providers'){title='本会话供应商';const colors=['var(--accent)','#9d5f4d','#4a6b4a','#8a78a8','#b58b4b'],parts=used.map((p,i)=>({n:names[p.provider]||p.provider,v:p.tokens||0,c:colors[i%colors.length]}));rows=parts.map(p=>{const pct=(Number(p.v)||0)/total*100;return[p.n,fmtTokens(p.v),pct,p.c];});list=true;visual=detailDonut(parts,'Token 分布');}
else if(kind==='context'){title='上下文详情';const pct=Number(st.contextPercent)||0,th=Number(st.compactThreshold||.8)*100;rows=[['当前窗口',`${fmtTokens(st.lastWindowTokens||0)} / ${fmtTokens(st.contextWindow||0)}`],['距压缩',fmtTokens(st.remainingToCompact)],['本会话 Token',fmtTokens(st.sessionTokens)]];visual=detailMeter(pct,`上下文占用 · 阈值 ${fmtPct(th)}`,fmtPct(pct),th)+detailMeter(avgHit,'平均缓存命中率',fmtPct(avgHit));after=detailContextSplit(st);}
else if(kind==='remaining'){title='上下文余量';const pct=Number(st.contextPercent)||0,th=Number(st.compactThreshold||.8)*100;rows=[['上下文窗口',fmtTokens(st.contextWindow)],['已用',fmtTokens(st.lastWindowTokens)],['距压缩',fmtTokens(st.remainingToCompact)]];visual=detailMeter(pct,`已用 / 上下文窗口 · 阈值 ${fmtPct(th)}`,fmtPct(pct),th);after=detailContextSplit(st);}
else if(kind==='turn'){title='当前轮详情';const turns=st.turns||series.length,total=Number(last.total)||0,inTok=Number(last.input)||0,cacheTok=Number(last.cacheRead)||0,outTok=Math.max(0,total-inTok-cacheTok);/* series 里没单独给 reasoning，用总量减掉输入得到输出，正好把思考也算进输出（与会话视图口径一致） */
rows=[];/* 上面已经给出 Token / 轮次 / 费用，下面不再重复。缓存命中率的条形也去掉了：和「命中 / 未命中」卡片重复 */visual=detailTurnHead(last,turns)+detailPairs([detailPairCard('输入 / 输出',{n:'输入',v:inTok+cacheTok,c:'var(--accent)'},{n:'输出',v:outTok,c:'#9d5f4d'}),detailPairCard('命中 / 未命中',{n:'命中',v:cacheTok,c:'var(--accent)'},{n:'未命中',v:inTok,c:'var(--text-muted)'})]);}
else if(kind==='session'){title='本会话总览';list='pair';const input=(Number(st.sumInput)||0)+(Number(st.sumCacheRead)||0),output=(Number(st.sumOutput)||0)+(Number(st.sumReasoning)||0),hit=Number(st.sumCacheRead)||0,miss=Number(st.sumInput)||0,maxTurn=series.length?series.reduce((m,t)=>t.total>m.total?t:m,series[0]):null;visual=detailKpis([['总 Token',fmtTokens(st.sessionTokens)],['平均命中',fmtPct(avgHit)],['总费用',fmtCost(st.sessionCostCny)]])+detailHitTrend(series)+detailDonut([{n:'输入',v:input,c:'var(--accent)'},{n:'输出',v:output,c:'#9d5f4d'}],'输入 / 输出')+detailDonut([{n:'命中',v:hit,c:'var(--accent)'},{n:'未命中',v:miss,c:'var(--text-muted)'}],'命中 / 未命中');if(maxTurn)rows.push(['最高单轮',fmtTokens(maxTurn.total)+'（第'+maxTurn.i+'轮）']);rows.push(['轮数',String(st.turns||series.length)],['时长',st.durationMinutes!=null?st.durationMinutes+' 分钟':'–'],['供应商',used.length+' 个']);}
else if(kind==='composition'){title='Token 构成';const input=(Number(st.sumInput)||0)+(Number(st.sumCacheRead)||0),output=(Number(st.sumOutput)||0)+(Number(st.sumReasoning)||0),hit=Number(st.sumCacheRead)||0,miss=Number(st.sumInput)||0;visual=detailPairs([detailPairCard('输入 / 输出',{n:'输入',v:input,c:'var(--accent)'},{n:'输出',v:output,c:'#9d5f4d'}),detailPairCard('命中 / 未命中',{n:'命中',v:hit,c:'var(--accent)'},{n:'未命中',v:miss,c:'var(--text-muted)'})]);}
else if(kind==='quota'){const items=(state.balance?.balances||[]).filter(b=>b?.status==='ok'&&(b.kind==='quota'||b.remainingPercent!=null)),q=items.find(b=>b.provider===providerId)||items[0],wins=Array.isArray(q?.windows)&&q.windows.length?q.windows:[q].filter(Boolean);title=(q?.name||q?.provider||'额度')+' 详情';list='spaced';rows=[['供应商',q?.name||q?.provider||'–',true]];if(q?.plan)rows.push(['套餐',String(q.plan),true]);if(q?.credits!=null)rows.push(['点数',String(q.credits),true]);rows.push(['窗口与重置'+(wins.length?' · '+wins.length:''),wins.map(x=>quotaWindowName(x)+' · '+fmtResetAt(x?.resetAt))]);visual=wins.map(x=>{const rem=Number(x?.remainingPercent);return detailMeter(rem,quotaWindowName(x),Number.isFinite(rem)?rem.toFixed(0)+'%':'–');}).join('')||detailMeter(0,'额度剩余','–');}
const ov=$('#wDetail'),head=$('#wDetailTitle'),body=$('#wDetailBody');if(!ov||!head||!body)return;head.textContent=title;paintForce(()=>{body.innerHTML=visual+detailRows(rows,list)+after;});ov.hidden=false;requestAnimationFrame(()=>{ov.classList.add('open');body.querySelectorAll('.si-rise').forEach((el,i)=>{const d=(.06+i*.05).toFixed(2)+'s';el.style.animationDelay=d;el.style.setProperty('--enter-delay',d);});scrollDetailToEnd(body);layoutTurnHead();releaseDetailMotion(body);animateNumbers(body);});}

function renderChartDetail(card){const detailW=Math.max(520,Math.round((document.getElementById('wDetailBody')?.clientWidth||864))-4);const type=card.dataset.chart||'',st=(type.indexOf('session')===0?(state.sessionStats||state.stats):state.stats)||{},ser=st.series||[],lg=state.ledger||{};/* 详情里的图表沿用「按轮次均分槽宽」的画法，点数多就横向滚动，比硬挤在一屏里看得清 */const dw=Math.max(840,(ser.length||1)*26+60);if(type==='sessionModels'){return renderSessionModelDetail(st);}function renderSessionModelDetail(st){const provs=((st&&st.providers)||[]).slice().sort((a,b)=>(Number(b.tokens)||0)-(Number(a.tokens)||0));if(!provs.length)return '<div class="empty">本会话暂无供应商数据</div>';const total=provs.reduce((a,p)=>a+(Number(p.tokens)||0),0)||1;const colors=["var(--accent)","#9d5f4d","#4a6b4a","#8a78a8","#b58b4b"];const rows=provs.map((p,i)=>{const pt=Number(p.tokens)||0,pct=pt/total*100,color=colors[i%colors.length];const models=(Array.isArray(p.models)?p.models:[]).slice().sort((a,b)=>(Number(b.tokens)||0)-(Number(a.tokens)||0));const sub=models.length?`<div class="w-detail-sub">${models.map(m=>{const mt=Number(m.tokens)||0,mp=mt/total*100;return `<div class="w-detail-sub-row"><i style="--bar:${color}"></i><span>${esc(m.model)}</span><em>${fmtTokens(mt)}</em><b>${mp.toFixed(1)}%</b></div>`;}).join('')}</div>`:'';return `<div class="card w-detail-item w-detail-provider-item si-rise"><div class="w-detail-item-head"><span>${esc(NAME_CN[p.provider]||p.provider)}</span><b>${pct.toFixed(1)}%</b></div><div class="w-detail-provider-bar"><i style="--pct:${pct.toFixed(2)}%;--bar:${color}"></i></div>${sub}</div>`;}).join('');return `<div class="w-detail-block si-rise">${rows}</div>`;};if(type.indexOf('session')===0&&!ser.length)return '<div class="empty">暂无逐轮数据</div>';if(type==='sessionTokens'){const v=ser.map(s=>Number(s.total)||0),mx=Math.max(...v,1e-9);return detailPlot(mx,{format:fmtTokens},scrollLines([{vals:v,color:"var(--accent)",fill:"color-mix(in srgb,var(--accent) 10%,transparent)"}],{area:true,slotW:26,baseW:840,h:DETAIL_PH,ticks:12,yMax:mx,xLabels:i=>'#'+(i+1)}),dw);}if(type==='sessionCost'){const v=ser.map(s=>Number(s.cost)||0),mx=Math.max(...v,1e-9);return detailPlot(mx,{format:fmtCost},scrollLines([{vals:v,color:"var(--accent)",fill:"color-mix(in srgb,var(--accent) 10%,transparent)"}],{area:true,slotW:26,baseW:840,h:DETAIL_PH,ticks:12,yMax:mx,xLabels:i=>'#'+(i+1)}),dw);}if(type==='sessionStack'){const rows=ser.map(s=>({a:Number(s.cacheInc)||0,b:Number(s.input)||0,c:(Number(s.output)||0)+(Number(s.reasoning)||0)})),mx=Math.max(...rows.map(r=>r.a+r.b+r.c),1e-9);return detailPlot(mx,{format:fmtTokens},scrollStack(rows,{slotW:26,baseW:840,h:DETAIL_PH,ticks:12,yMax:mx,xLabels:i=>'#'+(i+1)}),dw,chartLegendHtml(TOKEN_STACK_LEGEND));}if(type==='sessionCache'){const v=ser.map(s=>Number(s.hit)||0);return detailPlot(100,{format:fmtPct},scrollLines([{vals:v,color:"var(--accent)",fill:"color-mix(in srgb,var(--accent) 10%,transparent)"}],{area:true,slotW:26,baseW:840,h:DETAIL_PH,ticks:12,yMax:100,xLabels:i=>'#'+(i+1)}),dw);}if(type==='context'){const vals=ser.map(s=>s.cumTokens||0);return `<div class="card w-detail-visual si-rise">${line(vals,{w:840,h:280,format:fmtTokens,xLabels:i=>'#'+(i+1),xticks:8})}</div>`;}if(type==='cost'){return `<div class="card w-detail-visual si-rise">${bars(ser.map(s=>s.cost||0),{w:840,h:280,format:fmtCost,xLabels:i=>'#'+(i+1),xticks:8})}</div>`;}if(type==='turnStack'){return chartLegendHtml(TOKEN_STACK_LEGEND)+`<div class="card w-detail-visual si-rise">${stack(ser.map(s=>({a:s.cacheRead||0,b:s.input||0,c:(s.output||0)+(s.reasoning||0)})),{w:840,h:280,xLabels:i=>'#'+(i+1),xticks:8,legendOutside:true})}</div>`;}if(type==='cache'){return `<div class="card w-detail-visual si-rise">${line(ser.map(s=>s.hit||0),{w:840,h:280,format:fmtPct,yMax:100,xLabels:i=>'#'+(i+1),xticks:8})}</div>`;}if(type==='latency'){const b=lg.latency?.buckets||{};return `<div class="card w-detail-visual si-rise">${bars([b.lt1||0,b['1_3']||0,b['3_10']||0,b.gt10||0],{w:840,h:280,format:v=>String(Math.round(v)),xLabels:['<1s','1–3s','3–10s','>10s'],xticks:4})}</div>`;}const tc=state.totalCost||{};if(type==='providers'){const pp=lg.providers?Object.entries(lg.providers).sort((a,b)=>b[1].tokens-a[1].tokens).slice(0,10):[];const mx=pp.length?Math.max(...pp.map(x=>x[1].tokens)):1;return `<div class="card w-detail-visual si-rise">${pp.length?pp.map(([n,v])=>{const pct=Math.round(v.tokens/mx*100);const hr=v.hitRate!=null?(v.hitRate*100).toFixed(1)+'%':'–';return `<div class="pv-detail-row"><div class="pdr-head"><b>${esc(n)}</b><span class="pdr-hr">命中 ${hr}</span></div><div class="track"><i style="width:${pct}%"></i></div><div class="pdr-meta"><span>Token ${fmtTokens(v.tokens)}</span><span>${v.calls} 次</span><span>费用 ${fmtCost(v.cost)}</span></div></div>`;}).join(''):'<div class="empty">暂无供应商数据</div>'}</div>`;}if(type==='model'){const pm=lg.models?Object.entries(lg.models).sort((a,b)=>b[1].tokens-a[1].tokens).slice(0,10):[];const mx=pm.length?Math.max(...pm.map(x=>x[1].tokens)):1;return `<div class="card w-detail-visual si-rise">${pm.length?pm.map(([n,v])=>{const pct=Math.round(v.tokens/mx*100);const hr=v.hitRate!=null?(v.hitRate*100).toFixed(1)+'%':'–';return `<div class="pv-detail-row"><div class="pdr-head"><b>${esc(n)}</b><span class="pdr-hr">命中 ${hr}</span></div><div class="track"><i style="width:${pct}%"></i></div><div class="pdr-meta"><span>Token ${fmtTokens(v.tokens)}</span><span>${v.calls} 次</span><span>费用 ${fmtCost(v.cost)}</span></div></div>`;}).join(''):'<div class="empty">暂无模型数据</div>'}</div>`;}if(type==='taskCategory'){const cn={utility:'工具',session:'会话',memory:'记忆',automation:'自动化',vision:'视觉',compaction:'压缩',subagent:'子代理',other:'其他'};const subs=lg.subsystems||{};const arr=Object.entries(subs).filter(([,v])=>Number(v.tokens||0)>0).sort((a,b)=>b[1].tokens-a[1].tokens);const total=arr.reduce((a,[,v])=>a+Number(v.tokens||0),0)||1;const palette=['color-mix(in srgb,var(--accent) 50%,var(--bg-card))','color-mix(in srgb,var(--green) 45%,var(--bg-card))','color-mix(in srgb,var(--si-amber) 42%,var(--bg-card))','color-mix(in srgb,var(--si-red) 36%,var(--bg-card))','color-mix(in srgb,var(--text-muted) 62%,var(--bg-card))','color-mix(in srgb,var(--accent) 34%,var(--bg-card))'];const segs=arr.map(([k,v],i)=>({n:cn[k]||k,v:Number(v.tokens)||0,color:palette[i%palette.length]}));const mx=arr.length?Math.max(...arr.map(x=>x[1].tokens)):1;const bars=arr.length?arr.map(([k,v])=>{const pct=Math.round(v.tokens/mx*100),lab=cn[k]||k;return `<div class="src-row"><span>${esc(lab)}</span><div class="track"><i style="width:${pct}%"></i></div><b>${fmtTokens(v.tokens)}</b></div>`;}).join(''):'<div class="empty">暂无数据</div>';const legend=segs.map((s,i)=>{const p=total?(s.v/total*100).toFixed(1):0;return `<span><i style="background:${palette[i%palette.length]}"></i><em>${esc(s.n)}</em><b>${p}%</b></span>`;}).join('');return `<div class="w-detail-visual si-rise"><div class="taskcat-layout"><div class="task-fan-wrap"><div class="task-view-title">类别占比</div>${arr.length?`<div class="tc-ring"><div class="tc-ring-main">${donutChart(segs,{size:232,r:88,sw:14,gap:2.5,center:fmtTokens(total),sub:'总 Token'})}</div><div class="tc-ring-legend">${legend}</div></div>`:'<div class="empty">暂无数据</div>'}</div><div class="task-bars-wrap"><div class="task-view-title">具体 Token 用量</div><div class="bars-list">${bars}</div></div></div></div>`;}if(type==='providerTree'){const rp=lg.rangeProviders?.[PROV.unit]||lg.providers||{},rm=lg.rangeModels?.[PROV.unit]||lg.models||{};const arr=Object.entries(rp).sort((a,b)=>b[1].tokens-a[1].tokens).slice(0,10),modelsArr=Object.entries(rm).sort((a,b)=>b[1].tokens-a[1].tokens),mx=arr.length?Math.max(...arr.map(x=>x[1].tokens)):1;const byProv={};for(const [mn,mv] of modelsArr){const pp=mv.provider||'unknown';(byProv[pp]=byProv[pp]||[]).push([mn,mv]);}const tree=arr.length?arr.map(([n,v])=>{const pct=Math.round(v.tokens/mx*100),provModels=(byProv[n]||[]).sort((a,b)=>b[1].tokens-a[1].tokens);return `<div class="pvtree-group"><div class="pvtree-head"><b>${esc(n)}</b><span class="pvtree-tok">${fmtTokens(v.tokens)}</span></div><div class="track"><i style="width:${pct}%"></i></div>${provModels.length?provModels.map(([mn,mv])=>{const mpct=Math.round(mv.tokens/mx*100);return `<div class="pvmodel"><span>${esc(mn)}</span><div class="track"><i style="width:${mpct}%"></i></div><b>${fmtTokens(mv.tokens)}</b></div>`;}).join(''):''}</div>`;}).join(''):'<div class="empty">暂无供应商数据</div>';const top=modelsArr.filter(([,v])=>Number(v.tokens||0)>0||Number(v.calls||0)>0).sort((a,b)=>(Number(b[1].tokens||0)+Number(b[1].calls||0))-(Number(a[1].tokens||0)+Number(a[1].calls||0))).slice(0,10),tokMax=top.length?Math.max(...top.map(x=>x[1].tokens||0)):1;const tokenRows=top.length?top.map(([n,v],i)=>`<div class="model-rank-row"><span class="model-rank-no">${i+1}</span><div class="model-rank-main"><strong>${esc(n)}</strong><div class="track"><i style="width:${Math.round((Number(v.tokens)||0)/tokMax*100)}%"></i></div></div><b>${fmtTokens(v.tokens||0)}</b></div>`).join(''):'<div class="empty">暂无模型数据</div>';const tokenTotal=top.length?top.reduce((s,[,v])=>s+(Number(v.tokens)||0),0):0;const tokens=top.map(x=>Number(x[1].tokens)||0),calls=top.map(x=>Number(x[1].calls)||0),labels=top.map(x=>x[0].length>16?x[0].slice(0,15)+'…':x[0]),palette=['color-mix(in srgb,var(--accent) 50%,var(--bg-card))','color-mix(in srgb,var(--green) 45%,var(--bg-card))','color-mix(in srgb,var(--si-amber) 42%,var(--bg-card))','color-mix(in srgb,var(--si-red) 36%,var(--bg-card))','color-mix(in srgb,var(--text-muted) 62%,var(--bg-card))','color-mix(in srgb,var(--accent) 34%,var(--bg-card))','color-mix(in srgb,var(--green) 30%,var(--bg-card))','color-mix(in srgb,var(--si-amber) 28%,var(--bg-card))','color-mix(in srgb,var(--text-muted) 42%,var(--bg-card))','color-mix(in srgb,var(--accent) 24%,var(--bg-card))'];const tokenVisual=tokenTotal>0?`<div class="model-donut-split"><div class="model-donut-main">${donutChart(top.map(([n,v],i)=>({n,v:Number(v.tokens)||0,color:palette[i%palette.length]})),{size:170,r:58,sw:17,center:fmtTokens(tokenTotal),sub:'模型 Token'})}</div><div class="model-donut-legend">${top.map(([n,v],i)=>{const pct=tokenTotal?(Number(v.tokens||0)/tokenTotal*100).toFixed(1):0;return `<span><i style="background:${palette[i%palette.length]}"></i><em>${esc(n)}</em><b>${pct}%</b></span>`;}).join('')}</div></div>`:'<div class="empty">该范围暂无 Token 用量</div>';const hitRows=top.length?top.map(([n,v])=>{const hr=Math.max(0,Math.min(100,(Number(v.hitRate)||0)*100));return `<div class="model-hit-row"><span>${esc(n)}</span><div class="track"><i style="width:${hr.toFixed(1)}%"></i></div><b>${hr.toFixed(1)}%</b></div>`;}).join(''):'<div class="empty">暂无缓存数据</div>';return `<div class="w-detail-visual si-rise provider-detail-dashboard"><div class="model-metrics-grid"><section class="model-metric-card provider-tree-card"><h4>供应商与模型层级</h4>${tree}</section><section class="model-metric-card"><h4>模型 Token 消耗</h4>${tokenRows}</section><section class="model-metric-card model-donut-center"><h4>模型 Token 占比</h4>${tokenVisual}</section><section class="model-metric-card model-full"><h4>模型调用次数</h4>${top.length?bars(calls,{w:860,h:200,format:v=>String(Math.round(v)),xLabels:labels,xticks:Math.min(8,top.length)}):'<div class="empty">暂无调用数据</div>'}</section><section class="model-metric-card model-full"><h4>模型缓存命中率</h4>${hitRows}</section></div></div>`;}if(type==='heat'){const dayArr=Object.entries(lg.days||{}).sort((a,b)=>a[0].localeCompare(b[0]));const maxT=Math.max(...dayArr.map(([,v])=>v.tokens||0),1);const dmap=dayArr.map(([d,v])=>({d:d.slice(5),l:Math.min(4,Math.round((v.tokens||0)/maxT*4))}));return `<div class="card w-detail-visual si-rise"><div class="heat cost-heat">${dmap.map(dd=>`<i class="l${dd.l}" data-tip="${dd.d}"></i>`).join('')}</div></div>`;}if(type==='modelDetail'){const md=Object.entries(lg.models||{}).sort((a,b)=>(b[1].cost||0)-(a[1].cost||0));const todayModel=tc.todayModel||{};const rows=md.length?md.map(([m,v])=>{const hr=v.hitRate!=null?(v.hitRate*100).toFixed(1)+'%':'–';const todayC=todayModel[m]!=null?fmtCost(todayModel[m]):'–';return `<div class="md-row"><div class="md-name"><b>${esc(m)}</b><em>${esc(v.provider||'–')}</em></div><div class="md-num"><span>调用</span><b>${v.calls||0}</b></div><div class="md-num"><span>Token</span><b>${fmtTokens(v.tokens||0)}</b></div><div class="md-hit"><div class="track"><i style="width:${Math.min(100,Math.max(0,Number(v.hitRate||0)*100))}%"></i></div><b>${hr}</b></div><div class="md-num"><span>今日费用</span><b>${todayC}</b></div><div class="md-num"><span>累计费用</span><b>${fmtCost(v.cost||0)}</b></div></div>`;}).join(''):'<div class="empty">暂无模型数据</div>';return `<div class="w-detail-visual si-rise"><div class="md-dash"><div class="md-head"><span>模型</span><span>调用</span><span>Token</span><span>命中率</span><span>今日费用</span><span>累计费用</span></div>${rows}</div></div>`;}if(type==='budget'){const costArr=Object.values(lg.days||{}).map(d=>d.cost||0);const dayKeysD=Object.keys(lg.days||{});return `<div class="card w-detail-visual si-rise">${line(costArr,{w:840,h:280,format:fmtCost,xLabels:i=>dayKeysD[i]?.slice(5)||'',xticks:8})}</div>`;}if(type==='tokpanel'){const tb=lg.tokenBuckets||{};const N=256;const src=tb[TOK.unit];const data=Array.isArray(src)?src.slice(-N):[];while(data.length<N)data.unshift(0);const last=N-1;return `<div class="card w-detail-visual si-rise">${line(data,{w:840,h:280,format:fmtTokens,xLabels:i=>{if(i===0)return'0';if(i===last)return String(last);const step=Math.max(1,Math.round(N/8));return i%step===0?String(i):' ';},xticks:9})}</div>`;}if(type==='todaySummary'){const tb=lg.tokenBuckets||{};const hour=Array.isArray(tb.hour)?tb.hour.slice(-24):Array(24).fill(0);const crb=lg.cacheRateBuckets||{};const hitHour=Array.isArray(crb.hour)?crb.hour.slice(-24):Array(24).fill(0);const todayKey=fmtDay(new Date());const td=lg.days?.[todayKey]||{tk:{}};const tkD=lg.tokens||{};const hr=td.hitRate!=null?(td.hitRate*100):null;const hourLabels=()=>{const a=[];const now=new Date();for(let i=23;i>=0;i--){a.push(fmtHour(new Date(now.getTime()-i*3600e3)));}return a;};const hourMax=Math.max(...hour,1);const hourPeak=hourMax!==1?(hourMax/1000000).toFixed(1)+'M':0;const tkComp=()=>{const ti=tkD.input||0,to=tkD.output||0,th=tkD.cacheHit||0,miss=tkD.cacheMiss||0;const segSum=Math.max(th+ti+to+miss,1);const segs=[['输入·未命中',miss,'miss','var(--si-amber)'],['输入·命中缓存',th,'hit','var(--green)'],['输出',to,'out','var(--text-light)']].filter(([,v])=>v>0);const ring=donutChart(segs.map(([lab,v,cls,col])=>({v,color:col})),{size:150,r:60,sw:13,gap:2,center:fmtTokens(segSum),sub:'输入 / 输出'});const legend=segs.map(([lab,v,cls,col])=>{const p=(v/segSum*100).toFixed(1);return `<span style="--c:${col}"><i></i><em>${lab}</em><b>${fmtTokens(v)}<span class="pct"> · ${p}%</span></b></span>`;}).join('');return `<div class="td-ring"><div class="td-ring-main">${ring}</div><div class="td-ring-legend">${legend}</div></div>`;};const subs=Object.entries(lg.subsystems||{}).filter(([,v])=>Number(v.tokens||0)>0).sort((a,b)=>b[1].tokens-a[1].tokens).slice(0,6);const subMax=subs.length?Math.max(...subs.map(x=>x[1].tokens)):1;const cn={utility:'工具',session:'会话',memory:'记忆',automation:'自动化',vision:'视觉',compaction:'压缩',subagent:'子代理',other:'其他'};const subRows=subs.length?subs.map(([k,v])=>{const p=Math.round(v.tokens/subMax*100);return `<div class="td-sub-row"><span>${esc(cn[k]||k)}</span><div class="track"><i style="width:${p}%"></i></div><b>${fmtTokens(v.tokens)}</b></div>`;}).join(''):'<div class="empty">今日暂无分类数据</div>';const dayTxt=fmtMonthDayWeek(new Date());return `<div class="w-detail-visual si-rise td-magazine"><div class="td-masthead"><div class="td-mast-title"><span>${dayTxt}</span></div><div class="td-lede"><div class="td-lede-main"><span>今日 Token 总量</span><b>${fmtTokens(td.tokens||0)}</b></div><div class="td-lede-hit"><div class="td-hit-kpi"><span>今日命中率</span><b${hr!=null&&hr>=80?' class="s-good"':hr!=null&&hr>=60?' class="s-mid"':' class="s-low"'}>${hr!=null?fmtPct(hr):'–'}</b><em>缓存命中占输入比重</em></div></div><div class="td-lede-sub"><div class="mini-card"><span>今日费用</span><b>${fmtCost(td.cost||0)}</b></div><div class="mini-card"><span>今日调用</span><b>${td.calls||0}${td.err?` <em style="color:var(--si-red);font-style:normal;font-size:10px">失败 ${td.err}</em>`:''}</b></div></div></div></div><div class="td-feature td-feature-main"><div class="td-feature-head"><span>近 24 小时 Token 消耗</span><em>峰值 ${hourPeak}</em></div>${line(hour,{w:detailW,h:260,axisW:52,format:fmtTokens,xLabels:(i)=>hourLabels()[i],xticks:9})}</div><div class="td-hitcard"><div class="td-hit-trend">${line(hitHour,{w:detailW,h:220,axisW:52,format:fmtPct,yMax:100,stroke:'var(--green)',fill:'color-mix(in srgb,var(--green) 10%,transparent)',xLabels:(i)=>hourLabels()[i],xticks:9})}</div></div><div class="td-duo"><div class="td-duo-item"><div class="td-feature-head"><span>今日输入构成</span></div>${tkComp()}</div><div class="td-duo-item"><div class="td-feature-head"><span>今日任务类别 Top</span></div><div class="ma-rank">${subRows}</div></div></div></div>`;}if(type==='tokenComp'){const tkD=lg.tokens||{};const ti=tkD.input||0,to=tkD.output||0,th=tkD.cacheHit||0;const segSum=Math.max(th+ti+to,1);const hr2=(th+ti+to)>0?(th/(th+ti+to)*100).toFixed(1):"–";return `<div class="w-detail-visual si-rise"><div class="tok-comp"><div class="tok-track" style="height:34px"><i class="t-hit" title="输入（命中缓存）" style="width:${Math.max(3.5,th/segSum*100)}%"></i><i class="t-in" title="输入（未命中缓存）" style="width:${Math.max(3.5,ti/segSum*100)}%"></i><i class="t-out" title="输出" style="width:${Math.max(3.5,to/segSum*100)}%"></i></div><div class="tok-legend"><span class="t-hit"><i></i>输入（命中缓存） <b>${fmtTokens(th)}</b></span><span class="t-in"><i></i>输入（未命中缓存） <b>${fmtTokens(ti)}</b></span><span class="t-out"><i></i>输出 <b>${fmtTokens(to)}</b></span><em>命中率 ${hr2}%</em></div></div></div>`;}return '<div class="empty">该卡片暂无放大视图</div>';}
/* 左边「模型 Token 消耗」行数一多就把整行拉高，右边的「模型 Token 占比」会空出一大截。
   空白超过阈值就给它加 is-tall，由左右结构改成上下结构（图例纵向铺开）。 */
function fitDonutCard(root){
  try{
    const card=root.querySelector('.model-metric-card.model-donut-center');
    if(!card)return;
    const legend=card.querySelector('.model-donut-legend');
    const items=legend?legend.children.length:0;
    const need=Math.max(170,items*30)+70;
    card.classList.toggle('is-tall',card.clientHeight-need>140);
  }catch{}
}
function openModal(card){if(!card)return;const tp=(()=>{const h=card.querySelector('h3');if(!h)return '图表';const tb=card.querySelector('h3 .st-wrap b')||card.querySelector('h3 b');if(tb)return tb.textContent.trim()||'图表';const clone=h.cloneNode(true);clone.querySelectorAll('small').forEach(s=>s.remove());return clone.textContent.trim()||'图表';})();const head=$('#wDetailTitle'),body=$('#wDetailBody'),ov=$('#wDetail');if(!head||!body||!ov)return;head.textContent=tp;const rc=card.dataset.chart;const unitMap={hour:"近24h",d7:"近7天",d30:"近30天",day:"按天"};const rng=$("#wDetailRange");if(rng){let ur=null;if(rc==="tokpanel")ur=TOK.unit;else if(rc==="providerTree")ur=PROV.unit;if(ur&&unitMap[ur]){rng.textContent=unitMap[ur];rng.hidden=false;}else{rng.textContent="";rng.hidden=true;}}paintForce(()=>{body.innerHTML=renderChartDetail(card);});ov.hidden=false;requestAnimationFrame(()=>{ov.classList.add('open');scrollDetailToEnd(body);releaseDetailMotion(body);animateNumbers(body);fitDonutCard(body);});}

function detailReleaseTo(c){c.classList.remove('si-press','si-release','si-dynamic-release','release-out');c.style.transform='';c.style.transition='';}

function initPageEvents(){document.addEventListener('click',e=>{if(surface==='widget'){if(e.target.closest('[data-detail-close]')||e.target.id==='wDetail'){closeWidgetDetail();return;}const d=e.target.closest('.widget [data-detail]');if(d){openWidgetDetail(d.dataset.detail,d.dataset.provider);return;}return;}if(e.target.closest('[data-detail-close]')||e.target.id==='wDetail'){closeWidgetDetail();return;}const back=e.target.closest('#apiBack');if(back){nav('api','api-overview');return;}const opt=e.target.closest('.seg [data-v]');if(opt){const seg=opt.closest('.seg'),v=opt.dataset.v;if(seg.id==='providerCostUnitSeg'){PROVIDER_COST.unit=v;providerHeatEnterPending=true;renderProviderCostPanels();}else if(seg.id==='costUnitSeg'){COST.unit=v;costHeatEnterPending=true;renderCostPanel();}else if(seg.id==='costModeSeg'){COST.mode=v;if(v==='heat')costHeatEnterPending=true;renderCostPanel();}else if(seg.id==='tokUnitSeg'){TOK.unit=v;tokHeatEnterPending=true;renderTokenPanel();}else if(seg.id==='tokModeSeg'){TOK.mode=v;if(v==='heat')tokHeatEnterPending=true;renderTokenPanel();}else if(seg.id==='cacheUnitSeg'){CACHE.unit=v;cacheHeatEnterPending=true;renderCachePanel();}else if(seg.id==='cacheModeSeg'){CACHE.mode=v;if(v==='heat')cacheHeatEnterPending=true;renderCachePanel();}else if(seg.id==='provUnitSeg'){PROV.unit=v;renderUsageOverview();}else if(seg.id==='evRangeSeg'){EV.range=v;loadEvents().then(()=>renderUsageOverview());}numEnter=true;flashSeg(seg);requestAnimationFrame(()=>playNumbers());return;}const lb=e.target.closest('[data-launch]');if(lb){runLocalLaunch(lb.dataset.launch,lb,lb.dataset.base||'启动');return;}const q=e.target.closest('[data-open]');if(q){openExternal(q.dataset.open);return;}const brief=e.target.closest('#costBrief');if(brief){nav('api','api-pricing');return;}const pback=e.target.closest('#pricingBack');if(pback){nav('api','api-overview');return;}const prel=e.target.closest('#pricingReload');if(prel){if(prel.classList.contains('loading'))return;const old=prel.textContent;prel.classList.remove('done','failed');prel.classList.add('loading');prel.textContent='↻ 加载中';pluginApiFetch('/api/reload-config').then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json();}).then(j=>{if(!j||!j.ok)throw new Error((j&&j.error)||'reload failed');return fetchJson('/api/pricing');}).then(r=>{state.pricing=r;renderApiOverview();renderPricingTable();prel.classList.remove('loading');prel.classList.add('done');prel.textContent='✓ 已更新';setTimeout(()=>{prel.classList.remove('done');prel.textContent=old;},1500);}).catch(err=>{prel.classList.remove('loading');prel.classList.add('failed');prel.textContent='⚠ '+String(err&&err.message||'失败').slice(0,20);setTimeout(()=>{prel.classList.remove('failed');prel.textContent=old;},2400);});return;}const step=e.target.closest('[data-th-step]');if(step){e.stopPropagation();const input=step.closest('.threshold-input')?.querySelector('input[type="number"]');if(input&&!input.disabled){const n=Number(input.value)||0,stepSize=Number(input.step)||1,min=Number(input.min),max=Number(input.max),next=step.dataset.thStep==='up'?n+stepSize:n-stepSize;input.value=String(Math.max(min,Math.min(max,next)));input.dispatchEvent(new Event('change',{bubbles:true}));}return;}const rtl=e.target.closest('.pv-tail[data-refresh]');if(rtl){e.stopPropagation();refreshOneProvider(rtl.dataset.refresh);return;}const pv=e.target.closest('.provider-item[data-provider]');if(pv){showProvider(pv.dataset.provider);return;}const tab=e.target.closest('.tab');if(tab){nav(tab.dataset.view,tab.dataset.view==='usage'?'usage-overview':'api-overview');return;}const sub=e.target.closest('.subtab');if(sub){const sc=sub.closest('.subnav')?.dataset.scope||sub.closest('.view')?.id.replace('view-','')||'usage';setPage(sub.dataset.page,sc);return;}const p=e.target.closest('.provider-item');if(p){showProvider(p.dataset.provider);nav('api','api-detail');return;}const row=e.target.closest('.session-row');if(row){nav('usage','usage-session');return;}const chart=e.target.closest('.chart-card[data-chart]:not(.no-modal),.session-providers[data-chart]');if(chart){let nearSeg=false;const segs=chart.querySelectorAll('.seg');for(const s of segs){const r=s.getBoundingClientRect();const dx=Math.max(r.left-e.clientX,0,e.clientX-r.right);const dy=Math.max(r.top-e.clientY,0,e.clientY-r.bottom);if(Math.hypot(dx,dy)<15){nearSeg=true;break;}}if(!nearSeg){openModal(chart);return;}}});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeWidgetDetail();});document.addEventListener('input',e=>{if(!['thPct','thFail'].includes(e.target.id))return;e.target.value=e.target.value.replace(/[^0-9]/g,'');});document.addEventListener('click',e=>{if(!e.target.closest('.session-drop,#sessionMenu'))closeSessionMenu();const tr=e.target.closest('#sessionTrigger');if(tr){e.stopPropagation();toggleSessionMenu();return;}const it=e.target.closest('.session-item');if(it){e.stopPropagation();pickSession(it.dataset.file);return;}});document.addEventListener('change',e=>{if(!['thEnabled','thPct','thFail'].includes(e.target.id))return;const s=$('#thresholdSaveStatus');if(s)s.textContent='保存中…';const hit=(state.balance?.balances||[]).find(b=>b.provider===state.provider);const isBalance=hit?.kind==='balance';const value=Math.max(1,Math.round(Number($('#thPct')?.value)||(isBalance?5:20)));const fail=Math.max(1,Math.round(Number($('#thFail')?.value)||3));if($('#thPct'))$('#thPct').value=String(value);if($('#thFail'))$('#thFail').value=String(fail);saveRules(state.provider,{enabled:$('#thEnabled')?.checked||false,pct:isBalance?20:value,amount:isBalance?value:undefined,fail}).then(r=>{if(s)s.textContent=r?.ok?'已保存':'保存失败';});});document.addEventListener('change',e=>{const row=e.target.closest('[data-alert-provider]');if(!row)return;const provider=row.dataset.alertProvider;const enabled=row.querySelector('[data-alert-enabled]')?.checked||false;const pct=Number(row.querySelector('[data-alert-pct]')?.value)||20;const fail=Number(row.querySelector('[data-alert-fail]')?.value)||3;saveRules(provider,{enabled,pct,fail}).then(()=>{state.rules=Object.assign({},state.rules,{[provider]:{enabled,pct,fail}});});});
document.addEventListener('mousedown',e=>{const c=e.target.closest('.card,.panel,.provider-item,.chart-card,.api-hero,.price-group,.session-trigger,.model-metric-card');if(c){if(c.closest('.w-detail-card'))detailReleaseTo(c);c.classList.remove('si-release');c.classList.add('si-press');}},true);document.addEventListener('mouseup',()=>{$$('.si-press').forEach(c=>{if(c.closest('.w-detail-card'))detailReleaseTo(c);else{c.classList.remove('si-press');c.classList.add('si-release');setTimeout(()=>c.classList.remove('si-release'),650);}});},true);}

let glowRaf=null,glowMx=0,glowMy=0,glowCard=null,glowCache=[],glowPrev=null;
function clearAllGlowSpots(){document.querySelectorAll('.si-glow-spot,.si-border-glow').forEach(el=>el.style.setProperty('opacity','0'));}
function updateGlow(){glowRaf=null;const card=document.elementFromPoint(glowMx,glowMy)?.closest('.card,.panel,.provider-item,.chart-card,.api-hero,.mini-card,.td-feature-main,.td-hitcard,.td-duo-item,.model-metric-card,.td-lede-sub,.price-group,.session-trigger');if(!card){if(glowPrev){glowPrev.spot?.style.setProperty('opacity','0');glowPrev.bord?.style.setProperty('opacity','0');glowPrev=null;}glowCache.forEach(x=>x.el.style.setProperty('--glow-t','0'));clearAllGlowSpots();glowCard=null;glowCache=[];return;}const r=card.getBoundingClientRect();if(!card.querySelector('.si-glow-spot')){const x=document.createElement('div');x.className='si-glow-spot';card.prepend(x);}if(!card.querySelector('.si-border-glow')){const x=document.createElement('div');x.className='si-border-glow';card.prepend(x);}const spot=card.querySelector('.si-glow-spot'),bord=card.querySelector('.si-border-glow');if(glowPrev&&glowPrev.spot!==spot){glowPrev.spot.style.opacity='0';glowPrev.bord.style.opacity='0';}glowPrev={spot,bord};spot.style.opacity='1';bord.style.opacity='1';if(card!==glowCard){glowCache.forEach(x=>x.el.style.setProperty('--glow-t','0'));glowCard=card;glowCache=Array.from(card.querySelectorAll('.glow-text,h3,.card span,.card b,.metric span,.metric b,.metric em')).filter(el=>el.closest('.card,.chart-card,.provider-item')===card).map(el=>{const er=el.getBoundingClientRect();return{el,rx:er.left+er.width/2-r.left,ry:er.top+er.height/2-r.top};});}card.style.setProperty('--mx',((glowMx-r.left)/r.width*100).toFixed(1)+'%');card.style.setProperty('--my',((glowMy-r.top)/r.height*100).toFixed(1)+'%');card.style.setProperty('--ang',((Math.atan2(glowMy-(r.top+r.height/2),glowMx-(r.left+r.width/2))*180)/Math.PI+90).toFixed(1)+'deg');const md=Math.min(170,r.width,r.height);glowCache.forEach(x=>{const dx=x.rx-(glowMx-r.left),dy=x.ry-(glowMy-r.top),g=md>0?Math.max(0,1-Math.sqrt(dx*dx+dy*dy)/md):0;x.el.style.setProperty('--glow-t',g.toFixed(2));});}
function clearGlow(){if(glowPrev){glowPrev.spot?.style.setProperty('opacity','0');glowPrev.bord?.style.setProperty('opacity','0');glowPrev=null;}glowCache.forEach(x=>x.el.style.setProperty('--glow-t','0'));clearAllGlowSpots();glowRaf=null;glowCard=null;glowCache=[];}
// 卡片列表重渲染会把光晕元素连同引用一起换掉，鼠标又恰好不动时残留得等下次移动才消——主动兜底清一遍
document.addEventListener('mouseleave',()=>clearGlow());window.addEventListener('mouseleave',()=>clearGlow());window.addEventListener('blur',()=>clearGlow());document.addEventListener('mouseout',e=>{if(!e.relatedTarget)clearGlow();},true);document.addEventListener('scroll',()=>clearGlow(),true);document.addEventListener('visibilitychange',()=>{if(document.hidden)clearGlow();});

const pageShell=()=>`<div class="shell"><div class="top"><div class="nav" data-view="usage"><i class="nav-thumb" aria-hidden="true"></i><button class="tab active" data-view="usage">用量</button><button class="tab" data-view="api">API 管理</button></div><span class="live">实时</span><span class="top-actions"><button class="ghost" id="refreshBtn"><span class="btn-ic" id="btnIc">↻</span><span id="btnTx">刷新</span></button></span></div><main class="main"><section class="view active" id="view-usage" data-page="usage-overview"><div class="subnav" data-scope="usage"><button class="subtab active" data-page="usage-overview">总览</button><button class="subtab" data-page="usage-session">会话</button></div><div class="page active" id="usage-overview"><div class="hero usage-hero"><div class="uh-main"><div class="uh-block uh-tok uh-primary"><div class="uh-label">总消耗 Token<span class="uh-range" id="kTokRange"></span></div><b id="kTok">–</b></div><div class="uh-hitrow"><div class="uh-block uh-hit uh-secondary"><div class="uh-label">平均缓存命中率</div><b id="kHit">–</b></div><div class="uh-divider"></div><div class="uh-mini"><div class="mini-card"><span>总费用</span><b id="kCost">–</b></div><div class="mini-card"><span>调用数</span><b id="kCall">–</b></div><div class="mini-card"><span>异常</span><b id="kErr">–</b></div></div></div></div><div class="panel glass chart-card uh-today" data-chart="todaySummary"><div id="todayStatsBody"></div></div></div><div class="panel glass" id="tokenComposition"><h3><span class="st-wrap"><b>Token 构成</b><em>跨对话累计</em></span></h3><div id="tokenBody"></div></div><div class="panel glass chart-card no-modal" data-chart="tokpanel"><h3><span class="st-wrap"><b>Token 消费统计</b></span><span class="stg"><span class="seg" id="tokModeSeg" style="--n:2"><i class="seg-thumb"></i><button data-v="line" class="active">折线图</button><button data-v="heat">热力图</button></span><span class="seg" id="tokUnitSeg" style="--n:4"><i class="seg-thumb"></i><button data-v="hour" class="active">近24h</button><button data-v="d7">近7天</button><button data-v="d30">近30天</button><button data-v="day">按天</button></span></span></h3><div class="cost-viz" id="tokViz"></div></div><div class="panel glass chart-card no-modal" data-chart="cachePanel"><h3><span class="st-wrap"><b>缓存命中统计</b></span><span class="stg"><span class="seg" id="cacheModeSeg" style="--n:2"><i class="seg-thumb"></i><button data-v="line" class="active">折线图</button><button data-v="heat">热力图</button></span><span class="seg" id="cacheUnitSeg" style="--n:4"><i class="seg-thumb"></i><button data-v="hour" class="active">近24h</button><button data-v="d7">近7天</button><button data-v="d30">近30天</button><button data-v="day">按天</button></span></span></h3><div class="cost-viz" id="cacheViz"></div></div><div class="grid2 usage-layout"><div class="usage-left"><div class="panel glass chart-card no-modal" data-chart="budget"><h3>每日费用趋势</h3><div class="chart" id="budgetChart"></div></div><div class="panel glass chart-card" data-chart="taskCategory"><h3><span class="st-wrap"><b>消耗 Token 任务类别</b><em>按子系统</em></span></h3><div class="rank" id="taskCat"></div></div></div><div class="panel glass chart-card" data-chart="providerTree"><h3><span class="st-wrap"><b>供应商 token 消耗量排行</b><em>按时间范围</em></span><span class="stg"><span class="seg" id="provUnitSeg" style="--n:4"><i class="seg-thumb"></i><button data-v="hour" class="active">近24h</button><button data-v="d7">近7天</button><button data-v="d30">近30天</button><button data-v="day">按天</button></span></span></h3><div id="providerTree"></div></div></div><div class="panel glass"><h3>模型用量</h3><div class="tbl model-detail" id="modelDetail"></div></div><div class="panel-row"><div class="panel glass"><h3><span class="st-wrap"><b>日志</b><em id="evRangeLabel">近2h</em></span><span class="stg"><span class="seg" id="evRangeSeg" style="--n:2"><i class="seg-thumb"></i><button data-v="2h" class="active">近2h</button><button data-v="24h">近24h</button></span></span></h3><div id="usageEvents"></div></div><div class="panel glass"><h3>延迟统计</h3><div class="lat-kpis"><div class="mini-card"><span>延迟 P50</span><b id="dP50">–</b></div><div class="mini-card"><span>延迟 P95</span><b id="dP95">–</b></div></div><div class="chart" style="margin-top:12px" id="latHist"></div></div></div></div><div class="page" id="usage-session"><div class="session-pick"><div class="session-drop" id="sessionDrop"><button type="button" class="session-trigger" id="sessionTrigger" aria-haspopup="listbox"><span class="session-trigger-label" id="sessionTriggerLabel">检测中…</span><i class="session-trigger-caret" aria-hidden="true">▾</i></button><div class="session-menu" id="sessionMenu" role="listbox" hidden></div></div></div><div class="hero usage-hero"><div class="uh-main"><div class="uh-block uh-tok uh-primary"><div class="uh-label">本会话 Token</div><b id="sTok">–</b></div><div class="uh-divider"></div><div class="uh-side"><div class="uh-block uh-hit uh-secondary"><div class="uh-label">平均缓存命中率</div><b id="sHit">–</b></div></div></div></div><div class="session-extra"><div class="se-col"><div class="panel glass session-composition"><h3><span class="st-wrap"><b>Token 构成</b><em>输入 / 输出</em></span></h3><div class="scomp-row"><div class="scomp-head"><span>输入 <b id="sInPct">–</b></span><span>输出 <b id="sOutPct">–</b></span></div><div class="scomp-track"><i class="in" id="sInBar"></i><i class="out" id="sOutBar"></i></div></div><div class="scomp-row"><div class="scomp-head"><span>命中 <b id="sHitPct">–</b></span><span>未命中 <b id="sMissPct">–</b></span></div><div class="scomp-track"><i class="hit" id="sHitBar"></i><i class="miss" id="sMissBar"></i></div></div></div><div class="session-mini"><div class="mini-card"><span>费用</span><b id="sCost">–</b></div><div class="mini-card"><span>轮数</span><b id="sTurn">–</b></div><div class="mini-card"><span>上下文峰值</span><b id="sCtx">–</b></div></div></div><div class="panel glass session-providers" data-chart="sessionModels" title="点击查看供应商与模型明细"><h3><span class="st-wrap"><b>本会话模型</b><em>Token 占比</em></span></h3><div id="sProviderBody"></div></div></div><div class="session-charts"><div class="panel glass chart-card" data-chart="sessionTokens"><h3>每轮 Token 用量</h3><div class="scroll-chart"><div class="sc-yaxis" id="ctxY"></div><div class="chart-scroll" id="ctxChart"></div></div></div><div class="panel glass chart-card" data-chart="sessionCost"><h3>每轮费用</h3><div class="scroll-chart"><div class="sc-yaxis" id="costY"></div><div class="chart-scroll" id="costChart"></div></div></div><div class="panel glass chart-card" data-chart="sessionStack"><h3>每轮 Token 构成</h3><div class="scl-legend pe-fixed-legend" id="stackLegend"></div><div class="scroll-chart"><div class="sc-yaxis" id="stackY"></div><div class="chart-scroll" id="stackChart"></div></div></div><div class="panel glass chart-card" data-chart="sessionCache"><h3>缓存命中率</h3><div class="scroll-chart"><div class="sc-yaxis" id="cacheY"></div><div class="chart-scroll" id="cacheChart"></div></div></div></div><div id="sessionEmpty"></div></div></section><section class="view" id="view-api"><div class="page active" id="api-overview"><div class="hero-pricing"><div class="api-hero"><div class="ah-block ah-block-cost"><div class="ah-top"><span class="ah-label">总消耗</span></div><b class="ah-num" id="tCost">–</b><div class="ah-token-block"><span class="ah-label">总消耗 Token</span><b class="ah-token-num" id="tCostSub">–</b></div></div><div class="ah-divider"></div><div class="ah-block ah-block-balance"><div class="ah-top"><span class="ah-label">总余额</span></div><b class="ah-num ah-bal" id="tBal">–</b><div class="ah-bal-list" id="tBalSub"></div><div class="ah-upd" id="balUpdated"></div></div></div><div class="panel glass pricing-side brief-card" id="costBrief" data-open-view="api-pricing" title="点击查看模型费用明细"><h3><span class="st-wrap"><b>费用简报</b><em>今日 · 按供应商</em></span><span class="badge">详情 ›</span></h3><div id="briefList"></div></div></div><div class="hero-cost"><div class="card"><h3><span class="st-wrap"><b>费用概览</b></span><span class="stg"><span class="seg" id="costModeSeg" style="--n:2"><i class="seg-thumb"></i><button data-v="line" class="active">折线图</button><button data-v="heat">热力图</button></span><span class="seg" id="costUnitSeg" style="--n:4"><i class="seg-thumb"></i><button data-v="hour" class="active">近24h</button><button data-v="d7">近7天</button><button data-v="d30">近30天</button><button data-v="day">按天</button></span></span></h3><div class="cost-viz" id="costViz"></div></div></div><div><div id="providerList" class="provider-section"><div class="pv-head-bar"><h3>供应商</h3><button type="button" class="ghost" id="refreshAllBtn"><span class="btn-ic" id="refreshAllIc">↻</span><span id="refreshAllTx">整体刷新</span></button></div><div class="provider-list"></div></div></div></div><div class="page" id="api-pricing"><div class="d-head"><b>费用简报详情</b><button class="ghost" id="pricingReload" type="button" title="重新拉取计费数据库并重读供应商配置">↻ 重新加载配置</button><button class="ghost" id="pricingBack" type="button">‹ 返回</button></div><div class="panel glass pricing-detail-panel"><h3>供应商与模型费用 <small id="pricingMeta">–</small></h3><div id="pricingList"></div></div></div><div class="page" id="api-detail"><div class="d-head"><div class="provider-title"><b id="pdTitle">供应商详情</b><div class="quick" id="pdQuick"></div></div><button class="subtab" id="apiBack">返回总览</button></div><div class="provider-detail-top"><div class="hero-metrics provider-summary" id="pdStats"></div><div class="provider-side-tools"><div class="panel glass provider-model-rank"><h3>模型消耗排行</h3><div id="providerModelRank"></div></div><div class="panel glass provider-threshold-card"><div class="threshold-card-head"><h3>阈值提醒</h3><label class="threshold-toggle"><input type="checkbox" id="thEnabled"><span class="threshold-switch"></span><b>启用</b></label></div><div class="threshold-fields"><label class="threshold-field"><span id="thresholdLabel">余额低于</span><div class="threshold-input"><input id="thPct" type="number" min="1" max="100000" step="1" inputmode="numeric" value="5"><span class="threshold-arrows"><button type="button" data-th-step="up" aria-label="增加">▲</button><button type="button" data-th-step="down" aria-label="减少">▼</button></span><b id="thresholdUnit">元</b></div></label><label class="threshold-field"><span>连续失败</span><div class="threshold-input"><input id="thFail" type="number" min="1" max="10" step="1" inputmode="numeric" value="3"><span class="threshold-arrows"><button type="button" data-th-step="up" aria-label="增加">▲</button><button type="button" data-th-step="down" aria-label="减少">▼</button></span><b>次</b></div></label></div><div class="threshold-save" id="thresholdSaveStatus">已保存</div></div><div class="panel glass provider-data-card" id="pdDataCard" hidden><h3>Token 结构</h3><div class="pd-data-rows" id="pdDataRows"></div></div></div></div><div class="provider-cost-section"><div class="provider-cost-head"><h3>费用概览</h3><span class="seg" id="providerCostUnitSeg" style="--n:4"><i class="seg-thumb"></i><button data-v="hour" class="active">近24h</button><button data-v="d7">近7天</button><button data-v="d30">近30天</button><button data-v="day">按天</button></span></div><div class="provider-cost-grid"><div class="card chart-card provider-mini-chart"><h4>热力图</h4><div class="chart" id="providerCostHeat"></div></div><div class="card chart-card provider-mini-chart"><h4>折线图</h4><div class="chart" id="providerCostLine"></div></div></div></div></div></section></main></div><div class="w-detail-overlay" id="wDetail" hidden><div class="w-detail-card glass"><div class="w-detail-head"><b id="wDetailTitle">详情</b><span class="w-detail-range" id="wDetailRange" hidden></span><button data-detail-close>关闭</button></div><div id="wDetailBody"></div></div></div>`;

const widgetShell=()=>`<div class="widget"><div class="row"><div><div class="w-title" id="wTitle">当前会话</div><div class="w-meta" id="wMeta">—</div></div><span class="live">实时</span></div><div class="card ring-state" id="wRing" data-detail="session" data-block="overview"><div class="w-ring"><svg viewBox="0 0 100 100"><circle class="ring-track" cx="50" cy="50" r="42" pathLength="100"></circle><circle class="ring-progress" cx="50" cy="50" r="42" pathLength="100"></circle></svg><div class="ring-core"><strong id="wRingVal">–</strong><span>上下文</span></div></div><div class="w-overview-data"><div class="w-token-main"><span>本会话总 Token</span><b id="wTokTotal">–</b></div><div class="w-context-side"><div class="hit"><span>平均缓存命中率</span><b id="wHitAvg">–</b></div><div class="cost"><span>本会话总费用</span><b id="wCost">–</b></div></div></div></div><div class="card w-remaining" data-detail="remaining" data-block="context"><div class="row"><span>上下文余量</span><b id="wWindow">–</b></div><div class="track"><i id="wRemTrack"></i><em id="wThresholdMark"></em><span class="w-th-label" id="wThresholdLabel">80%</span></div><div class="w-rem-foot"><span id="wUsed">已用 –</span><span id="wRem">距压缩 –</span></div></div><div class="w-turn-grid"><div class="card" data-detail="turn" data-block="turnTokens"><span>当前轮 Token</span><b id="wTokRound">–</b></div><div class="card" data-detail="turn" data-block="turnHit"><span>当前轮缓存命中</span><b id="wHitRound">–</b></div><div class="card" data-detail="turn" data-block="turnCost"><span>当前轮费用</span><b id="wCostRound">–</b></div><div class="card" data-detail="turn" data-block="turnRound"><span>轮次</span><b id="wTurnsRound">–</b></div></div><div class="card w-composition" data-detail="composition" data-block="composition"><div class="w-comp-row"><div class="w-comp-head"><span>输入 <b id="wCompInputPct">–</b></span><span>输出 <b id="wCompOutputPct">–</b></span></div><div class="w-comp-track"><i class="input" id="wCompInputBar"></i><i class="output" id="wCompOutputBar"></i></div></div><div class="w-comp-row"><div class="w-comp-head"><span>命中 <b id="wCompHitPct">–</b></span><span>未命中 <b id="wCompMissPct">–</b></span></div><div class="w-comp-track"><i class="hit" id="wCompHitBar"></i><i class="miss" id="wCompMissBar"></i></div></div></div><div id="wProviderShare" data-block="providers"></div><div id="wProviders" data-block="providers"></div><div id="wQuotaList" data-block="providers"></div></div><div class="w-detail-overlay" id="wDetail" hidden><div class="w-detail-card glass"><div class="w-detail-head"><b id="wDetailTitle">详情</b><span class="w-detail-range" id="wDetailRange" hidden></span><button data-detail-close>关闭</button></div><div id="wDetailBody"></div></div></div>`;

const WIDGET_BLOCK_IDS=['overview','context','turnTokens','turnHit','turnCost','turnRound','composition','providers'];
/** 按配置显隐实时用量卡片的区块；配置缺失或读取失败时保持全开。 */
function applyWidgetBlocks(on){
  const set=Array.isArray(on)?new Set(on):null;
  for(const id of WIDGET_BLOCK_IDS){
    const visible=!set||set.has(id);
    document.querySelectorAll('[data-block="'+id+'"]').forEach(el=>{
      el.hidden=!visible;
      // 这些块自身带 display（grid/flex），UA 的 [hidden]{display:none} 会被作者样式盖掉，
      // 所以显隐同时落到内联样式上，优先级最高。
      el.style.display=visible?'':'none';
    });
  }
  // 当前轮那一组的列数跟着实际开启的格数走：不让任何一格单独掉到下一行。
  // （写死两列会在只开三个时空出一格；CSS 里的 auto-fit 会在窄卡片上塞三列、第四格掉行）
  layoutTurnGrid();
}

/** 当前轮分组：1/2/3 格各占一行；4 格时够宽就一行四个，窄了就 2×2 —— 两者都不留空位 */
function layoutTurnGrid(){
  const grid=document.querySelector('.w-turn-grid');
  if(!grid)return;
  const n=[...grid.querySelectorAll('.card')].filter(el=>!el.hidden).length;
  const cols=n<=3?Math.max(1,n):(grid.clientWidth/4>=100?4:2);
  grid.style.gridTemplateColumns='repeat('+cols+', minmax(0, 1fr))';
}
async function loadWidgetBlocks(){
  try{const j=await fetchJson("/api/widget-config");if(j&&Array.isArray(j.on))applyWidgetBlocks(j.on);}catch{}
}
// 设置页保存后通过 localStorage 广播（同源 iframe 会收到 storage 事件），卡片不需轮询就能跟着变。
if(surface==='widget'){window.addEventListener('storage',e=>{if(e.key==='si-widget-layout')loadWidgetBlocks();});
  // 卡片宽度是用户拖的，宽度变了要重算列数与详情头部的一行/两行
  window.addEventListener('resize',()=>{layoutTurnGrid();layoutTurnHead();fitHeroNumbers();});}

const shell=surface==='widget'?widgetShell():pageShell();
root.style.minHeight='100vh';root.innerHTML=shell;
if(surface==='widget')loadWidgetBlocks();
initPageEvents();
initChartWidthGuard();
window.addEventListener('resize',positionSessionMenu);document.addEventListener('scroll',positionSessionMenu,true);
// 光晕：不能只靠 requestAnimationFrame 排队——iframe 挂起时 rAF 会被浏览器丢弃，
// 而 glowRaf 变量会卡在非空，之后永远不再排队，光晕就死在最后那张卡片上不灭。
// 改为「rAF + 定时兜底」双路径，两者谁都跑得成就行。
document.addEventListener('mousemove',e=>{glowMx=e.clientX;glowMy=e.clientY;const ctrl=e.target.closest('.seg,.nav');if(ctrl){const r=ctrl.getBoundingClientRect();ctrl.style.setProperty('--mx',(e.clientX-r.left)+'px');ctrl.style.setProperty('--my',(e.clientY-r.top)+'px');}if(glowRaf)return;const token={};glowRaf=token;const run=()=>{if(glowRaf!==token)return;glowRaf=null;updateGlow();};if(window.requestAnimationFrame)requestAnimationFrame(run);setTimeout(run,240);});

let pageProvSig=null;
const provSigOf=j=>(Array.isArray(j?.providers)?j.providers:[]).map(p=>p.id+"["+(p.models||[]).join(",")+"]").sort().join("|");
// 供应商配置哨兵：只轮询 /api/providers（纯本地读盘，开销极小）。
// 宿主里增删供应商或改模型清单后，最多 4 秒卡片就跟着增删，不用等整页 10 秒轮询。
async function watchProviders(){
  if(document.hidden)return;
  let j=null;try{j=await fetchJson("/api/providers");}catch{return;}
  const list=Array.isArray(j?.providers)?j.providers:null;if(!list)return;
  const sig=provSigOf(j);
  if(pageProvSig===null){pageProvSig=sig;return;}
  if(sig===pageProvSig)return;
  pageProvSig=sig;
  state.providers=j;
  const r=await fetchJson("/api/balance",12000).catch(()=>null);
  if(r&&Array.isArray(r.balances))state.balance=r;
  renderApiOverview();renderApiDetail();
}
// 字体就绪再上滚动结构：od 的垂直补偿是“实测当前字体下沉量”算出来的，
// 字体没到位时量的是后备字体，量出来的偏移自然不一样——纯文本态与滚动结构态就会差一截。
// 这里在首次渲染前等一次字体（封顶 600ms，字体拿不到不阻塞），字体到位后再安静重渲染一次，
// 让度量重的部分（滚动结构 + 对齐）用真字体重算。
function fontsReady(ms){return new Promise(res=>{let done=false;const fin=()=>{if(done)return;done=true;res();};try{if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fin);}catch(e){}setTimeout(fin,ms);});}
async function start(){hana.ready();await fontsReady(600);if(surface==='widget'){window.addEventListener('message',onHostContextSwitch);activeSessionFile=await getFocusedSessionFile();await loadWidget();watchOdometers();watchWidgetGap();const ft=setInterval(syncFocusedSession,500),rt=setInterval(loadWidget,5000),bs=setInterval(checkBuildStamp,6000),wt=setInterval(pollWidgetTotals,1000);window.addEventListener('beforeunload',()=>{clearInterval(ft);clearInterval(rt);clearInterval(bs);clearInterval(wt);},{once:true});}else{await loadPage(false);watchOdometers();requestAnimationFrame(()=>requestAnimationFrame(()=>animateNumbers(root)));const rt=setInterval(()=>loadPage(false),10000);const pw=setInterval(watchProviders,4000);const bs=setInterval(checkBuildStamp,6000);const ht=setInterval(pollHeroStats,1000);window.addEventListener('beforeunload',()=>{clearInterval(rt);clearInterval(pw);clearInterval(bs);clearInterval(ht);},{once:true});if(document.fonts&&document.fonts.ready)document.fonts.ready.then(()=>{if(surface!=='widget')paintQuiet(()=>renderPageAll(true),true);});}}
start().catch(()=>{if(surface==='widget')renderWidget();else renderPageAll();});
// 进页面自检一次更新：有新版才弹窗，没有就什么都不做（与设置页共用同一套弹窗）
initUpdateNotice();