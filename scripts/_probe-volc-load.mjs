// scripts/_probe-volc-load.mjs —— 确认改动后的模块能被真的加载（顶层无副作用、import 链通）
await import("../lib/provider-directory.js");
await import("../lib/volcengine-plan.js");
await import("../lib/legacy-api.js");
const { PROVIDER_DIRECTORY } = await import("../lib/provider-directory.js");
const q = PROVIDER_DIRECTORY["volcengine-coding"].query;
console.log("load ok · volcengine-coding:", q.kind, "reachable=" + q.reachable, "keys=" + q.keys.length);
