// check-providers.mjs —— 只读诊断：用真实 Hana 数据根跑一次 /api/providers，
// 列出插件认定的启用供应商与「本地/云端」分类。不输出任何密钥内容。
// 用法: node scripts/check-providers.mjs
import { existsSync } from "node:fs";
import { join } from "node:path";
import registerPluginApiRoutes from "../routes/api.js";

// 宿主自带 hono，但插件目录不一定有自己的 node_modules，这里按候选路径探测（可用 HONO_PATH 覆盖）
const HONO_CANDIDATES = [
  process.env.HONO_PATH,
  "D:/AI/Hanako/tools/mcp-chrome-bridge/node_modules/hono/dist/index.js",
  "D:/AI/Hanako/plugins/dsh-hanako/node_modules/hono/dist/index.js",
  "D:/AI/Hanako/plugin-data/dsh-hanako/dsh-home/profiles/node_modules/hono/dist/index.js",
].filter(Boolean);
const honoPath = HONO_CANDIDATES.find((p) => existsSync(p));
if (!honoPath) throw new Error("找不到 hono，可用 HONO_PATH 指定 hono/dist/index.js 路径");
const { Hono } = await import("file:///" + honoPath.replace(/\\/g, "/"));

const HANA_HOME = process.env.HANA_HOME || "D:/AI/Hanako";
// --verify：真打一次各家接口，看余额/配额门路是否还有效（不加这个参数只读配置，不触网）
const VERIFY = process.argv.includes("--verify");
const ctx = {
  pluginDir: join(HANA_HOME, "plugins", "session-insight"),
  dataDir: join(HANA_HOME, "plugin-data", "session-insight"),
  config: { get: () => null },
  network: VERIFY
    ? { fetch: (url, opts) => fetch(url, opts) }
    : { fetch: async () => new Response("{}", { status: 200 }) },
  sessionId: null,
  sessionPath: null,
};

for (const f of ["provider-catalog.json", "models.json", "auth.json"]) {
  console.log(`  ${f.padEnd(24)} ${existsSync(join(HANA_HOME, f)) ? "存在" : "缺失"}`);
}
console.log("");

const app = new Hono();
registerPluginApiRoutes(app, ctx);
const r = await (await app.request("/api/providers")).json();
const list = r.providers || [];
console.log(`插件认定已启用供应商：${list.length} 家   (hono=${honoPath})`);
for (const p of list) {
  const extra = [p.links?.length ? `链接=${p.links.map((l) => l.label).join("/")}` : "", p.launch ? `可启动=${p.launch.label}` : ""].filter(Boolean).join("  ");
  console.log(`  ${p.local ? "[本地]" : "[云端]"} ${String(p.id).padEnd(14)} baseUrl=${p.baseUrl || "(无)"}  models=${(p.models || []).join(", ")}${extra ? "  " + extra : ""}`);
}
const local = list.filter((p) => p.local).map((p) => p.id);
console.log("");
console.log("会显示粉色灯（本地部署）：" + (local.join(", ") || "(无)"));

console.log("");
console.log("本地应用启动目标（dry=1，只看命令，不实际启动）：");
for (const id of local) {
  const r = await (await app.request(`/api/open-app?provider=${encodeURIComponent(id)}&dry=1`)).json();
  console.log(`  ${id.padEnd(12)} ${JSON.stringify(r)}`);
}
console.log("拒绝非本地供应商：");
for (const bad of ["deepseek", "not-exist", "../../windows/system32/cmd"]) {
  const r = await (await app.request(`/api/open-app?provider=${encodeURIComponent(bad)}&dry=1`)).json();
  console.log(`  ${String(bad).padEnd(28)} ${JSON.stringify(r)}`);
}

if (VERIFY) {
  console.log("");
  console.log("真实探测 /api/balance（会打各家接口，force=1）：");
  try {
    const bal = await (await app.request("/api/balance?force=1")).json();
    for (const b of bal.balances || []) {
      console.log(`  查到    ${String(b.provider).padEnd(14)} ${String(b.status).padEnd(10)} ${b.summary || b.detail || ""}`);
    }
    for (const u of bal.unsupported || []) {
      console.log(`  未查到  ${String(u.provider).padEnd(14)} reachable=${u.reachable}  ${u.note}`);
    }
  } catch (e) {
    console.log("  探测失败：" + (e?.message || e));
  }
}
