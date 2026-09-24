// measure-od-shift.cjs —— 量化滚动数字（odometer）动画期间是否推动 hero 布局
// 用法: node scripts/measure-od-shift.cjs
// 做法：用真实 panel-v2.css 渲染 API hero 的真实 DOM，先量静止态，再把 <b> 换成动画态的
//       内联样式结构（与 odometer() 生成的完全一致），再量一次，输出差值。
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const CSS = path.join(REPO, "ui", "assets", "panel-v2.css");
const OUT_JSON = path.join(REPO, "..", "_od-shift.json");
const FIX = process.env.FIX || "none";
const FIX_CSS = {
  none: "",
  // A：把动画目标锁成固定高度的块，动画态多出来的行盒高度不再计入布局
  A: ".ah-num{display:block;height:1.05em}",
  // B：让滚动盒改用顶对齐，不再把字体的 descent 空间算进行盒
  B: ".od{vertical-align:top}",
  // C：同时锁高度并顶对齐
  C: ".ah-num{display:block;height:1.05em}.od{vertical-align:top}",
  // D：顶对齐 + 把滚动盒微下移，让字形基线回到与静止文本一致的位置
  D: ".od{vertical-align:top;top:.025em}",
  // E：D 加锁高度
  E: ".ah-num{display:block;height:1.05em}.od{vertical-align:top;top:.025em}",
}[FIX] || "";
const SHOT_DIR = path.join(REPO, "..", "_od-shots");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 8799;

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/panel-v2.css">
<style>${FIX_CSS}</style>
</head><body data-hana-theme="dark" data-surface="page">
<div class="hero-pricing"><div class="api-hero">
  <div class="ah-block">
    <div class="ah-top"><span class="ah-label">总消耗</span></div>
    <b class="ah-num" id="tCost">–</b>
    <div class="ah-token-block"><span class="ah-label">总消耗 Token</span><b class="ah-token-num" id="tCostSub">–</b></div>
  </div>
  <div class="ah-divider"></div>
  <div class="ah-block">
    <div class="ah-top"><span class="ah-label">总余额</span></div>
    <b class="ah-num ah-bal" id="tBal">–</b>
    <div class="ah-bal-list" id="tBalSub">
      <div class="bl-row"><span>DeepSeek</span><b>¥97.35</b></div>
      <div class="bl-row"><span>Moonshot</span><b>¥43.84</b></div>
      <div class="bl-row"><span>ChatGPT Plus / Pro</span><b>5h 0% · 7d 0%</b></div>
    </div>
    <div class="ah-upd" id="balUpdated">刚刚更新</div>
  </div>
