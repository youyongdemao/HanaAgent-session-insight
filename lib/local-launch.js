// lib/local-launch.js — 「启动本地供应商」：解析 exe、探活、拉起
//
// v2 应用不能自己扫盘，可执行文件位置由宿主解析，所以走两条宿主给的通道：
//   sdk.process.resolveExecutable  找 exe      —— 要 app/process.spawn
//   node:child_process.spawn       拉起进程    —— 同样要这次能力（授权后 AppHost 才会开子进程）
// 拉起来的是独立进程，不随应用重载或退出被回收。
import { spawn } from "node:child_process";
import { PROVIDER_DIRECTORY } from "./provider-directory.js";

const PROBE_TIMEOUT_MS = 1500;

/** 依次试每个候选组，第一个解析得到的就用它 */
async function resolveTarget(sdk, launch) {
  let invalid = null;
  for (const attempt of launch.attempts ?? []) {
    try {
      const hit = await sdk.process.resolveExecutable({ candidates: attempt.candidates });
      if (hit?.path) return { exe: hit.path, args: attempt.args ?? [] };
    } catch (error) {
      // 候选写法不合法只跳过这一组（宿主会整组拒收）；没授权这类错误要抛出去给用户看
      if (error?.code === "APP_EXECUTABLE_REQUEST_INVALID") {
        invalid = error;
        continue;
      }
      throw error;
    }
  }
  if (invalid) throw invalid;
  return null;
}

/** 端口上有东西在应答就算在跑；连不上就是没跑（探不通时把原因一并带回） */
async function isRunning(ctx, launch) {
  if (!launch.probePort) return { running: false, error: "no probe port" };
  try {
    const res = await ctx.network.fetch(
      `http://127.0.0.1:${launch.probePort}${launch.probePath ?? "/"}`,
      { timeoutMs: PROBE_TIMEOUT_MS, cacheTtlMs: 0 }
    );
    // 4xx 也算「有人在听」：这里只问端口通不通，不问它答什么
    return { running: Number(res?.status) < 500 };
  } catch (error) {
    return { running: false, error: `${error?.code ?? "-"}: ${String(error?.message ?? error)}` };
  }
}

export function registerLaunchRoutes(app, ctx) {
  app.get("/api/launch-provider", async (c) => {
    const provider = String(c.req.query("provider") ?? "");
    const launch = PROVIDER_DIRECTORY[provider]?.launch;
    if (!launch) {
      return c.json(
        { ok: false, code: "NO_LAUNCH_TARGET", message: `${provider || "该供应商"} 没有配置启动目标` },
        404
      );
    }

    const label = launch.label;
    const port = launch.probePort ?? null;

    const probe = await isRunning(ctx, launch);
    if (probe.running) return c.json({ ok: true, running: true, label, port });
    // dry=1 只问状态，不拉起
    if (c.req.query("dry") === "1") {
      return c.json({ ok: true, running: false, label, port, probeError: probe.error ?? null });
    }

    let target;
    try {
      target = await resolveTarget(ctx.sdk, launch);
    } catch (error) {
      // 没授权时宿主会点名缺哪项能力，原样交给界面显示
      return c.json(
        { ok: false, code: error?.code ?? "RESOLVE_FAILED", message: String(error?.message ?? error) },
        403
      );
    }
    if (!target) {
      return c.json({ ok: false, code: "NOT_FOUND", message: `没找到 ${label} 的可执行文件` }, 404);
    }

    try {
      // 环境在宿主裁剪过的 process.env 上叠加清单里指定的变量（不叠加会把 PATH 之类也弄丢）
      const child = spawn(target.exe, target.args, {
        detached: true,
        stdio: "ignore",
        env: launch.env ? { ...process.env, ...launch.env } : process.env,
      });
      child.unref();
      return c.json({ ok: true, started: true, label, exe: target.exe, port });
    } catch (error) {
      return c.json({ ok: false, code: "SPAWN_FAILED", message: String(error?.message ?? error) }, 500);
    }
  });
}
