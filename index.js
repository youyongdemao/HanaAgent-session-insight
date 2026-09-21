// Session Insight v2 App — 服务端入口
// 数据源全部走宿主公开 API：session:list / session:context / usage:list / provider:credentials
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineApp } from "./sdk/app-contract/server-client.js";
import registerLegacyRoutes, { calcEntryCost } from "./lib/legacy-api.js";
import {
  listSessions,
  listSessionsCached,
  fetchSessionUsage,
  buildSessionStats,
  buildStatsFromSessionFile,
  fetchLedger,
  resolveSessionId,
  baseName,
} from "./lib/host-data.js";

export const name = "session-insight-v2";

const CACHE_MS = 3000;
let cache = { at: 0, key: "", value: null };

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeUsage(entries) {
  let totalTokens = 0;
  let sessionRequests = 0;
  let hitRatioSum = 0;
  let hitRatioCount = 0;
  let costTotal = 0;
  const byModel = new Map();

  for (const entry of entries) {
    if (entry?.attribution?.kind !== "session") continue;
    sessionRequests += 1;
    const tokens = num(entry?.usage?.totalTokens) ?? 0;
    totalTokens += tokens;
    const ratio = num(entry?.usage?.cache?.hitRatio);
    if (ratio !== null) {
      hitRatioSum += ratio;
      hitRatioCount += 1;
    }
    const hostCost = num(entry?.usage?.costTotal);
    costTotal += hostCost != null && hostCost > 0 ? hostCost : (calcEntryCost(entry) ?? 0);

    const key = `${entry?.model?.provider ?? "?"}::${entry?.model?.modelId ?? "?"}`;
    const bucket = byModel.get(key) ?? {
      provider: entry?.model?.provider ?? null,
      modelId: entry?.model?.modelId ?? null,
      requests: 0,
      totalTokens: 0,
    };
    bucket.requests += 1;
    bucket.totalTokens += tokens;
    byModel.set(key, bucket);
  }

  return {
    sessionRequests,
    totalTokens,
    cacheHitRatioAvg: hitRatioCount > 0 ? hitRatioSum / hitRatioCount : null,
    costTotal,
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

async function buildOverview(sdk, sessionId) {
  const out = {
    generatedAt: new Date().toISOString(),
    activeSessionId: sessionId ?? null,
    context: null,
    usage: null,
    sessions: null,
    paging: null,
    providers: null,
    errors: [],
  };

  const safe = async (label, fn) => {
    try {
      return await fn();
    } catch (error) {
      out.errors.push({
        label,
        code: error?.code ?? null,
        message: String(error?.message ?? error),
      });
      return null;
    }
  };

  const list = await safe("sessions.list", () =>
    sdk.sessions.list({ scope: "all", lifecycle: "active" })
  );
  if (list) {
    out.sessions = (list.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      title: s.title ?? null,
      agentId: s.agentId ?? null,
      messageCount: num(s.messageCount),
      modified: s.modified ?? null,
    }));
  }

  const targetId =
    sessionId ??
    out.sessions?.find((s) => typeof s.sessionId === "string")?.sessionId ??
    null;
  out.activeSessionId = targetId;

  if (targetId) {
    const context = await safe("sessions.context", () =>
      sdk.sessions.context({ sessionId: targetId, scope: "all" })
    );
    if (context) {
      out.context = {
        sessionId: context.sessionId,
        isStreaming: context.isStreaming ?? null,
        thinkingLevel: context.thinkingLevel ?? null,
        modelId: context.model?.id ?? null,
        provider: context.model?.provider ?? null,
        contextWindow: num(context.model?.contextWindow),
        tokens: num(context.contextUsage?.tokens),
        percent: num(context.contextUsage?.percent),
        systemPromptLength:
          typeof context.systemPrompt === "string" ? context.systemPrompt.length : null,
      };
    }

    const deep = await safe("usage.list(deep)", () =>
      sdk.usage.list({ sessionId: targetId, limit: 500 })
    );
    if (deep) {
      out.usage = summarizeUsage(deep.entries ?? []);
      out.paging = {
        fetched: (deep.entries ?? []).length,
        nextCursor: deep.nextCursor ?? null,
      };
    }
  }

  const credentials = await safe("provider.credentials", async () => {
    const result = await sdk.providers.getCredentials({ providerId: "deepseek" });
    return {
      providerId: "deepseek",
      hasApiKey: typeof result?.apiKey === "string" && result.apiKey.length > 0,
      baseUrl: result?.baseUrl ?? null,
    };
  });
  if (credentials) out.providers = [credentials];

  return out;
}

