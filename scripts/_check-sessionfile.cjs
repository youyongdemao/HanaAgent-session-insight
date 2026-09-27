// _check-sessionfile.cjs —— 验证会话文件解析缓存：命中不再读盘、结果一致、互不污染
const fs = require("fs");
const path = require("path");

(async () => {
  const { buildStatsFromSessionFile } = await import("../lib/host-data.js");
  const dir = "D:/AI/Hanako/agents/hanako/sessions";
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f, p: path.join(dir, f), s: fs.statSync(path.join(dir, f)).size }))
    .filter((x) => x.s > 20000 && x.s < 900000)
    .sort((a, b) => b.s - a.s);
  if (!files.length) { console.log("没找到合适的会话文件"); return; }
  const target = files[0];
  console.log("测试文件:", target.f, (target.s / 1024).toFixed(0) + "KB");

  const content = fs.readFileSync(target.p);
  let reads = 0, bytes = 0;
  const sdk = {
    resources: { read: async () => { reads++; bytes += content.length; return { content }; } },
    logger: { warn: async () => {} },
  };

  const stableMtime = Date.now() - 10 * 60e3; // 10 分钟前改过 → 可缓存
  const t0 = Date.now();
  const a = await buildStatsFromSessionFile(sdk, target.p, 200, stableMtime);
  const firstMs = Date.now() - t0;
  const t1 = Date.now();
  const b = await buildStatsFromSessionFile(sdk, target.p, 200, stableMtime);
  const secondMs = Date.now() - t1;

  console.log("\n--- 稳定文件（10 分钟前改过）---");
  console.log("  首次: " + firstMs + "ms   读取 " + reads + " 次");
  console.log("  二次: " + secondMs + "ms   读取 " + reads + " 次（期望仍为 1）");
  console.log("  结果一致: " + (JSON.stringify(a) === JSON.stringify(b)));
  console.log("  轮数 " + a?.turns + "  tokens " + a?.sessionTokens + "  source " + a?.source);

  console.log("\n--- 刚改过的文件（1 秒前）不应缓存 ---");
  const before = reads;
  await buildStatsFromSessionFile(sdk, target.p, 200, Date.now() - 1000);
  await buildStatsFromSessionFile(sdk, target.p, 200, Date.now() - 1000);
  console.log("  两次调用新增读取: " + (reads - before) + " 次（期望 2）");

  console.log("\n--- 返回对象互不污染 ---");
  a.title = "被人改过";
  const c = await buildStatsFromSessionFile(sdk, target.p, 200, stableMtime);
  console.log("  缓存里的 title 是否被污染: " + (c?.title === "被人改过"));

  console.log("\n累计读盘: " + reads + " 次 / " + (bytes / 1024 / 1024).toFixed(2) + "MB");
})();
