// _check-child.cjs —— 验证 node -e 方式跑子进程：ESM 静态 import 可用、argv 位置正确
const { spawn } = require("node:child_process");
const body =
  "import { DatabaseSync } from \"node:sqlite\";\n" +
  "const db = new DatabaseSync(process.argv[1], { readOnly: true });\n" +
  "const rows = db.prepare(\"select count(*) c from usage_daily_rollups\").all();\n" +
  "db.close();\n" +
  "process.stdout.write(JSON.stringify({ argv: process.argv, rows }));\n";
const child = spawn("node", ["--input-type=module", "-e", body, "D:/AI/Hanako/usage-ledger.sqlite"], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
});
let buf = "", err = "";
child.stdout.on("data", (c) => (buf += c));
child.stderr.on("data", (c) => (err += c));
child.on("close", (code) => {
  console.log("exit:", code);
  console.log("stdout:", buf.slice(0, 300));
  if (err) console.log("stderr:", err.slice(0, 300));
});
child.on("error", (e) => console.log("spawn error:", e.message));
