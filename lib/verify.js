// codex-purge — 端到端验证
//
// 做法：起一个只抓包不回包的 Responses 兼容端点，把 CODEX_HOME 指到临时目录
// （里面放的就是 codex-purge 真实写出的 profile 与指令层），跑一次 `codex exec`，
// 直接看模型真正收到的输入：
//   · 首条 developer 是否就是我们的指令层
//   · 内置 "You are Codex" 是否消失
//   · 沙箱说明块 / 协同模式块是否被摘掉
//   · danger-full-access 是否生效
//
// 不联网、不消耗额度：请求到本地端点后立刻掐掉。

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import * as paths from "./paths.js";
import * as fsutil from "./fsutil.js";
import * as prompt from "./prompt.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CHECKS = {
  captured: "请求已捕获",
  instructions: "指令层进入首条 developer",
  base_prompt_gone: "内置基础指令已消失",
  developer_layer: "developer 层注入生效",
  sandbox_open: "danger-full-access 生效",
  permissions_gone: "沙箱说明块已摘除",
};

/**
 * @param {{home?:string, timeoutMs?:number, codexJs?:string}} opts
 */
export async function verify(opts = {}) {
  const home = opts.home || paths.codexHome();
  const timeoutMs = opts.timeoutMs || 30000;
  const captured = [];

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured.push(body);
      // 抓包即够：立刻回一个终止状态，让 codex 停止重试
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "codex-purge capture-only endpoint", type: "invalid_request_error" } }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-purge-verify-"));
  const work = path.join(tmpHome, "work");
  fsutil.ensureDir(work);

  // 把真实产物复刻进临时 CODEX_HOME：验证的就是 apply 写出来的东西
  const realProfile = paths.profilePath(home);
  const realInstructions = paths.instructionsPath(home);
  const hasProfile = fs.existsSync(realProfile);
  if (hasProfile) fs.copyFileSync(realProfile, paths.profilePath(tmpHome));
  else {
    // 未 apply 也能验证机制：用本次生成的指令层临时写一份
    fsutil.ensureDir(paths.purgeDir(tmpHome));
    fsutil.writeAtomic(paths.instructionsPath(tmpHome), prompt.ensureSentinel(prompt.defaultPrompt()));
    const { purgeKeys } = await import("./core.js");
    const { writeProfile } = await import("./config.js");
    writeProfile(paths.profilePath(tmpHome), purgeKeys(tmpHome));
  }
  if (fs.existsSync(realInstructions) && !fs.existsSync(paths.instructionsPath(tmpHome))) {
    fs.copyFileSync(realInstructions, paths.instructionsPath(tmpHome));
  }

  fsutil.writeAtomic(
    paths.configPath(tmpHome),
    [
      'model = "codex-purge-mock"',
      'model_provider = "purge-mock"',
      "",
      "[model_providers.purge-mock]",
      'name = "purge-mock"',
      `base_url = "http://127.0.0.1:${port}/v1"`,
      'wire_api = "responses"',
      "",
    ].join("\n"),
  );

  const bin = paths.findNpmBin();
  const codexJs = opts.codexJs || (bin && bin.codexJs) || null;
  const cmd = codexJs ? process.execPath : process.platform === "win32" ? "codex.cmd" : "codex";
  const args = codexJs
    ? [codexJs, "-p", "codex-purge", "exec", "--skip-git-repo-check", "codex-purge verify"]
    : ["-p", "codex-purge", "exec", "--skip-git-repo-check", "codex-purge verify"];

  let child = null;
  let spawnError = null;
  try {
    child = spawn(cmd, args, {
      cwd: work,
      env: { ...process.env, CODEX_HOME: tmpHome, RUST_BACKTRACE: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.on("error", (e) => (spawnError = e));
  } catch (e) {
    spawnError = e;
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (captured.length > 0) break;
    if (spawnError) break;
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

  const checks = [];
  const raw = captured[0] || "";
  const record = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  record(CHECKS.captured, captured.length > 0, spawnError ? `启动失败：${spawnError.message}` : raw ? "200 字节起" : "无请求");

  const text = raw;
  const input = safeParseArray(raw);

  record(
    CHECKS.instructions,
    text.includes(prompt.SENTINEL),
    text.includes(prompt.SENTINEL) ? "哨兵命中" : "未命中哨兵 codex-purge:instructions",
  );
  record(CHECKS.base_prompt_gone, text.length > 0 && !text.includes("You are Codex"), text.length ? "已替换基础指令" : "无请求体");
  record(CHECKS.developer_layer, text.includes("[codex-purge:developer]"), text.includes("[codex-purge:developer]") ? "developer 位命中" : "未命中 developer 层");
  record(CHECKS.sandbox_open, text.includes("danger-full-access"), text.includes("danger-full-access") ? "沙箱模式已放开" : "未看到 danger-full-access");
  record(CHECKS.permissions_gone, text.length > 0 && !text.includes("Filesystem sandboxing defines"), "沙箱说明块状态");

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    home,
    tmp_home: tmpHome,
    checks,
    prompt_source: hasProfile ? "applied-profile" : "generated",
    first_item_head: input && input[0] ? firstText(input[0]).slice(0, 160) : null,
    bytes_captured: raw.length,
    version: paths.codexVersion(bin),
  };
}

function safeParseArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.input) ? parsed.input : null;
  } catch {
    return null;
  }
}

function firstText(item) {
  if (!item || !Array.isArray(item.content)) return "";
  return item.content.map((c) => c.text || "").join("\n");
}

export function summarizeVerify(result) {
  const lines = [];
  lines.push(`codex-purge 验证 / verify — ${result.ok ? "通过" : "未通过"}`);
  lines.push(`  CODEX_HOME 副本 ${result.tmp_home}`);
  lines.push(`  来源          ${result.prompt_source}`);
  lines.push(`  codex 版本    ${result.version || "未探测"}`);
  lines.push(`  抓包字节      ${result.bytes_captured}`);
  for (const c of result.checks) lines.push(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
  if (result.first_item_head) lines.push(`  首条输入      ${result.first_item_head.replace(/\n/g, " ")}`);
  return lines.join("\n");
}

export const _internal = { HERE };