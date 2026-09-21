// lib/local-launch.js — 本地供应商：识别、指定程序、探活、拉起
//
// 三条边界先写清楚，避免后人误以为这里能「自动发现」：
//   1. 应用进程读不了文件系统（沙箱只给安装目录和数据目录），所以 exe 在哪
//      必须由宿主确认（resolveExecutable）或用户指定，scan 是不可能的。
//   2. 供应商的 baseUrl 只能从 provider:credentials 拿（model:list 明确不含它），
//      探活端口由它推出，所以任何本地端点都通用，不限于我们认识的那几个。
//   3. 目录里那些预设只是「省事」，不是「保证」：猜不到就把选择权交回用户。
import { spawn } from "node:child_process";
import { PROVIDER_DIRECTORY } from "./provider-directory.js";

const PROBE_TIMEOUT_MS = 1500;
// 拉起之后给它多久把端口起起来（起不来要如实告诉用户，而不是报个 started 就算完）
const WAIT_READY_MS = 10000;
const WAIT_STEP_MS = 1200;
const BASE_URL_CACHE_MS = 60 * 1000;
const LIST_CACHE_MS = 30 * 1000;

const baseUrlCache = new Map();
const listCache = { at: 0, data: null };

function displayName(providerId) {
  return PROVIDER_DIRECTORY[providerId]?.name || providerId;
}

/** 供应商的 baseUrl：宿主凭据接口是唯一来源 */
async function providerBaseUrl(ctx, providerId) {
  const hit = baseUrlCache.get(providerId);
  if (hit && Date.now() - hit.at < BASE_URL_CACHE_MS) return hit.baseUrl;
  let baseUrl = null;
  try {
    const res = await ctx.sdk.bus.request("provider:credentials", { providerId });
    baseUrl = typeof res?.baseUrl === "string" ? res.baseUrl : null;
  } catch {
    // 拿不到就按 null：后面回落目录里的预设端口
  }
  baseUrlCache.set(providerId, { at: Date.now(), baseUrl });
  return baseUrl;
}

function isLoopback(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(String(url || ""));
}

function portOf(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === "https:" ? 443 : 80;
  } catch {
    return null;
  }
}

/** 用户在设置里指定的程序路径（App 自管配置，dataDir/config.json） */
function configuredProgram(ctx, providerId) {
  const all = ctx.config?.get?.("localPrograms");
  const value = all && typeof all === "object" ? all[providerId] : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dirOf(filePath) {
  return filePath.replace(/[\\/][^\\/]*$/, "");
}

/**
 * 目录预设：带 sibling 的候选表示「先解析出安装目录，再找同目录的另一个文件」——
 * 带空格的命令名（如 ollama app.exe）会被宿主当 shell 表达式拒收，只能用这条路。
 */
async function resolvePreset(ctx, launch) {
  let invalid = null;
  for (const attempt of launch.attempts ?? []) {
    let hit;
    try {
      hit = await ctx.sdk.process.resolveExecutable({ candidates: attempt.candidates });
    } catch (error) {
      if (error?.code === "APP_EXECUTABLE_REQUEST_INVALID") {
        invalid = error;
        continue;
      }
      throw error;
    }
    if (!hit?.path) continue;

    if (attempt.sibling) {
      const sibling = await ctx.sdk.process.resolveExecutable({
        candidates: [`${dirOf(hit.path)}\\${attempt.sibling}`],
      });
      if (!sibling?.path) continue;
      return { exe: sibling.path, args: attempt.args ?? [] };
    }

    return { exe: hit.path, args: attempt.args ?? [] };
  }
  if (invalid) throw invalid;
  return null;
}

/** 启动目标：用户指定的优先，其次目录预设，都没有就返回 null（界面让用户选） */
async function resolveTarget(ctx, launch, providerId) {
  const chosen = configuredProgram(ctx, providerId);
  if (chosen) {
    const hit = await ctx.sdk.process.resolveExecutable({ candidates: [chosen] });
    if (!hit?.path) {
      const error = new Error(`指定的程序不存在：${chosen}`);
      error.code = "PROGRAM_MISSING";
      throw error;
    }
    return { exe: hit.path, args: [], source: "configured" };
  }

  if (!launch) return null;
  const preset = await resolvePreset(ctx, launch);
  return preset ? { ...preset, source: "preset" } : null;
}

/** 探活端口：优先按用户配的 baseUrl 推，其次目录预设 */
async function probePortOf(ctx, providerId) {
  const baseUrl = await providerBaseUrl(ctx, providerId);
  const port = portOf(baseUrl);
  if (port) return { port, baseUrl };
  const preset = PROVIDER_DIRECTORY[providerId]?.launch?.probePort ?? null;
  return { port: preset, baseUrl };
}

/** 端口上有东西在应答就算在跑；连不上就是没跑（探不通时把原因一并带回） */
async function isRunning(ctx, port, probePath = "/") {
  if (!port) return { running: false, error: "no probe port" };
  try {
    const res = await ctx.network.fetch(`http://127.0.0.1:${port}${probePath}`, {
      timeoutMs: PROBE_TIMEOUT_MS,
      cacheTtlMs: 0,
    });
    // 4xx 也算「有人在听」：这里只问端口通不通，不问它答什么
    return { running: Number(res?.status) < 500 };
  } catch (error) {
    return { running: false, error: `${error?.code ?? "-"}: ${String(error?.message ?? error)}` };
  }
}

/** 拉起后等它把端口起起来；超时返回 false，由调用方给出可行动的提示 */
async function waitUntilRunning(ctx, port, probePath) {
  if (!port) return false;
  const deadline = Date.now() + WAIT_READY_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS));
    const probe = await isRunning(ctx, port, probePath);
    if (probe.running) return true;
  }
  return false;
}

