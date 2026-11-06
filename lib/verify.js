// codex-purge — 端到端验证与前后对照
//
// 做法：起一个只抓包不回包的 Responses 兼容端点，把 CODEX_HOME 指到临时目录
// （里面放的就是 codex-purge 真实写出的 profile 与指令层），跑一次 `codex exec`，
// 直接看模型真正收到的输入：
//   · 首条 developer 是否就是我们的指令层
//   · 内置基础指令是否消失
//   · 沙箱说明块 / 协同模式块是否被摘掉
//   · danger-full-access 是否生效
//
// `diff()` 再跑一次「未清洗」的对照，把 before/after 逐条列出来。
// 不联网、不消耗额度：请求到本地端点后立刻掐掉。

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import * as paths from "./paths.js";
import * as fsutil from "./fsutil.js";
import * as prompt from "./prompt.js";
import * as cfg from "./config.js";
import { purgeKeys } from "./core.js";

export const CHECKS = {
  captured: "请求已捕获",
  instructions: "指令层进入首条 developer",
  base_prompt_gone: "内置基础指令已消失",
  developer_layer: "developer 层注入生效",
  sandbox_open: "danger-full-access 生效",
  permissions_gone: "沙箱说明块已摘除",
};

/** 内置基础指令在本机版本里的真实开头（实测 input[0]） */
export const BASE_PROMPT_MARKERS = [
  "You are a coding agent running in the Codex CLI",
  "You are Codex",
];

/** 一段结构化的请求解剖结果 */
function dissect(raw) {
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const items = [];
  if (body && Array.isArray(body.input)) {
    for (const it of body.input) {
      const text = Array.isArray(it.content) ? it.content.map((c) => c.text || "").join("\n") : "";
      items.push({ role: it.role || "?", len: text.length, head: text.slice(0, 80) });
    }
  }
  return { body, items, text: raw };
}

/**
 * 构造跨平台可执行的 spawn 参数。
 * Windows 上 Node 20+ 直接 spawn(".cmd") 会抛 EINVAL（Node 不再隐式走 shell），
 * 所以 .cmd/.bat 必须经 ComSpec 转发；这里把命令与参数按 cmd 规则加引号。
 */
export function buildSpawnSpec(cmd, args, { force = false } = {}) {
  const isWin = process.platform === "win32";
  const needsShell = isWin && /\.(cmd|bat)$/i.test(cmd);
  if (!needsShell) return { cmd, args, options: {} };

  const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : String(a));
  const line = [quote(cmd), ...args.map(quote)].join(" ");
  const comspec = process.env.ComSpec || "cmd.exe";
  return {
    cmd: comspec,
    args: ["/d", "/s", "/c", `"${line}"`],
    options: { windowsVerbatimArguments: true, shell: false, force },
  };
}

/** 起端点 → 跑 codex → 抓第一个请求 → 立刻收工 */
async function captureOnce({ home, args, codexJs, timeoutMs = 30000, cwd }) {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push(body);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "codex-purge capture-only endpoint", type: "invalid_request_error" } }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  writeMockConfig(home, port);

  const rawCmd = codexJs ? process.execPath : process.platform === "win32" ? "codex.cmd" : "codex";
  const fullArgs = codexJs ? [codexJs, ...args] : args;
  const spec = buildSpawnSpec(rawCmd, fullArgs);
  let child = null;
  let spawnError = null;
  try {
    child = spawn(spec.cmd, spec.args, {
      cwd: cwd || home,
      env: { ...process.env, CODEX_HOME: home, RUST_BACKTRACE: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...spec.options,
    });
    child.on("error", (e) => (spawnError = e));
  } catch (e) {
    spawnError = e;
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (captured.length > 0 || spawnError) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  if (child && !child.killed) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  await new Promise((resolve) => server.close(resolve));

  return { raw: captured[0] || "", spawnError, port };
}

function writeMockConfig(home, port) {
  const existing = fsutil.readTextOrNull(paths.configPath(home)) ?? "";
  const block = [
    'model = "codex-purge-mock"',
    'model_provider = "purge-mock"',
    "",
    "[model_providers.purge-mock]",
    'name = "purge-mock"',
    `base_url = "http://127.0.0.1:${port}/v1"`,
    'wire_api = "responses"',
    "",
  ].join("\n");
  // 保住已有的受管块（如果这里有），再补 mock provider
  const merged = existing.includes("[model_providers.purge-mock]")
    ? existing.replace(/base_url = "http:\/\/127\.0\.0\.1:\d+\/v1"/, `base_url = "http://127.0.0.1:${port}/v1"`)
    : `${block}${existing ? "\n" + existing : ""}`;
  fsutil.writeAtomic(paths.configPath(home), merged);
}

/** 准备「已清洗」的临时 CODEX_HOME：复刻 apply 的真实产物 */
function makePurgedHome(home) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-purge-verify-"));
  const realProfile = paths.profilePath(home);
  const realInstructions = paths.instructionsPath(home);
  const applied = fs.existsSync(realProfile);

  if (applied) {
    fs.copyFileSync(realProfile, paths.profilePath(tmp));
    if (fs.existsSync(realInstructions)) fs.copyFileSync(realInstructions, paths.instructionsPath(tmp));
  } else {
    fsutil.ensureDir(paths.purgeDir(tmp));
    fsutil.writeAtomic(paths.instructionsPath(tmp), prompt.ensureSentinel(prompt.defaultPrompt()));
    cfg.writeProfile(paths.profilePath(tmp), purgeKeys(tmp));
  }
  fsutil.ensureDir(path.join(tmp, "work"));
  return { tmp, applied };
}

