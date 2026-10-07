// _drop-live-route.cjs —— 删掉 /api/live-data 死路由（前端调用方 live.html 从未在 manifest 注册）
// 用注释锚点定位，并在删除前校验区间里确实只有这一个路由，避免误删。
const fs = require("fs");
const p = "D:/AI/Hanako/OH-WorkSpace/HanaApp-Dev/session-insight/session-insight-v2/index.js";
let s = fs.readFileSync(p, "utf8");
const startMark = "    // 数据：一次给齐卡片需要用到的所有原始字段，前端按配置决定显示哪几项。";
const endMark = "    // ── 宿主界面环境：卡片据此决定要不要为宿主控件让位 ──";
const a = s.indexOf(startMark);
const b = s.indexOf(endMark);
if (a < 0) throw new Error("找不到起点注释");
if (b < 0) throw new Error("找不到终点注释");
if (b <= a) throw new Error("终点在起点之前");
const removed = s.slice(a, b);
if (!/\/api\/live-data/.test(removed)) throw new Error("待删区间里没有 live-data");
const routes = (removed.match(/app\.(get|post)\(/g) || []).length;
if (routes !== 1) throw new Error("待删区间里有 " + routes + " 个路由，拒绝删除");
s = s.slice(0, a) + s.slice(b);
fs.writeFileSync(p, s);
console.log("已删除 " + removed.length + " 字符，区间内路由数 " + routes + " ✓");