/** 当前配置里的本地供应商：baseUrl 指向本机、或目录里标了 local */
async function localProviders(ctx) {
  if (listCache.data && Date.now() - listCache.at < LIST_CACHE_MS) return listCache.data;

  const ids = new Set();
  try {
    const result = await ctx.sdk.models.listAvailable();
    const models = Array.isArray(result) ? result : (result?.models ?? []);
    for (const model of models) if (model?.provider) ids.add(model.provider);
  } catch {
    // 拿不到模型目录就只按目录里标了 local 的算
  }
  for (const [id, dir] of Object.entries(PROVIDER_DIRECTORY)) if (dir.local === true) ids.add(id);

  const providers = [];
  for (const id of ids) {
    const dir = PROVIDER_DIRECTORY[id] ?? null;
    const { baseUrl } = await probePortOf(ctx, id);
    if (!isLoopback(baseUrl) && dir?.local !== true) continue;

    const configured = configuredProgram(ctx, id);
    let program = configured;
    let source = configured ? "configured" : null;
    if (!program && dir?.launch) {
      try {
        const preset = await resolvePreset(ctx, dir.launch);
        if (preset) {
          program = preset.exe;
          source = "preset";
        }
      } catch {
        // 宿主没授权（还没批 app/process.spawn）或预设写法有问题：这一项就当没有预设
      }
    }

    providers.push({
      id,
      name: dir?.name || id,
      baseUrl: baseUrl ?? null,
      program: program ?? null,
      source,
    });
  }

  const data = { providers };
  listCache.at = Date.now();
  listCache.data = data;
  return data;
}

export function registerLaunchRoutes(app, ctx, { writeConfig } = {}) {
  // 当前有哪些本地供应商、各自会启动哪个程序、端口是多少
  app.get("/api/local-providers", async (c) => {
    try {
      return c.json(await localProviders(ctx));
    } catch (error) {
      return c.json({ providers: [], error: String(error?.message ?? error) }, 500);
    }
  });

  // 指定/清除某个本地供应商的程序路径（空路径 = 清除）
  app.post("/api/local-program", async (c) => {
    try {
      const body = await c.req.json();
      const provider = String(body?.provider ?? "").slice(0, 60);
      if (!provider) return c.json({ ok: false, code: "NO_PROVIDER", message: "缺少供应商 id" }, 400);
      if (typeof writeConfig !== "function") {
        return c.json({ ok: false, code: "NO_CONFIG", message: "配置写入不可用" }, 500);
      }

      const current = ctx.config?.get?.("localPrograms");
      const next = current && typeof current === "object" ? { ...current } : {};
      const raw = typeof body?.path === "string" ? body.path.trim() : "";
      if (raw) next[provider] = raw;
      else delete next[provider];

      await writeConfig("localPrograms", next);
      listCache.data = null;
      return c.json({ ok: true, provider, path: raw || null });
    } catch (error) {
      return c.json({ ok: false, code: "SAVE_FAILED", message: String(error?.message ?? error) }, 500);
    }
  });

  app.get("/api/launch-provider", async (c) => {
    const provider = String(c.req.query("provider") ?? "");
    if (!provider) {
      return c.json({ ok: false, code: "NO_PROVIDER", message: "缺少供应商 id" }, 400);
    }
    const launch = PROVIDER_DIRECTORY[provider]?.launch ?? null;
    const label = launch?.label || `启动 ${displayName(provider)}`;
    const { port } = await probePortOf(ctx, provider);

    const probe = await isRunning(ctx, port, launch?.probePath ?? "/");
    if (probe.running) return c.json({ ok: true, running: true, label, port });
    // dry=1 只问状态，不拉起
    if (c.req.query("dry") === "1") {
      return c.json({ ok: true, running: false, label, port, probeError: probe.error ?? null });
    }

    let target;
    try {
      target = await resolveTarget(ctx, launch, provider);
    } catch (error) {
      const code = error?.code ?? "RESOLVE_FAILED";
      const status = code === "PROGRAM_MISSING" ? 404 : 403;
      return c.json({ ok: false, code, message: String(error?.message ?? error) }, status);
    }
    if (!target) {
      // 既没有目录预设、用户也没指定：把选择权交回界面
      return c.json(
        {
          ok: false,
          code: "NOT_CONFIGURED",
          message: `未指定 ${displayName(provider)} 的程序，选择后即可启动`,
        },
        404
      );
    }

    try {
      // 环境在宿主裁剪过的 process.env 上叠加清单里指定的变量（不叠加会把 PATH 之类也弄丢）。
      // windowsHide 必须有：控制台程序不隐藏会弹出黑窗，关掉那个窗口会连带把服务弄死。
      const child = spawn(target.exe, target.args, {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: launch?.env ? { ...process.env, ...launch.env } : process.env,
      });
      child.unref();

      // 等端口真的起来再回话：只报「已启动」而服务没起来，用户看到的就等于什么都没有
      const up = await waitUntilRunning(ctx, port, launch?.probePath ?? "/");
      return c.json({
        ok: true,
        started: true,
        running: up,
        label,
        exe: target.exe,
        source: target.source,
        port,
        pid: child.pid ?? null,
        hint: up
          ? null
          : "未能确认服务已就绪。请核对设置中的程序路径（设置 → Session Insight → 本地供应商）；若该程序需在自身界面手动开启服务，请先开启后重试。",
      });
    } catch (error) {
      return c.json({ ok: false, code: "SPAWN_FAILED", message: String(error?.message ?? error) }, 500);
    }
  });
}
