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
const ctx = {
  pluginDir: join(HANA_HOME, "plugins", "session-insight"),
  dataDir: join(HANA_HOME, "plugin-data", "session-insight"),
  config: { get: () => null },
  network: { fetch: async () => new Response("{}", { status: 200 }) }, // 不触网，只验配置解析
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
  console.log(`  ${p.local ? "[本地]" : "[云端]"} ${String(p.id).padEnd(14)} baseUrl=${p.baseUrl || "(无)"}  models=${(p.models || []).join(", ")}`);
}
const local = list.filter((p) => p.local).map((p) => p.id);
console.log("");
console.log("会显示粉色灯（本地部署）：" + (local.join(", ") || "(无)"));