/** 准备「未清洗」的对照临时 CODEX_HOME：只放 mock provider */
function makeBaselineHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-purge-base-"));
  fsutil.ensureDir(path.join(tmp, "work"));
  return tmp;
}

/**
 * @param {{home?:string, timeoutMs?:number, codexJs?:string}} opts
 */
export async function verify(opts = {}) {
  const home = path.resolve(opts.home || paths.codexHome());
  const { tmp, applied } = makePurgedHome(home);
  const work = path.join(tmp, "work");

  const args = ["-p", "codex-purge", "exec", "--skip-git-repo-check", "codex-purge verify"];
  const out = await captureOnce({
    home: tmp,
    args,
    codexJs: opts.codexJs || (paths.findNpmBin() || {}).codexJs || null,
    timeoutMs: opts.timeoutMs,
    cwd: work,
  });

  const raw = out.raw;
  const { items } = dissect(raw);
  const checks = [];
  const record = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  record(CHECKS.captured, !!raw, out.spawnError ? `启动失败：${out.spawnError.message}` : raw ? "已抓到第一个请求" : "无请求");

  record(
    CHECKS.instructions,
    raw.includes(prompt.SENTINEL),
    raw.includes(prompt.SENTINEL) ? "哨兵命中" : "未命中哨兵 codex-purge:instructions",
  );

  const leftover = BASE_PROMPT_MARKERS.filter((m) => raw.includes(m));
  record(
    CHECKS.base_prompt_gone,
    raw.length > 0 && leftover.length === 0,
    raw.length === 0 ? "无请求体" : leftover.length ? `仍残留: ${leftover.join(" / ")}` : "基础指令已整份替换",
  );

  record(
    CHECKS.developer_layer,
    raw.includes("[codex-purge:developer]"),
    raw.includes("[codex-purge:developer]") ? "developer 位命中" : "未命中 developer 层",
  );
  record(CHECKS.sandbox_open, raw.includes("danger-full-access"), raw.includes("danger-full-access") ? "沙箱模式已放开" : "未看到 danger-full-access");
  record(CHECKS.permissions_gone, raw.length > 0 && !raw.includes("Filesystem sandboxing defines"), raw.length ? "沙箱说明块不在输入里" : "无请求体");

  return {
    ok: checks.every((c) => c.ok),
    home,
    tmp_home: tmp,
    checks,
    prompt_source: applied ? "applied-profile" : "generated",
    first_item_head: items[0] ? items[0].head : null,
    items,
    bytes_captured: raw.length,
    version: (opts.codexJs && paths.versionFromPath(opts.codexJs)) || paths.codexVersion(),
    codex_js: opts.codexJs || null,
  };
}

/**
 * 前后对照：同一台机器、同一个 prompt，只差一个 `-p codex-purge`。
 * @param {{home?:string, timeoutMs?:number, codexJs?:string}} opts
 */
