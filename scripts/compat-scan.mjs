#!/usr/bin/env node
// codex-purge — 上游兼容性探针
//
// 每个版本升级后先跑这个：把「我们依赖的每一个开关」在原生二进制里探一遍，
// 报告还在不在、偏移变了没有。缺哪个，就知道哪条补丁会退化成 pending。
//
// 用法:
//   node scripts/compat-scan.mjs [--binary <codex.exe>] [--json]
// 默认自动定位本机 @openai/codex 的原生二进制。

import fs from "node:fs";
import path from "node:path";

import * as paths from "../lib/paths.js";

/** 我们依赖的配置键 / 参数 / 提示词标记。missing 会直接影响对应补丁。 */
export const PROBES = [
  { key: "model_instructions_file", patch: 2, kind: "config" },
  { key: "developer_instructions", patch: 3, kind: "config" },
  { key: "approval_policy", patch: 4, kind: "config" },
  { key: "sandbox_mode", patch: 5, kind: "config" },
  { key: "include_permissions_instructions", patch: 6, kind: "config" },
  { key: "include_apps_instructions", patch: 7, kind: "config" },
  { key: "include_collaboration_mode_instructions", patch: 8, kind: "config" },
  { key: "danger-full-access", patch: 5, kind: "enum" },
  // clap 存的是不带前导 -- 的参数名，探针两种写法都试（见 variants）
  { key: "dangerously-bypass-approvals-and-sandbox", patch: 12, kind: "flag" },
  { key: "CONFIG_PROFILE_V2", patch: 9, kind: "flag" }, // -p 的 clap 类型名
  { key: "You are a coding agent running in the Codex CLI", patch: 1, kind: "prompt" },
];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

export function findBinary() {
  const explicit = argValue("--binary");
  if (explicit) return explicit;
  const native = paths.nativeBinaryCandidates();
  const exe = native.find((p) => /codex(\.exe)?$/.test(p) && !/command-runner|sandbox-setup|code-mode/.test(p));
  return exe || null;
}

/** 从二进制附近的包元数据里读版本（不依赖本机已安装的那个） */
export function detectVersion(binary) {
  let dir = path.dirname(path.resolve(binary));
  for (let i = 0; i < 6; i++) {
    for (const name of ["codex-package.json", "package.json"]) {
      const p = path.join(dir, name);
      try {
        const meta = JSON.parse(fs.readFileSync(p, "utf8"));
        if (meta && meta.version && (meta.name || "").includes("codex")) {
          return String(meta.version).replace(/-(win32|linux|darwin)-(x64|arm64)$/, "");
        }
      } catch {
        /* 继续向上找 */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function scan(binary) {
  const data = fs.readFileSync(binary);
  const rows = PROBES.map((probe) => {
    const variants = probe.kind === "flag" ? [probe.key, `--${probe.key}`] : [probe.key];
    let at = -1;
    for (const v of variants) {
      at = data.indexOf(Buffer.from(v, "utf8"));
      if (at !== -1) break;
    }
    return { ...probe, present: at !== -1, offset: at === -1 ? null : at };
  });
  return {
    binary,
    size: data.length,
    version: detectVersion(binary) || paths.codexVersion(),
    rows,
    missing: rows.filter((r) => !r.present),
  };
}

function main() {
  const binary = findBinary();
  if (!binary || !fs.existsSync(binary)) {
    console.error("未找到 codex 原生二进制；用 --binary <path> 指定。");
    process.exitCode = 2;
    return;
  }
  const result = scan(binary);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.missing.length ? 1 : 0;
    return;
  }

  console.log(`codex-purge 兼容性探针 / compat-scan`);
  console.log(`  二进制  ${result.binary}`);
  console.log(`  体积    ${result.size.toLocaleString()} bytes`);
  console.log(`  版本    ${result.version || "未探测"}`);
  console.log("");
  for (const r of result.rows) {
    const mark = r.present ? "✓" : "✗";
    const where = r.present ? `@ ${r.offset}` : "缺失";
    console.log(`  ${mark} [${String(r.patch).padStart(2)}] ${r.kind.padEnd(6)} ${r.key.padEnd(46)} ${where}`);
  }
  console.log("");
  if (result.missing.length) {
    console.log(`  ${result.missing.length} 个探针缺失 → 对应补丁会退化为 pending：`);
    for (const m of result.missing) console.log(`    · #${m.patch} ${m.key}`);
    process.exitCode = 1;
  } else {
    console.log("  全部命中：14 条补丁的依赖都在。");
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("compat-scan.mjs")) {
  main();
}