// css-parse.cjs —— session-insight 的极简 CSS 解析（保留原文偏移）
// 只服务于「找出写了但不生效的声明」这类静态审计与清理，不追求完整 CSS 语法。
// 返回的每条规则带：选择器文本、所属媒体条件、声明列表，以及各自在源码中的偏移。
const SKIP_AT = /^@(keyframes|-webkit-keyframes|font-face|page|property|counter-style|font-feature-values)/i;
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** 拆选择器组：只认括号外的逗号。
 *  :is(.a , .card , .chart-card) 内部的逗号不是分隔符——按普通 split(",") 拆，
 *  会把 .card 当成一个独立选择器，让一条 :is(...) 规则冒名顶替真正匹配 .card 的规则，
 *  进而把合法声明误判为「被覆盖」。2026-09-26 就是这样误删了 .card 的背景与阴影。 */
function splitSelectors(text) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
}

function parse(text) {
  const rules = [];
  const stack = [];             // [{type:'at'|'rule'}]
  let buf = "", bufStart = 0;   // 选择器/at 头文本及其起点
  let skipDepth = 0;            // @keyframes 之类整体跳过（进入时其 { 已消费）
  let declBuf = null;
  const media = () => stack.filter((s) => s.type === "at").map((s) => s.head).join(" && ") || "(top)";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (skipDepth > 0) {
      if (ch === "{") skipDepth++;
      else if (ch === "}") skipDepth--;
      continue;
    }
    if (ch === "{") {
      const head = stripComments(buf).trim();
      if (head.startsWith("@")) {
        if (SKIP_AT.test(head)) { skipDepth = 1; buf = ""; continue; }
        stack.push({ type: "at", head: head.replace(/\s+/g, "") });
        buf = "";
        continue;
      }
      declBuf = { selectors: head, media: media(), raw: "", selStart: bufStart, braceAt: i };
      stack.push({ type: "rule" });
      buf = "";
      continue;
    }
    if (ch === "}") {
      const top = stack.pop();
      if (top && top.type === "rule" && declBuf) {
        declBuf.end = i;
        rules.push(declBuf);
        declBuf = null;
      }
      buf = "";
      continue;
    }
    if (declBuf) declBuf.raw += ch;
    else { if (buf === "") bufStart = i; buf += ch; }
  }

  for (const r of rules) {
    r.sels = splitSelectors(stripComments(r.selectors));
    r.decls = [];
    let start = 0;
    for (let i = 0; i <= r.raw.length; i++) {
      if (i === r.raw.length || r.raw[i] === ";") {
        const text = r.raw.slice(start, i);
        const t = text.trim();
        const k = t.indexOf(":");
        if (k > 0) {
          const prop = t.slice(0, k).trim();
          const value = t.slice(k + 1).trim();
          r.decls.push({ prop, value, important: /!important\s*$/i.test(value), text: t, start, end: i });
        }
        start = i + 1;
      }
    }
  }
  return rules;
}

module.exports = { parse, stripComments, splitSelectors };
