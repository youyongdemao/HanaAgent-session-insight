// scripts/_probe-volc-billing.mjs —— 试火山费用中心 QueryBalanceAcct（临时探针）
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { signRequest } from "../lib/volcengine-plan.js";

const cfg = JSON.parse(readFileSync("D:/AI/Hanako/app-data/session-insight/config.json", "utf8"));
const ak = (cfg.volcengineAccessKey || "").trim();
const sk = (cfg.volcengineSecretKey || "").trim();

function call(host, service, query) {
  const s = signRequest({
    accessKeyId: ak,
    secretAccessKey: sk,
    region: "cn-beijing",
    canonicalQueryStr: query,
    body: "",
    service,
    host,
  });
  const url = `https://${host}/?${query}`;
  const args = [
    "--noproxy", "*", "-sS", "-X", "POST", "--max-time", "15", "-w", "\n__HTTP__%{http_code}",
    "-H", `X-Date: ${s.xDate}`,
    "-H", `X-Content-Sha256: ${s.xContentSha256}`,
    "-H", "Content-Type: application/json; charset=utf-8",
    "-H", `Authorization: ${s.authorization}`,
    url,
  ];
  return new Promise((resolve) => {
    const c = spawn("curl.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let buf = "";
    c.stdout.on("data", (d) => { buf += d; });
    c.on("close", () => {
      const m = buf.match(/__HTTP__(\d+)\s*$/);
      resolve({ status: m ? Number(m[1]) : 0, body: m ? buf.slice(0, m.index).trim() : buf.trim() });
    });
  });
}

const query = "Action=QueryBalanceAcct&Region=cn-beijing&Version=2022-01-01";
const combos = [
  ["open.volcengineapi.com", "billing"],
  ["billing.volcengineapi.com", "billing"],
  ["billing.volcengineapi.com", "Billing"],
  ["open.volcengineapi.com", "ark"],
];
for (const [host, service] of combos) {
  const r = await call(host, service, query);
  console.log(`=== ${host} service=${service} -> HTTP ${r.status}`);
  console.log(r.body.slice(0, 500));
  console.log("");
}
