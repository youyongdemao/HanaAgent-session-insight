// scripts/_probe-volc-raw.mjs —— 打印两个 action 的完整原始响应（临时探针）
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { signRequest } from "../lib/volcengine-plan.js";

const cfg = JSON.parse(readFileSync("D:/AI/Hanako/app-data/session-insight/config.json", "utf8"));
const ak = (cfg.volcengineAccessKey || "").trim();
const sk = (cfg.volcengineSecretKey || "").trim();

function curlRaw(url, headers) {
  return new Promise((resolve) => {
    const args = ["--noproxy", "*", "-sS", "-X", "POST", "--max-time", "15", "-w", "\n__HTTP__%{http_code}"];
    for (const [k, v] of Object.entries(headers)) args.push("-H", `${k}: ${v}`);
    args.push(url);
    let buf = "";
    const child = spawn("curl.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (c) => { buf += c; });
    child.on("close", () => {
      const m = buf.match(/__HTTP__(\d+)\s*$/);
      resolve({ status: m ? Number(m[1]) : 0, body: m ? buf.slice(0, m.index).trim() : buf.trim() });
    });
  });
}

const HOST = "open.volcengineapi.com";
const REGION = "cn-beijing";
for (const [action, version] of [
  ["GetAFPUsage", "2024-01-01"],
  ["GetCodingPlanUsage", "2024-01-01"],
]) {
  const query = `Action=${action}&Region=${REGION}&Version=${version}`;
  const url = `https://${HOST}/?${query}`;
  const s = signRequest({ accessKeyId: ak, secretAccessKey: sk, region: REGION, canonicalQueryStr: query, body: "" });
  const r = await curlRaw(url, {
    "X-Date": s.xDate,
    "X-Content-Sha256": s.xContentSha256,
    "Content-Type": "application/json; charset=utf-8",
    Authorization: s.authorization,
  });
  console.log(`=== ${action} (Version ${version}) -> HTTP ${r.status}`);
  console.log(r.body);
  console.log("");
}
