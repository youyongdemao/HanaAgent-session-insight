// Session Insight v2 App — 服务端入口
// 数据源全部走宿主公开 API：session:list / session:context / usage:list / provider:credentials
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineApp } from "./sdk/app-contract/server-client.js";
import registerLegacyRoutes from "./lib/legacy-api.js";
import {
  listSessions,
  fetchSessionUsage,
  buildSessionStats,
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
    costTotal += num(entry?.usage?.costTotal) ?? 0;

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

/** v1 遗留端点用的 ctx 适配：把 sdk 包成老代码认识的那几个成员。 */
async function makeCtx(sdk) {
  let configSnapshot = {};
  try {
    configSnapshot = (await sdk.config.getAll()) ?? {};
  } catch (error) {
    await sdk.logger.warn(`config snapshot failed: ${error?.message ?? error}`);
  }
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
      const ref =
        c.req.query("session") ?? c.req.query("file") ?? c.req.query("sessionId") ?? null;
      if (!ref) return c.json({ error: "session query is required" }, 400);
      try {
        const sessionId = await resolveSessionId(sdk, ref);
        if (!sessionId) return c.json({ error: `unknown session: ${ref}` }, 404);
        const [entries, context] = await Promise.all([
          fetchSessionUsage(sdk, sessionId),
          sdk.sessions.context({ sessionId, scope: "all" }).catch(() => null),
        ]);
        const stats = buildSessionStats(entries, context);
        if (!stats) return c.json({ error: "no usage recorded for this session" }, 404);
        // 前端一直用文件名当会话标识，这里补回去
        stats.file = baseName(context?.sessionPath ?? null) || ref;
        stats.sessionId = sessionId;
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
  });

  await sdk.tools.register({
    name: "session_insight_overview",
    description:
      "读取 Session Insight 当前的聚合数据：当前会话上下文占用、本会话用量汇总、会话列表、用量账本分页情况。",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "可选，指定会话；省略时取最近活跃会话。" },
      },
    },
    execute: async (args) => {
      const overview = await buildOverview(sdk, args?.sessionId ?? null);
      return { content: [{ type: "text", text: JSON.stringify(overview, null, 2) }] };
    },
  });

  await sdk.logger.info("session-insight-v2 ready");
});