const APP_ID = "session-insight-v2";
const APP_DIR = dirname(fileURLToPath(import.meta.url));

// ── 输入栏「本轮速览」的开关清单 ──
// id 必须与 manifest.json 的 contributes.ui.inputStatus 声明一一对应；键名用于持久化，不要改名。
const LIVE_ITEMS = [
  { id: "hit", label: "缓存命中率", group: "本轮", desc: "本轮请求的缓存命中比例" },
  { id: "tps", label: "吞吐速度", group: "本轮", desc: "输出 tokens ÷ 耗时" },
  { id: "tokens", label: "Token 用量", group: "本轮", desc: "本轮消耗总量" },
  { id: "cost", label: "费用", group: "本轮", desc: "本轮折算费用" },
  { id: "duration", label: "耗时", group: "本轮", desc: "本轮墙钟耗时" },
];
// 五项默认全开；关掉的项在输入栏里不显示。
const LIVE_DEFAULT = ["hit", "tps", "tokens", "cost", "duration"];

/** 解析持久化的显示项配置；缺失或损坏时回退默认，并补上新增项。 */
function parseLiveLayout(raw) {
  const known = new Set(LIVE_ITEMS.map((i) => i.id));
  let obj = null;
  try {
    obj = typeof raw === "string" ? (raw ? JSON.parse(raw) : null) : raw;
  } catch {
    obj = null;
  }
  if (obj && Array.isArray(obj.order)) {
    // 老版本（16 项清单）留下的配置里会有现在认不出的 id，说明已经对不上了，直接回默认全开。
    if (obj.order.some((id) => typeof id === "string" && !known.has(id))) {
      return { order: LIVE_ITEMS.map((i) => i.id), on: LIVE_DEFAULT.slice() };
    }
    const order = obj.order.filter((id) => known.has(id));
    const on = Array.isArray(obj.on) ? obj.on.filter((id) => known.has(id)) : [];
    for (const it of LIVE_ITEMS) if (!order.includes(it.id)) order.push(it.id);
    return { order, on };
  }
  return { order: LIVE_ITEMS.map((i) => i.id), on: LIVE_DEFAULT.slice() };
}

// ── 实时用量卡片（widget）的区块清单 ──
// id 对应 panel-v2.js 里 widgetShell 的 data-block 标记；group 用于设置页分组。
const WIDGET_BLOCKS = [
  { id: "overview", label: "会话信息总览", group: null, desc: "上下文环、本会话总 Token、平均缓存命中率、本会话总费用" },
  { id: "context", label: "上下文余量", group: null, desc: "已用量、距压缩余量与压缩阈值标记" },
  { id: "turnTokens", label: "当前轮 Token", group: null, desc: "本轮的 Token 消耗总量" },
  { id: "turnHit", label: "当前轮缓存命中", group: null, desc: "本轮的缓存命中率" },
  { id: "composition", label: "输入输出 / 缓存命中未命中", group: null, desc: "输入与输出占比、命中与未命中占比" },
  { id: "providers", label: "会话供应商统计", group: null, desc: "供应商占比、供应商列表与额度窗口" },
];
const WIDGET_DEFAULT = WIDGET_BLOCKS.map((b) => b.id);

