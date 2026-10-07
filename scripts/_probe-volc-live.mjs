// scripts/_probe-volc-live.mjs —— 用本机已配置的 AK/SK，经 curl 子进程打真实火山 OpenAPI（临时探针）
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { queryVolcenginePlan } from "../lib/volcengine-plan.js";

const cfg = JSON.parse(readFileSync("D:/AI/Hanako/app-data/session-insight/config.json", "utf8"));

function curlPost(url, headers) {
  return new Promise((resolve) => {
    const args = ["--noproxy", "*", "-sS", "-X", "POST", "--max-time", "12", "-w", "\n__HTTP__%{http_code}"];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    args.push(url);
    let buf = "";
    let done = false;
    const child = spawn("curl.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const timer = setTimeout(() => { try { child.kill(); } catch {} if (!done) { done = true; resolve(null); } }, 15000);
    child.stdout.on("data", (c) => { buf += c; });
    child.on("error", () => { clearTimeout(timer); if (!done) { done = true; resolve(null); } });
    child.on("close", () => {
      clearTimeout(timer);
      if (done) return;
      done = true;
      const m = buf.match(/__HTTP__(\d+)\s*$/);
      const status = m ? Number(m[1]) : 0;
      const body = m ? buf.slice(0, m.index) : buf;
      console.log(`   [curl] ${new URL(url).searchParams.get("Action")} -> HTTP ${status} · ${String(body).slice(0, 260).replace(/\s+/g, " ")}`);
      resolve({ ok: status >= 200 && status < 300, status, text: async () => body });
    });
  });
}

const ak = (cfg.volcengineAccessKey || "").trim();
const sk = (cfg.volcengineSecretKey || "").trim();
console.log("cred len ak=" + ak.length + " sk=" + sk.length + " (内容不打印)");

const r = await queryVolcenginePlan({
  fetchFn: (url, opts) => curlPost(url, opts?.headers || {}),
  accessKeyId: ak,
  secretAccessKey: sk,
  baseUrl: "https://ark.cn-beijing.volces.com/api/coding",
  timeoutMs: 12000,
});
console.log(JSON.stringify(r, null, 2).slice(0, 1500));
