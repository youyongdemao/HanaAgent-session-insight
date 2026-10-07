// scripts/_probe-cloud-balance.mjs —— 云账户余额：签名向量 + 火山真实调用（临时探针）
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { aliyunSignature, CLOUD_ADAPTERS } from "../lib/cloud-balance.js";

let fail = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${ok ? "" : `  got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`}`);
}

// 阿里云官方文档给出的测试向量：算出的签名必须逐字相同
const aliyunVector = {
  AccessKeyId: "testid",
  Action: "DescribeDedicatedHosts",
  Format: "JSON",
  RegionId: "cn-beijing",
  SignatureMethod: "HMAC-SHA1",
  SignatureNonce: "edb2b34af0af9a6d14deaf7c1a5315eb",
  SignatureVersion: "1.0",
  Timestamp: "2023-03-13T08:34:30Z",
  Version: "2014-05-26",
};
eq("阿里云官方测试向量", aliyunSignature(aliyunVector, "testsecret"), "9NaGiOspFP5UPcwX8Iwt2YJXXuk=");

// 火山云账户余额：用本机已配的 AK/SK 真打一发
const cfg = JSON.parse(readFileSync("D:/AI/Hanako/app-data/session-insight/config.json", "utf8"));
function curlFetch(url, opts) {
  return new Promise((resolve) => {
    const args = ["--noproxy", "*", "-sS", "-X", String(opts?.method || "GET").toUpperCase(), "--max-time", "12", "-w", "\n__HTTP__%{http_code}"];
    for (const [k, v] of Object.entries(opts?.headers || {})) args.push("-H", `${k}: ${v}`);
    if (opts?.body) args.push("--data-binary", String(opts.body));
    args.push(url);
    let buf = "";
    const c = spawn("curl.exe", args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    c.stdout.on("data", (d) => { buf += d; });
    c.on("close", () => {
      const m = buf.match(/__HTTP__(\d+)\s*$/);
      const status = m ? Number(m[1]) : 0;
      resolve({ ok: status >= 200 && status < 300, status, text: async () => (m ? buf.slice(0, m.index) : buf).trim() });
    });
  });
}

const v = await CLOUD_ADAPTERS.volcengine.run(
  curlFetch,
  (cfg.volcengineAccessKey || "").trim(),
  (cfg.volcengineSecretKey || "").trim(),
  12000
);
console.log("火山云账户余额 ->", JSON.stringify(v));

console.log(fail ? `\n${fail} 项未通过` : "\n签名向量通过");
process.exit(fail ? 1 : 0);
