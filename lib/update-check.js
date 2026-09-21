// lib/update-check.js — 「检查更新」的后端
// 只查 GitHub 上版本号最高的已发布版本，和本地版本比大小，把结论交给设置页的检查更新弹窗。
// 不下载、不安装：安装那条门在「设置 → 扩展」，应用改不了自己的安装目录。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const UPDATE_REPO = "youyongdemao/HanaAgent-session-insight";
const RELEASES_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=20`;
const RELEASE_PAGE_URL = `https://github.com/${UPDATE_REPO}/releases/latest`;
// 一次检查结果留五分钟：设置页来回开不该反复打 GitHub 的速率限制
const CACHE_MS = 5 * 60 * 1000;
// 超过这个长度的非列表行当正文段落，不当分组标题（更新日志里偶尔会写散文）
const MAX_GROUP_TITLE_LEN = 24;

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

/** 只留下能读的文字：去掉行内代码的反引号、粗体标记、链接的地址部分 */
function cleanInline(text) {
  return String(text)
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

/**
 * Release 正文是给自己看的 markdown（版本号回显、SHA256、`-` 列表、分组标题混在一起），
 * 直接贴到界面上是一堆符号。这里把开头的正文行整理成 [{ title, items }]，渲染层只负责画。
 */
function parseNotes(raw, version) {
  const lines = String(raw ?? "").replace(/\r\n?/g, "\n").split("\n");
  const groups = [];
  let current = null;

  // 还没有分组标题的条目先挂在一个无名分组下
  const untitled = () => {
    if (!current) groups.push((current = { title: "", items: [] }));
    return current;
  };

  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    // SHA256 那行与开头的版本号回显都是给机器校对的，不进正文
    if (/^sha-?\d+\s*[:：]/i.test(text)) continue;
    if (/^v?\d/.test(text) && normalizeVersion(text) === normalizeVersion(version)) continue;

    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const item = cleanInline(bullet[1]);
      if (item) untitled().items.push(item);
      continue;
    }

    const heading = /^#{1,6}\s*(.+)$/.exec(text);
    const title = cleanInline(heading ? heading[1] : text);
    if (title.length <= MAX_GROUP_TITLE_LEN) {
      current = { title, items: [] };
      groups.push(current);
    } else {
      untitled().items.push(title);
    }
  }

  // 只有标题、一条正文都没有的分组不画（比如「新增」下面什么都没写）
  return groups.filter((group) => group.items.length > 0);
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
      notes: typeof item.body === "string" ? item.body : "",
      publishedAt: typeof item.published_at === "string" ? item.published_at : "",
    }))
    .filter((item) => item.version)
    .sort((a, b) => compareVersions(b.version, a.version));

  cache = { at: Date.now(), releases };
  return releases;
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
          releaseUrl: RELEASE_PAGE_URL,
        });
      }
      return c.json({
        ok: true,
        currentVersion,
        latestVersion: latest.version,
        updateAvailable: compareVersions(latest.version, currentVersion) > 0,
        publishedAt: latest.publishedAt,
        noteGroups: parseNotes(latest.notes, latest.version),
        releaseUrl: RELEASE_PAGE_URL,
      });
    } catch (error) {
      return c.json({
        ok: false,
        code: "CHECK_FAILED",
        message: String(error?.message ?? error),
        currentVersion,
        releaseUrl: RELEASE_PAGE_URL,
      });
    }
  });
}