/** 解析实时用量卡片的区块开关；缺失或损坏时回退全开。 */
function parseWidgetLayout(raw) {
  const known = new Set(WIDGET_BLOCKS.map((b) => b.id));
  let obj = null;
  try {
    obj = typeof raw === "string" ? (raw ? JSON.parse(raw) : null) : raw;
  } catch {
    obj = null;
  }
  if (obj && Array.isArray(obj.on)) {
    return { on: obj.on.filter((id) => known.has(id)) };
  }
  return { on: WIDGET_DEFAULT.slice() };
}

/**
 * App 自有配置：存在 dataDir/config.json，不进宿主 settings schema。
 * 宿主只要看到 contributes.settings.schema，就把设置 tab 归成 schema 类，自定义设置页会被降级，
 * 所以去掉 schema，配置由 App 自己保管。常驻内存且写入即更新，设置页改完立刻生效。
 */
const appConfig = { data: {}, loaded: false };

async function readAppConfig(sdk) {
  if (!appConfig.loaded) {
    try {
      const raw = await readFile(join(sdk.dataDir, "config.json"), "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed)) appConfig.data[key] = value;
      }
    } catch {
      // 首次运行、文件缺失或损坏：保持空配置。
    }
    appConfig.loaded = true;
  }
  return appConfig.data;
}

async function writeAppConfig(sdk, key, value) {
  await readAppConfig(sdk);
  if (value === undefined) delete appConfig.data[key];
  else appConfig.data[key] = value;
  try {
    await mkdir(sdk.dataDir, { recursive: true });
    await writeFile(join(sdk.dataDir, "config.json"), JSON.stringify(appConfig.data, null, 2), "utf8");
  } catch (error) {
    await sdk.logger.warn(`app config write failed: ${error?.message ?? error}`);
  }
  return appConfig.data;
}

/** v1 遗留端点用的 ctx 适配：把 sdk 包成老代码认识的那几个成员。 */
async function makeCtx(sdk) {
  const configSnapshot = await readAppConfig(sdk);
  return {
    sdk,
    pluginId: APP_ID,
    pluginDir: APP_DIR,
    dataDir: sdk.dataDir,
    sessionId: null,
    sessionPath: null,
    config: { get: (key) => configSnapshot[key], getAll: () => configSnapshot },
    network: { fetch: (input, init) => sdk.network.fetch(input, init) },
    resources: sdk.resources,
  };
}