</div></div>
</body></html>`;

const MEASURE = `(() => {
  const q = (s) => document.querySelector(s);
  const r = (el) => { const b = el.getBoundingClientRect(); return { top: +b.top.toFixed(3), height: +b.height.toFixed(3), bottom: +b.bottom.toFixed(3) }; };
  return {
    hero: r(q('.api-hero')),
    block2: r(q('#tBal').closest('.ah-block')),
    num: r(q('#tBal')),
    list: r(q('#tBalSub')),
    upd: r(q('#balUpdated')),
  };
})()`;

// 与 odometer() 生成的内联样式一致：每个数字一个 inline-block，内含 0-9 的竖条
const TO_ANIMATED = `(() => {
  const el = document.getElementById('tBal');
  const str = '¥313.09';
  el.style.whiteSpace = 'nowrap';
  const MASK = '-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 20%,#000 80%,transparent 100%);mask-image:linear-gradient(to bottom,transparent 0,#000 20%,#000 80%,transparent 100%)';
  const frag = document.createDocumentFragment();
  for (const ch of str) {
    if (ch >= '0' && ch <= '9') {
      const od = document.createElement('span');
      od.className = 'od';
      od.style.cssText = 'display:inline-block;position:relative;overflow:hidden;height:1em;line-height:1em;text-align:center;font-size:inherit;font-family:inherit;font-weight:inherit;color:inherit;' + MASK;
      const strip = document.createElement('span');
      strip.className = 'od-strip';
      strip.style.cssText = 'display:block;will-change:transform';
      for (let i = 0; i <= 9; i++) {
        const d = document.createElement('span');
        d.className = 'od-d';
        d.style.cssText = 'display:block;height:1em;line-height:1em;text-align:center';
        d.textContent = String(i);
        strip.appendChild(d);
      }
      od.appendChild(strip);
      frag.appendChild(od);
    } else {
      frag.appendChild(document.createTextNode(ch));
    }
  }
  el.textContent = '';
  el.appendChild(frag);
  return true;
})()`;

// 字形基线测量：把两态折算到同一个口径（行盒顶 + 半行距 + 字形上升），比较基线位置
const BASELINE = `(() => {
  const el = document.getElementById('tBal');
  const cs = getComputedStyle(el);
  const fs = parseFloat(cs.fontSize);
  const cv = document.createElement('canvas').getContext('2d');
  cv.font = cs.fontWeight + ' ' + fs + 'px ' + cs.fontFamily;
  const m = cv.measureText('1');
  const A = m.fontBoundingBoxAscent, D = m.fontBoundingBoxDescent;
  const od = el.querySelector('.od');
  if (!od) {
    // 静止态：取第一个数字字符，用它的行盒折算基线
    const tn = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    const txt = tn.textContent, i = txt.search(/[0-9]/);
    const r = document.createRange(); r.setStart(tn, i); r.setEnd(tn, i + 1);
    const rr = r.getBoundingClientRect();
    return { fs, A, D, boxTop: +rr.top.toFixed(3), boxHeight: +rr.height.toFixed(3), baseline: +(rr.top + (rr.height - (A + D)) / 2 + A).toFixed(3) };
  }
  // 动画态：取第一个数字条（它是 1em 高的行盒，line-height:1em）
  const d = od.querySelector('.od-d');
  const dr = d.getBoundingClientRect();
  const odr = od.getBoundingClientRect();
  return { fs, A, D, boxTop: +odr.top.toFixed(3), boxHeight: +odr.height.toFixed(3), digitTop: +dr.top.toFixed(3), baseline: +(dr.top + (dr.height - (A + D)) / 2 + A).toFixed(3) };
})()`;

function startServer() {
  const srv = http.createServer((req, res) => {
    const p = new URL(req.url, "http://127.0.0.1").pathname;
    if (p === "/" || p === "/index.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(HTML); }
    if (p === "/panel-v2.css") { res.writeHead(200, { "Content-Type": "text/css" }); return res.end(fs.readFileSync(CSS)); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(PORT, "127.0.0.1", () => r(srv)));
}
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
async function waitChrome(port, tries = 80) { for (let i = 0; i < tries; i++) { try { return await httpJson(`http://127.0.0.1:${port}/json/version`); } catch { await sleep(300); } } throw new Error("chrome 未就绪"); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
  async eval(expression) { const r = await this.send("Runtime.evaluate", { expression, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result.value; }
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-measure-"));
  const srv = await startServer();
  const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  if (!fs.existsSync(chromePath)) { console.error("找不到 Chrome"); srv.close(); return; }
  const proc = spawn(chromePath, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--window-size=1500,1200", "--remote-debugging-port=9339", "--user-data-dir=" + path.join(TMP, "profile"), "about:blank"], { stdio: "ignore" });
  try {
    await waitChrome(9339);
    const list = await httpJson("http://127.0.0.1:9339/json/list");
    const page = list.find((t) => t.type === "page");
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const c = new CDP(ws);
    await c.send("Page.enable"); await c.send("Runtime.enable");
    await c.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1200, deviceScaleFactor: 1, mobile: false });
    await c.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    await sleep(1200);
    await c.eval(`const b=document.getElementById('tBal');b.textContent='¥313.09';b.classList.add('od-host')`);
    await sleep(80);
    const idle = await c.eval(MEASURE);
    const idleBase = await c.eval(BASELINE);
    let idleShot = null;
    if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });
    {
      const clip = await c.eval(`(()=>{const b=document.getElementById('tBal').getBoundingClientRect();return {x:b.x-4,y:b.y-12,width:b.width+8,height:b.height+24,scale:3}})()`);
      idleShot = (await c.send("Page.captureScreenshot", { format: "png", clip })).data;
      fs.writeFileSync(path.join(SHOT_DIR, FIX + "-idle.png"), Buffer.from(idleShot, "base64"));
    }
    await c.eval(TO_ANIMATED);
    // 模拟真实页面的 alignNumbers：用 transform 把滚动盒下移一个 descent，使数字与旁边标点对齐
    const align = await c.eval(`(() => {
  const el = document.getElementById('tBal');
  const cs = getComputedStyle(el);
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = (cs.fontStyle||'normal') + ' ' + (cs.fontWeight||'400') + ' ' + (cs.fontSize||'16px') + ' ' + (cs.fontFamily||'monospace');
  const m = ctx.measureText('0');
  const a = m.fontBoundingBoxAscent, d = m.fontBoundingBoxDescent;
  const fs = parseFloat(cs.fontSize) || 16;
  const dd = (fs - (a + d)) / 2 + d;
  const dsp = getComputedStyle(el).display;
  el.querySelectorAll('.od').forEach((od) => {
    if (dsp === 'flex' || dsp === 'inline-flex') od.style.transform = '';
    else if (dd > 0) od.style.transform = 'translateY(' + dd.toFixed(2) + 'px)';
  });
  return { descent: +dd.toFixed(2), display: dsp, hosts: el.classList.contains('od-host'), hostHeight: cs.height };
})()`);
    await sleep(120);
    const anim = await c.eval(MEASURE);
    const animBase = await c.eval(BASELINE);
    {
      const clip = await c.eval(`(()=>{const b=document.getElementById('tBal').getBoundingClientRect();return {x:b.x-4,y:b.y-12,width:b.width+8,height:b.height+24,scale:3}})()`);
      const s = (await c.send("Page.captureScreenshot", { format: "png", clip })).data;
      fs.writeFileSync(path.join(SHOT_DIR, FIX + "-anim.png"), Buffer.from(s, "base64"));
    }
    const d = {};
    for (const k of Object.keys(idle)) {
      d[k] = { top: +(anim[k].top - idle[k].top).toFixed(3), height: +(anim[k].height - idle[k].height).toFixed(3), bottom: +(anim[k].bottom - idle[k].bottom).toFixed(3) };
    }
    const out = { fix: FIX, idle, anim, delta: d, align, baseline: { idle: idleBase, anim: animBase, diff: +(animBase.baseline - idleBase.baseline).toFixed(3) }, fonts: await c.eval(`(() => {
  const b = document.getElementById('tBal');
  const od = b.querySelector('.od');
  const dd = od && od.querySelector('.od-d');
  const cs = (el) => el ? getComputedStyle(el) : null;
  return {
    rootMono: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim(),
    b: cs(b).fontFamily,
    bFont: cs(b).font,
    od: od ? cs(od).fontFamily : null,
    odD: dd ? cs(dd).fontFamily : null,
  };
})()`), fontSize: await c.eval(`getComputedStyle(document.getElementById('tBal')).fontSize`), lineHeight: await c.eval(`getComputedStyle(document.getElementById('tBal')).lineHeight`) };
    fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    ws.close();
  } catch (e) {
    console.error("MEASURE ERROR:", (e && e.stack) || e);
  } finally {
    proc.kill(); srv.close();
    await sleep(300);
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
})();
