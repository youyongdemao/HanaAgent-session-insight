// lib/update-check.js — 「检查更新」的后端
// 只查 GitHub 上最新的已发布版本，和本地版本比大小，把结论交给设置页。
// 不下载、不安装：v2 应用的安装目录对自身进程只读，装新版本那条门在「设置 → 扩展」。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UPDATE_REPO = "youyongdemao/HanaAgent-session-insight";
const REPO_URL = `https://github.com/${UPDATE_REPO}`;
const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`;
// 一次检查结果留五分钟：设置页来回开不该反复打 GitHub 的速率限制
const CACHE_MS = 5 * 60 * 1000;

let cache = { at: 0, releases: null };

/** "v2.1.0" / "app-v2.1.0" → "2.1.0"；取不出数字就原样返回 */
function normalizeVersion(value) {
  return String(value ?? "").trim().replace(/^[^\d]*/, "");
}

function parseVersion(value) {
  const parts = normalizeVersion(value)
    .split(/[.+-]/)
    .map((piece) => Number.parseInt(piece, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

/** a > b → 1；a < b → -1；相等 → 0 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

/** 本地版本取自安装目录里的清单——与 /api/version 同一个来源 */
function readVersion(ctx) {
  try {
    const raw = readFileSync(join(ctx.pluginDir, "manifest.json"), "utf8");
    const version = JSON.parse(raw).version;
    return typeof version === "string" && version.trim() ? version.trim() : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function loadReleases(ctx) {
  if (cache.releases && Date.now() - cache.at < CACHE_MS) return cache.releases;

  const res = await ctx.network.fetch(RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "hana-app-session-insight",
    },
    timeoutMs: 8000,
  });
  if (!res.ok) throw new Error(`GitHub 返回 ${res.status}`);

  const list = await res.json();
  const releases = (Array.isArray(list) ? list : [])
    .filter((item) => item && !item.draft && !item.prerelease)
    .map((item) => ({
      version: normalizeVersion(item.tag_name ?? item.name ?? ""),
      url: typeof item.html_url === "string" ? item.html_url : `${REPO_URL}/releases`,
      notes: typeof item.body === "string" ? item.body.slice(0, 2000) : "",
      publishedAt: typeof item.published_at === "string" ? item.published_at : "",
      assets: Array.isArray(item.assets) ? item.assets : [],
    }))
    .filter((item) => item.version)
    .sort((a, b) => compareVersions(b.version, a.version));

  cache = { at: Date.now(), releases };
  return releases;
}

/** 优先选名字里带这个版本号的 zip，否则退到任意一个 zip */
function pickArchive(release) {
  const zips = release.assets.filter((a) => String(a?.name || "").toLowerCase().endsWith(".zip"));
  const chosen = zips.find((a) => String(a.name).includes(release.version)) || zips[0];
  if (!chosen || typeof chosen.browser_download_url !== "string") return null;
  return {
    name: String(chosen.name),
    url: chosen.browser_download_url,
    size: Number(chosen.size) || 0,
  };
}

export function registerUpdateRoutes(app, ctx) {
  app.get("/api/update-check", async (c) => {
    const currentVersion = readVersion(ctx);
    try {
      const releases = await loadReleases(ctx);
      const latest = releases[0] ?? null;
      if (!latest) {
        return c.json({
          ok: false,
          code: "NO_RELEASE",
          message: "仓库里还没有已发布的版本",
          currentVersion,
          repoUrl: REPO_URL,
        });
      }
      const archive = pickArchive(latest);
      return c.json({
        ok: true,
        repoUrl: REPO_URL,
        currentVersion,
        latestVersion: latest.version,
        updateAvailable: compareVersions(latest.version, currentVersion) > 0,
        url: latest.url,
        notes: latest.notes,
        publishedAt: latest.publishedAt,
        archiveName: archive?.name ?? "",
        archiveSize: archive?.size ?? 0,
      });
    } catch (error) {
      return c.json({
        ok: false,
        code: "CHECK_FAILED",
        message: String(error?.message ?? error),
        currentVersion,
        repoUrl: REPO_URL,
      });
    }
  });
}