export default defineApp(async (sdk) => {
  await sdk.logger.info("session-insight-v2 loaded");
  const ctx = await makeCtx(sdk);

  await sdk.routes.register((app) => {
    // v1 遗留端点（账本聚合、供应商、余额、更新等）复用原实现，数据源已在内部换成宿主 API。
    registerLegacyRoutes(app, ctx);

    app.get("/overview", async (c) => {
      const sessionId = c.req.query("sessionId") ?? null;
      const useCache = c.req.query("fresh") !== "1";
      const key = sessionId ?? "";
      if (useCache && cache.value && cache.key === key && Date.now() - cache.at < CACHE_MS) {
        return c.json({ ...cache.value, cached: true });
      }
      const overview = await buildOverview(sdk, sessionId);
      cache = { at: Date.now(), key, value: overview };
      return c.json(overview);
    });

    app.get("/health", (c) => c.json({ ok: true, app: "session-insight-v2" }));

    app.get("/api/sessions", async (c) => {
      try {
        const lifecycle = c.req.query("lifecycle") ?? "all";
        const sessions = await listSessions(sdk, { lifecycle });
        return c.json({ sessions, count: sessions.length });
      } catch (error) {
        return c.json({ sessions: [], error: String(error?.message ?? error) }, 500);
      }
    });

    app.get("/api/stats", async (c) => {
      // 与 v1 对齐：不带任何会话参数时，用最近（列表第一个）那个会话
      let ref =
        c.req.query("session") ?? c.req.query("file") ?? c.req.query("sessionId") ?? null;
      if (!ref) {
        const sessions = await listSessionsCached(sdk).catch(() => []);
        ref = sessions[0]?.sessionId ?? null;
        if (!ref) return c.json({ error: "no sessions found" }, 404);
      }
      try {
        const sessionId = await resolveSessionId(sdk, ref);
        if (!sessionId) return c.json({ error: `unknown session: ${ref}` }, 404);
        const [entries, context, sessions] = await Promise.all([
          fetchSessionUsage(sdk, sessionId),
          sdk.sessions.context({ sessionId, scope: "all" }).catch(() => null),
          listSessionsCached(sdk).catch(() => []),
        ]);
        const hit = sessions.find((s) => s.sessionId === sessionId);
        let stats = buildSessionStats(entries, context);
        // 默认走宿主账本；账本窗口（本机目前约二十多天）以外的会话回退到解析会话文件。
        if (entries.length === 0) {
          const fromFile = await buildStatsFromSessionFile(sdk, hit?.path ?? null);
          if (fromFile) stats = fromFile;
        }
        stats.file = hit?.name ?? (baseName(context?.sessionPath ?? null) || ref);
        stats.sessionId = sessionId;
        stats.title = hit?.title ?? null;
        stats.source = stats.source ?? "ledger";
        return c.json(stats);
      } catch (error) {
        return c.json({ error: String(error?.message ?? error) }, 500);
      }
    });

    app.get("/api/ledger", async (c) => {
      try {
        const since = c.req.query("since") ?? null;
        const until = c.req.query("until") ?? null;
        const entries = await fetchLedger(sdk, { since, until });
        return c.json({ count: entries.length, entries });
      } catch (error) {
        return c.json({ count: 0, entries: [], error: String(error?.message ?? error) }, 500);
      }
    });

    // ── 本轮速览卡（live）───────────────────────────────
    // 配置：显示项清单 + 顺序 + 开关。键名 liveLayout，值是一段 JSON 字符串。
    app.get("/api/live-config", async (c) => {
      try {
        const all = await readAppConfig(sdk);
        const layout = parseLiveLayout(all.liveLayout);
        liveLayoutCache = layout;
        return c.json({ items: LIVE_ITEMS, ...layout });
      } catch (error) {
        return c.json({
          items: LIVE_ITEMS,
          ...parseLiveLayout(null),
          error: String(error?.message ?? error),
        });
      }
    });

    app.post("/api/live-config", async (c) => {
      try {
        const body = await c.req.json().catch(() => null);
        const layout = parseLiveLayout(body);
        await writeAppConfig(sdk, "liveLayout", JSON.stringify(layout));
        liveLayoutCache = layout;
        // 显隐立即生效：用上一轮的数据重推一次，内容不变、只更新 visible。
        if (lastInputStatusArgs) {
          await pushInputStatus(
            lastInputStatusArgs.sessionId,
            lastInputStatusArgs.t,
            lastInputStatusArgs.requestId
          ).catch(() => {});
        }
        return c.json({ ok: true, ...layout });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message ?? error) }, 500);
      }
    });

    // ── 实时用量卡片（widget）的区块开关 ──
    app.get("/api/widget-config", async (c) => {
      try {
        const all = await readAppConfig(sdk);
        return c.json({ blocks: WIDGET_BLOCKS, ...parseWidgetLayout(all.widgetLayout) });
      } catch (error) {
        return c.json({ blocks: WIDGET_BLOCKS, ...parseWidgetLayout(null), error: String(error?.message ?? error) }, 500);
      }
    });

    app.post("/api/widget-config", async (c) => {
      try {
        const body = await c.req.json().catch(() => null);
        const layout = parseWidgetLayout(body);
        await writeAppConfig(sdk, "widgetLayout", JSON.stringify(layout));
        return c.json({ ok: true, blocks: WIDGET_BLOCKS, ...layout });
      } catch (error) {
        return c.json({ ok: false, error: String(error?.message ?? error) }, 500);
      }
    });

    // 数据：一次给齐卡片需要用到的所有原始字段，前端按配置决定显示哪几项。
    app.get("/api/live-data", async (c) => {
      try {
        let sessionId = c.req.query("sessionId") ?? null;
        const sessions = await listSessionsCached(sdk).catch(() => []);
        if (!sessionId) sessionId = sessions[0]?.sessionId ?? null;
        if (!sessionId) return c.json({ error: "no sessions found" }, 404);

        const [recent, context, entries] = await Promise.all([
          sdk.usage.list({ sessionId, limit: 30 }).catch(() => null),
          sdk.sessions.context({ sessionId, scope: "all" }).catch(() => null),
          fetchSessionUsage(sdk, sessionId).catch(() => []),
        ]);

        // 取最近一轮：按 startedAt 排序后取最后一条
        const all = (recent?.entries ?? [])
          .slice()
          .sort((a, b) => String(a?.startedAt ?? "").localeCompare(String(b?.startedAt ?? "")));
        const last = all.at(-1) ?? null;
        const u = last?.usage ?? null;
        const outTok = num(u?.output?.totalTokens) ?? 0;
        const durMs = num(last?.durationMs);
        // 吐吐用墙钟耗时自己算：起止时间最可靠；durationMs 语义不稳（见过只有个位数），
        // 直接按毫秒折算会得出百万 t/s 这种荒谬值。
        const t0 = Date.parse(last?.startedAt ?? "");
        const t1 = Date.parse(last?.endedAt ?? "");
        const wallMs =
          Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0 ? t1 - t0 : durMs;
        const rawTps = wallMs && wallMs >= 500 ? Math.round(outTok / (wallMs / 1000)) : null;
        // 超过 2000 t/s 视为口径不对，宁可不显示也不给错数
        const tps = rawTps != null && rawTps > 0 && rawTps <= 2000 ? rawTps : null;

        // 会话累计：命中率按 token 加权，不能简单平均
        let sumHit = 0;
        let sumMiss = 0;
        let sumTokens = 0;
        let sumCost = 0;
        for (const e of entries) {
          if (e?.attribution?.kind !== "session") continue;
          sumTokens += num(e?.usage?.totalTokens) ?? 0;
          const hc = num(e?.usage?.costTotal);
          sumCost += hc != null && hc > 0 ? hc : (calcEntryCost(e) ?? 0);
          sumHit += num(e?.usage?.cache?.readTokens) ?? 0;
          sumMiss += num(e?.usage?.cache?.missTokens) ?? 0;
        }
        const hit = sessions.find((s) => s.sessionId === sessionId) ?? null;

        return c.json({
          at: new Date().toISOString(),
          sessionId,
          turn: {
            provider: last?.model?.provider ?? null,
            modelId: last?.model?.modelId ?? null,
            inputTokens: num(u?.input?.totalTokens),
            uncachedTokens: num(u?.input?.uncachedTokens),
            outputTokens: num(u?.output?.totalTokens),
            reasoningTokens: num(u?.output?.reasoningTokens),
            totalTokens: num(u?.totalTokens),
            hitRatio: num(u?.cache?.hitRatio),
            cacheReadTokens: num(u?.cache?.readTokens),
            cacheMissTokens: num(u?.cache?.missTokens),
            cost: num(u?.costTotal) > 0 ? num(u?.costTotal) : calcEntryCost(last),
            durationMs: wallMs > 0 ? wallMs : null,
            tps,
            startedAt: last?.startedAt ?? null,
            status: last?.status ?? null,
          },
          session: {
            name: hit?.title ?? hit?.name ?? null,
            totalTokens: sumTokens,
            cost: sumCost,
            hitRatio: sumHit + sumMiss > 0 ? sumHit / (sumHit + sumMiss) : null,
          },
          context: context
            ? {
                tokens: num(context.contextUsage?.tokens),
                percent: num(context.contextUsage?.percent),
                compactThreshold: num(context.compactThreshold),
                window: num(context.model?.contextWindow),
              }
            : null,
        });
      } catch (error) {
        return c.json({ error: String(error?.message ?? error) }, 500);
      }
    });
  });

  // ── 输入栏状态项：订阅用量事件，把本轮指标写进输入栏 ──

  const fmtCompactTokens = (n) => {
    const v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(Math.round(v));
  };
  const fmtCompactCost = (n) => {
    const v = Number(n) || 0;
    if (v >= 1) return "¥" + v.toFixed(2);
    if (v >= 0.01) return "¥" + v.toFixed(4);
    return v > 0 ? "¥" + v.toFixed(6) : "¥0";
  };

  /** 从一条 ledger entry 抽本轮指标（与 /api/live-data 同一套口径）。 */
  function turnFromEntry(entry) {
    const u = entry?.usage ?? null;
    const outTok = num(u?.output?.totalTokens) ?? 0;
    const t0 = Date.parse(entry?.startedAt ?? "");
    const t1 = Date.parse(entry?.endedAt ?? "");
    const wall =
      Number.isFinite(t0) && Number.isFinite(t1) && t1 > t0
        ? t1 - t0
        : num(entry?.durationMs);
    const raw = wall && wall >= 500 ? Math.round(outTok / (wall / 1000)) : null;
    // 宿主 usage.costTotal 实测恒为 0，为 0 或缺失时按 pricing.json 自己算。
    const hostCost = num(u?.costTotal);
    const cost = hostCost != null && hostCost > 0 ? hostCost : calcEntryCost(entry);
    return {
      modelId: entry?.model?.modelId ?? null,
      hitRatio: num(u?.cache?.hitRatio),
      cacheReadTokens: num(u?.cache?.readTokens),
      cacheMissTokens: num(u?.cache?.missTokens),
      inputTokens: num(u?.input?.totalTokens),
      outputTokens: num(u?.output?.totalTokens),
      reasoningTokens: num(u?.output?.reasoningTokens),
      totalTokens: num(u?.totalTokens),
      cost,
      // 事件载荷的 endedAt 常缺、durationMs 常为 0 或只有几十毫秒（噪声）；
      // 低于 200ms 视为没测到，给 null 让上层兜底，宁可显示「—」也不报 0.0s。
      wallMs: Number.isFinite(wall) && wall >= 200 ? wall : null,
      tps: raw != null && raw > 0 && raw <= 2000 ? raw : null,
    };
  }

  /** 输入栏五项的开合配置（键 liveLayout）。带一层内存缓存，设置页保存时刷新。 */
  let liveLayoutCache = null;
  async function getLiveLayout() {
    if (liveLayoutCache) return liveLayoutCache;
    try {
      const all = await readAppConfig(sdk);
      liveLayoutCache = parseLiveLayout(all.liveLayout);
    } catch {
      liveLayoutCache = parseLiveLayout(null);
    }
    return liveLayoutCache;
  }

  /** 把本轮指标分别写进五个输入栏项。
   *  拆成多项而不是拼成一条：溢出时宿主按项折叠，不会出现半个数字被截断；
   *  显示与否交给设置页的开关，没值只留「—」占位，不让项数忽增忽减。 */
  // 最后一次推送给输入栏的入参。设置页改完开关时用它立刻重推一次，
  // 否则要等下一轮对话产生了新的 llm_usage 事件、输入栏才会变。
  let lastInputStatusArgs = null;

  async function pushInputStatus(sessionId, t, requestId = null) {
    if (!sessionId) return;
    lastInputStatusArgs = { sessionId, t, requestId };
    const on = new Set((await getLiveLayout()).on);

    // 实测事件载荷里 endedAt 常缺、durationMs 常为 0，时长与吐吞因此算不出来。
    // 缺失时回查一次账本，用同一条 requestId 的完整记录补上。
    if (!(t.wallMs > 0) && requestId) {
      try {
        const recent = await sdk.usage.list({ sessionId, limit: 10 });
        const hit = (recent?.entries ?? []).find((e) => e?.requestId && e.requestId === requestId);
        if (hit) {
          const full = turnFromEntry(hit);
          if (full.wallMs > 0) {
            t.wallMs = full.wallMs;
            if (full.tps != null) t.tps = full.tps;
          }
        }
      } catch (error) {
        await sdk.logger.warn(`inputStatus 回查账本失败: ${error?.message ?? error}`);
      }
    }

    // 标签常驻：数字没出来时用「—」占位，有数字再顶上去——不让整项忽隐忽现。
    const DASH = "—";
    // 宿主给这组项的容器没任何间距（._input-status-items 无 gap），五项会直接贴在一起。
    // 末尾补一个不可折叠的 en space：普通空格会被 HTML 空白折叠掉，这个不会。
    const ITEM_GAP = "\u2002";
    const items = [
      {
        id: "hit",
        text: `命中 ${
          t.hitRatio != null
            ? (t.hitRatio * 100).toFixed((t.hitRatio * 100) % 1 === 0 ? 0 : 1) + "%"
            : DASH
        }`,
        // 摊开百分比背后的两个基数：命中的 token 与未命中的 token
        tooltip:
          t.cacheReadTokens != null || t.cacheMissTokens != null
            ? `命中 ${fmtCompactTokens(t.cacheReadTokens ?? 0)} · 未命中 ${fmtCompactTokens(t.cacheMissTokens ?? 0)}`
            : undefined,
      },
      {
        id: "tps",
        text: `速度 ${t.tps != null ? t.tps + "t/s" : DASH}`,
        tooltip: t.tps != null ? `输出速度 ${t.tps} tokens/秒` : undefined,
      },
      {
        id: "tokens",
        text: `用量 ${t.totalTokens != null ? fmtCompactTokens(t.totalTokens) : DASH}`,
        // 摊开输入与输出，正好是成本结构的两半
        tooltip:
          t.inputTokens != null || t.outputTokens != null
            ? `输入 ${fmtCompactTokens(t.inputTokens ?? 0)} · 输出 ${fmtCompactTokens(t.outputTokens ?? 0)}`
            : undefined,
      },
      {
        id: "cost",
        text: `费用 ${t.cost != null ? fmtCompactCost(t.cost) : DASH}`,
        tooltip: t.cost != null ? `本轮费用 ${fmtCompactCost(t.cost)}` : undefined,
      },
      {
        id: "duration",
        text: `耗时 ${t.wallMs != null ? (t.wallMs / 1000).toFixed(1) + "s" : DASH}`,
        tooltip: t.wallMs != null ? `本轮墙钟耗时 ${(t.wallMs / 1000).toFixed(1)} 秒` : undefined,
      },
    ];

    for (const it of items) {
      try {
        await sdk.inputStatus.set({
          sessionId,
          id: it.id,
          text: (it.text ?? "—") + ITEM_GAP,
          tooltip: it.tooltip,
          // 显示与否由设置页的开关决定（默认五项全开）。
          // 没值不隐藏，留「—」占位，免得项数随数据有无增减。
          visible: on.has(it.id),
        });
      } catch (error) {
        await sdk.logger.warn(`inputStatus.set(${it.id}) failed: ${error?.message ?? error}`);
      }
    }
  }

  // ── 时长计时 ──
  // 宿主 llm_usage 事件的 endedAt 常为空、durationMs 恒为 0（本机实测），
  // 账本里也查不到当下这一轮（usage.list 最新只到 09-12），所以时长只能自己掉。
  // 引擎的 message_start / message_end 各是一条消息的边界，差值就是一次模型调用的墙钟时长。
  let msgStartAt = 0;
  let lastMsgWall = 0;
  let lastMsgWallAt = 0;
  sdk.bus.subscribe(
    (event) => {
      const type = event?.type;
      if (type === "message_start") {
        msgStartAt = Date.now();
      } else if (type === "message_end") {
        if (msgStartAt) {
          lastMsgWall = Date.now() - msgStartAt;
          lastMsgWallAt = Date.now();
        }
      }
    },
    { types: ["message_start", "message_end"] }
  );

  /** 事件本身的时间字段不可用时的兜底：优先刚掐完的一轮，其次从 message_start 起算。 */
  function fallbackWallMs(entry) {
    // 掐表：message_start / message_end 若挤在同一批 RPC 里到达，差值只有几毫秒，
    // 会显示成「耗时 0.0s」。低于 200ms 一律视为不可信，退到下一层。
    if (lastMsgWall >= 200 && Date.now() - lastMsgWallAt < 5000) return lastMsgWall;
    if (msgStartAt > 0) {
      const ms = Date.now() - msgStartAt;
      if (ms >= 200 && ms < 30 * 60 * 1000) return ms;
    }
    // 最后一层：宿主给的 startedAt 到此刻（含事件投递延迟，但一定有值）
    const t0 = Date.parse(entry?.startedAt ?? "");
    if (Number.isFinite(t0)) {
      const ms = Date.now() - t0;
      if (ms >= 200 && ms < 30 * 60 * 1000) return ms;
    }
    return 0;
  }

  // 订阅用量事件：每完成一轮就刷新那一行。回调里的异常自己吃掉。
  sdk.bus.subscribe(
    (event) => {
      if (event?.type !== "llm_usage") return;
      const entry = event?.entry ?? null;
      const turn = turnFromEntry(entry);
      if (!(turn.wallMs > 0)) {
        const wall = fallbackWallMs(entry);
        // 兜底也拿不到就宁可留空：t.wallMs 只接受 null 或正值，不允许出现 0。
        if (wall >= 200) {
          turn.wallMs = wall;
          const raw = wall >= 500 ? Math.round((turn.outputTokens ?? 0) / (wall / 1000)) : 0;
          if (raw > 0 && raw <= 2000) turn.tps = raw;
        }
      }
      pushInputStatus(
        entry?.attribution?.sessionId ?? null,
        turn,
        entry?.requestId ?? null
      ).catch(() => {});
    },
    { types: ["llm_usage"] }
  );

  await sdk.tools.register({
    name: "session_insight_overview",
    description:
      "读取 Session Insight 当前的聚合数据：当前会话上下文占用、本会话用量汇总、会话列表、用量账本分页情况。",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "可选，指定会话；省略时取最近活跃会话。" },
        probe: {
          type: "boolean",
          description: "临时诊断：额外返回最近几条用量记录的原始时间字段（startedAt/endedAt/durationMs）。",
        },
      },
    },
    execute: async (args) => {
      const overview = await buildOverview(sdk, args?.sessionId ?? null);
      if (args?.probe) {
        const sid = overview.activeSessionId;
        const rows = sid
          ? ((await sdk.usage.list({ sessionId: sid, limit: 6 }))?.entries ?? [])
          : [];
        overview.probe = {
          sessionId: sid,
          rows: rows.map((r) => ({
            requestId: r?.requestId ?? null,
            startedAt: r?.startedAt ?? null,
            endedAt: r?.endedAt ?? null,
            durationMs: r?.durationMs ?? null,
            status: r?.status ?? null,
            subsystem: r?.source?.subsystem ?? null,
          })),
        };
      }
      return { content: [{ type: "text", text: JSON.stringify(overview, null, 2) }] };
    },
  });

  await sdk.logger.info("session-insight-v2 ready");
});
