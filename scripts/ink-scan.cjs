// ink-scan.cjs —— 从 PNG 里量「文字实际墨迹所占的行区间」
// 用法：
//   node scripts/ink-scan.cjs <png路径> [背景阈值，默认14]
//   ABS=110 node scripts/ink-scan.cjs <png路径>        # 绝对亮度阈值：只算比 110 亮的像素（用来剥掉光晕）
// 输出：把连续有墨迹的行并成 band（起止行、高、横向墨迹范围、峰值像素数），band 之间就是视觉空档。
// 用途：判断某个数字/标签实际占了哪几行、上下空档各多少 px，比读 DOM 盒子更接近眼睛看到的。
// 说明：像素统计拿不到字形墨迹的精确边界（drop-shadow 光晕会外扩十几像素），
//      所以比较两个状态时要保持同一阈值，只看相对变化。
const http = require("http"), fs = require("fs"), path = require("path"), os = require("os");
const { spawn } = require("child_process");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILE = path.resolve(process.argv[2]);
const DIFF = Number(process.argv[3] || 14);
const ABS = process.env.ABS ? Number(process.env.ABS) : null;

const srv = http.createServer((req, res) => {
  const data = fs.readFileSync(FILE);
  res.writeHead(200, { "Content-Type": "image/png", "Content-Length": data.length, "Cache-Control": "no-store" });
  res.end(data);
});
function httpJson(url) { return new Promise((res, rej) => { http.get(url, (r) => { let d = ""; r.on("data", (c) => (d += c)); r.on("end", () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on("error", rej); }); }
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && this.pend.has(m.id)) { const { res, rej } = this.pend.get(m.id); this.pend.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); } }); }
  send(m, p = {}) { const id = ++this.id; return new Promise((res, rej) => { this.pend.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method: m, params: p })); }); }
}
(async () => {
  await new Promise((r) => srv.listen(8891, "127.0.0.1", r));
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "si-ink-"));
  const proc = spawn("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", ["--headless=new", "--disable-gpu", "--no-first-run", "--remote-debugging-port=9371", "--user-data-dir=" + path.join(TMP, "p"), "about:blank"], { stdio: "ignore" });
  try {
    let t = null;
    for (let i = 0; i < 60 && !t; i++) { const l = await httpJson("http://127.0.0.1:9371/json/list").catch(() => null); t = (l || []).find((x) => x.type === "page" && x.webSocketDebuggerUrl); if (!t) await sleep(250); }
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
    const cdp = new CDP(ws);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.navigate", { url: "http://127.0.0.1:8891/img.png" });
    await sleep(900);
    const test = ABS == null ? `Math.abs(L[x]-bg)>${DIFF}` : `L[x]>${ABS}`;
    const expr = `(()=>{
      const img=document.querySelector('img');
      if(!img||!img.naturalWidth) return {err:'no img'};
      const cv=document.createElement('canvas');cv.width=img.naturalWidth;cv.height=img.naturalHeight;
      const cx=cv.getContext('2d');cx.drawImage(img,0,0);
      const {data,width:w,height:h}=cx.getImageData(0,0,cv.width,cv.height);
      const lum=i=>0.299*data[i]+0.587*data[i+1]+0.114*data[i+2];
      const rows=[];
      for(let y=0;y<h;y++){
        const L=[];for(let x=0;x<w;x++){const i=(y*w+x)*4;L.push(lum(i));}
        const s=L.slice().sort((a,b)=>a-b);const bg=s[Math.floor(s.length/2)];
        let n=0,minx=w,maxx=-1;
        for(let x=0;x<w;x++){if(${test}){n++;if(x<minx)minx=x;if(x>maxx)maxx=x;}}
        rows.push({y,n,minx:maxx>=0?minx:null,maxx:maxx>=0?maxx:null,bg:Math.round(bg)});
      }
      return {w,h,rows};
    })()`;
    const r = await cdp.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    const v = r.result?.value;
    if (!v || v.err) { console.log("FAIL", JSON.stringify(v)); return; }
    console.log(`size ${v.w}x${v.h}${ABS == null ? `  (背景差 > ${DIFF})` : `  (绝对亮度 > ${ABS})`}`);
    const bands = [];
    let cur = null;
    for (const row of v.rows) {
      const on = row.n >= Math.max(3, v.w * 0.002);
      if (on) { if (!cur) cur = { from: row.y, to: row.y, maxN: 0, minx: v.w, maxx: 0 }; cur.to = row.y; cur.maxN = Math.max(cur.maxN, row.n); cur.minx = Math.min(cur.minx, row.minx); cur.maxx = Math.max(cur.maxx, row.maxx); }
      else if (cur) { bands.push(cur); cur = null; }
    }
    if (cur) bands.push(cur);
    bands.forEach((b, i) => console.log(`band${i}  y ${b.from}..${b.to}  高 ${b.to - b.from + 1}  墨迹列 ${b.minx}..${b.maxx}  峰值像素 ${b.maxN}`));
    for (let i = 1; i < bands.length; i++) console.log(`  空档 ${bands[i - 1].to}..${bands[i].from} = ${bands[i].from - bands[i - 1].to - 1}px`);
    ws.close();
  } finally { proc.kill(); srv.close(); await sleep(200); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} }
})();