export async function diff(opts = {}) {
  const home = path.resolve(opts.home || paths.codexHome());
  const codexJs = opts.codexJs || (paths.findNpmBin() || {}).codexJs || null;
  const timeoutMs = opts.timeoutMs || 30000;

  const baseHome = makeBaselineHome();
  const baseOut = await captureOnce({
    home: baseHome,
    args: ["exec", "--skip-git-repo-check", "codex-purge probe"],
    codexJs,
    timeoutMs,
    cwd: path.join(baseHome, "work"),
  });

  const { tmp: purgeHome } = makePurgedHome(home);
  const purgeOut = await captureOnce({
    home: purgeHome,
    args: ["-p", "codex-purge", "exec", "--skip-git-repo-check", "codex-purge probe"],
    codexJs,
    timeoutMs,
    cwd: path.join(purgeHome, "work"),
  });

  const before = dissect(baseOut.raw);
  const after = dissect(purgeOut.raw);
  const rows = [];
  const max = Math.max(before.items.length, after.items.length);
  for (let i = 0; i < max; i++) {
    const b = before.items[i];
    const a = after.items[i];
    rows.push({
      slot: `input[${i}]`,
      role: (a && a.role) || (b && b.role) || "?",
      before_len: b ? b.len : null,
      after_len: a ? a.len : null,
      before_head: b ? b.head.replace(/\s+/g, " ") : null,
      after_head: a ? a.head.replace(/\s+/g, " ") : null,
      delta: b && a ? a.len - b.len : null,
    });
  }

  return {
    ok: !!baseOut.raw && !!purgeOut.raw,
    home,
    version: (codexJs && paths.versionFromPath(codexJs)) || paths.codexVersion(),
    bytes_before: baseOut.raw.length,
    bytes_after: purgeOut.raw.length,
    base_prompt_before: BASE_PROMPT_MARKERS.some((m) => baseOut.raw.includes(m)),
    base_prompt_after: BASE_PROMPT_MARKERS.some((m) => purgeOut.raw.includes(m)),
    danger_before: baseOut.raw.includes("danger-full-access"),
    danger_after: purgeOut.raw.includes("danger-full-access"),
    rows,
  };
}

export function summarizeVerify(result) {
  const lines = [];
  lines.push(`codex-purge 验证 / verify — ${result.ok ? "通过" : "未通过"}`);
  lines.push(`  CODEX_HOME 副本 ${result.tmp_home}`);
  lines.push(`  来源            ${result.prompt_source}`);
  lines.push(`  codex 版本      ${result.version || "未探测"}${result.codex_js ? `（${result.codex_js}）` : ""}`);
  lines.push(`  抓包字节        ${result.bytes_captured}`);
  for (const c of result.checks) lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  if (result.first_item_head) lines.push(`  首条输入        ${result.first_item_head.replace(/\s+/g, " ")}`);
  return lines.join("\n");
}

export function summarizeDiff(result) {
  const lines = [];
  lines.push(`codex-purge 前后对照 / diff — ${result.ok ? "抓到两组" : "抓包不完整"}`);
  lines.push(`  codex 版本   ${result.version || "未探测"}`);
  lines.push(`  请求体积     未清洗 ${result.bytes_before} → 已清洗 ${result.bytes_after}`);
  lines.push("");
  const w = 9;
  lines.push(`  ${"slot".padEnd(w)} ${"role".padEnd(9)} ${"before".padStart(7)} ${"after".padStart(7)} ${"delta".padStart(7)}  首段`);
  for (const r of result.rows) {
    const d = r.delta == null ? "-" : r.delta > 0 ? `+${r.delta}` : String(r.delta);
    const head = (r.after_head || r.before_head || "").slice(0, 46);
    lines.push(`  ${r.slot.padEnd(w)} ${String(r.role).padEnd(9)} ${String(r.before_len ?? "-").padStart(7)} ${String(r.after_len ?? "-").padStart(7)} ${d.padStart(7)}  ${head}`);
  }
  lines.push("");
  lines.push(`  内置基础指令   未清洗 ${result.base_prompt_before ? "在" : "不在"} → 已清洗 ${result.base_prompt_after ? "在" : "不在"}`);
  lines.push(`  danger-full-access  未清洗 ${result.danger_before ? "在" : "不在"} → 已清洗 ${result.danger_after ? "在" : "不在"}`);
  return lines.join("\n");
}