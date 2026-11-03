#!/usr/bin/env node
// codex-purge — 自检（不需要安装 codex，不需要联网）
//
// 覆盖：提示词解析、TOML 受管块位置与还原、AGENTS.md 幂等、apply/revert 字节级一致、
//       shim 安装与还原、补丁状态机。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as prompt from "../lib/prompt.js";
import * as cfg from "../lib/config.js";
import * as agents from "../lib/agents.js";
import * as shim from "../lib/shim.js";
import * as core from "../lib/core.js";
import * as paths from "../lib/paths.js";
import * as fsutil from "../lib/fsutil.js";

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e && e.message ? e.message : String(e) });
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, error: e && e.message ? e.message : String(e) });
  }
}

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codex-purge-${tag}-`));
}

// ---------------------------------------------------------------- prompt
test("prompt: 默认指令层带哨兵", () => {
  const r = prompt.resolvePrompt({});
  assert.equal(r.source, "default");
  assert.ok(r.text.includes(prompt.SENTINEL));
  assert.ok(r.text.length > 500);
});

test("prompt: 预设可解析", () => {
  const names = prompt.listPresets();
  assert.ok(names.includes("strict"), `presets=${names.join(",")}`);
  const r = prompt.resolvePrompt({ preset: "strict" });
  assert.ok(r.text.includes("codex-purge:instructions"));
});

test("prompt: 未知预设报错", () => {
  assert.throws(() => prompt.resolvePrompt({ preset: "nope-not-here" }), /未知预设/);
});

test("prompt: 缺哨兵时自动补", () => {
  const r = prompt.resolvePrompt({ text: "hello" });
  assert.ok(r.text.startsWith("<!-- codex-purge:instructions -->"));
});

// ---------------------------------------------------------------- config
test("toml: 裸键写在表头之前，表内容不被打散", () => {
  const src = 'model = "x"\n\n[model_providers.a]\nname = "a"\n';
  const out = cfg.upsertTopLevel(src, { approval_policy: "never" });
  const lines = out.split("\n");
  const firstHeader = lines.findIndex((l) => /^\s*\[/.test(l));
  const keyLine = lines.findIndex((l) => l.startsWith("approval_policy"));
  assert.ok(keyLine > -1 && keyLine < firstHeader, "裸键必须在首个表头之前");
  assert.ok(out.includes('[model_providers.a]\nname = "a"'));
});

test("toml: 受管块插在首个表头之前", () => {
  const src = 'model = "x"\n[projects."/tmp"]\ntrust_level = "trusted"\n';
  const out = cfg.insertManagedBlock(src, { approval_policy: "never", sandbox_mode: "danger-full-access" });
  const idxBlock = out.indexOf(cfg.BLOCK_BEGIN);
  const idxTable = out.indexOf('[projects."/tmp"]');
  assert.ok(idxBlock > -1 && idxBlock < idxTable, "受管块必须在首个表头之前");
  assert.ok(cfg.hasManagedBlock(out));
});

test("toml: 受管块只出现一次（幂等）", () => {
  let text = 'model = "x"\n\n[model_providers.a]\nname = "a"\n';
  for (let i = 0; i < 5; i++) text = cfg.insertManagedBlock(text, { approval_policy: "never" });
  const count = text.split(cfg.BLOCK_BEGIN).length - 1;
  assert.equal(count, 1);
});

test("toml: 字面量转义安全（不炸引号/反斜杠）", () => {
  const v = cfg.tomlValue("C:\\Users\\a b\\x");
  assert.ok(v.startsWith("'") || v.startsWith('"""'));
  const multi = cfg.tomlValue("line1\nline2");
  assert.ok(multi.startsWith('"""') && multi.endsWith('"""'));
});

// ---------------------------------------------------------------- agents
test("agents: 注入后只有一块，还原后原文一致", () => {
  const original = "# AGENTS\n\n用户自己的内容。\n";
  const injected = agents.injectBlock(original, "PURGE-BLOCK");
  assert.equal(agents.countBlocks(injected), 1);
  const injected2 = agents.injectBlock(injected, "PURGE-BLOCK-V2");
  assert.equal(agents.countBlocks(injected2), 1, "重复注入不能叠加");
  assert.ok(injected2.includes("PURGE-BLOCK-V2"));
  const restored = agents.removeBlock(injected2);
  assert.equal(restored.trimEnd(), original.trimEnd());
});

// ---------------------------------------------------------------- shim
test("shim: 安装接管、revert 字节级还原", () => {
  const dir = tmpdir("shim");
  const name = process.platform === "win32" ? "codex.cmd" : "codex";
  const file = path.join(dir, name);
  const original = name.endsWith(".cmd") ? "@ECHO off\r\nREM original\r\n" : "#!/bin/sh\necho original\n";
  fs.writeFileSync(file, original);

  const r = shim.install(dir, name, ["-p", "codex-purge"], null);
  assert.ok(r.installed);
  const shimmed = fs.readFileSync(file, "utf8");
  assert.ok(shimmed.includes("codex-purge shim"));
  assert.ok(shimmed.includes("-p codex-purge"));
  assert.ok(fs.existsSync(shim.backupPathFor(file)), `备份应在 ${shim.backupPathFor(file)}`);

  const again = shim.install(dir, name, ["-p", "codex-purge"], null);
  assert.ok(again.updated, "二次安装应走更新分支");

  shim.revert(dir, name);
  assert.equal(fs.readFileSync(file, "utf8"), original, "revert 必须字节级还原");
});

// ---------------------------------------------------------------- core
function makeHome(configBody) {
  const home = tmpdir("home");
  fs.writeFileSync(
    path.join(home, "config.toml"),
    configBody ??
      [
        'model = "gpt-5"',
        "",
        "[model_providers.deepseek]",
        'name = "deepseek"',
        'base_url = "https://api.deepseek.com"',
        'wire_api = "responses"',
        "",
      ].join("\n"),
  );
  fs.writeFileSync(path.join(home, "AGENTS.md"), "# 用户自己的 AGENTS\n\n- 保留这一行\n");
  return home;
}

await testAsync("core: apply → 全层就位", async () => {
  const home = makeHome();
  const originalConfig = fs.readFileSync(path.join(home, "config.toml"));
  const originalAgents = fs.readFileSync(path.join(home, "AGENTS.md"));

  await core.apply({ home, shims: false });
  const st = core.status({ home });

  assert.equal(st.patch_status[1], "applied", "指令层");
  for (const id of [2, 3, 4, 5, 6, 7, 8]) assert.equal(st.patch_status[id], "applied", `patch ${id}`);
  assert.equal(st.patch_status[9], "applied", "profile");
  assert.equal(st.patch_status[10], "applied", "config 块");
  assert.equal(st.patch_status[11], "applied", "AGENTS 块");
  // 本次 apply 显式跳过 shim：应为 pending（启动器存在）或 n/a（启动器不存在）
  assert.ok(["pending", "n/a"].includes(st.patch_status[12]), `shim 状态异常: ${st.patch_status[12]}`);

  const profile = cfg.readProfileKeys(path.join(home, "codex-purge.config.toml"));
  assert.equal(profile.approval_policy, "never");
  assert.equal(profile.sandbox_mode, "danger-full-access");
  assert.ok(String(profile.model_instructions_file).includes("instructions.md"));
  assert.equal(profile.include_permissions_instructions, false);
  assert.ok(String(profile.developer_instructions).includes("[codex-purge:developer]"));

  const configText = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.ok(cfg.hasManagedBlock(configText));
  assert.ok(configText.indexOf(cfg.BLOCK_BEGIN) < configText.indexOf("[model_providers.deepseek]"));

  // 幂等：二次 apply 不叠加
  await core.apply({ home, shims: false });
  const configText2 = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.equal(configText2.split(cfg.BLOCK_BEGIN).length - 1, 1);
  const agentsText = fs.readFileSync(path.join(home, "AGENTS.md"), "utf8");
  assert.equal(agents.countBlocks(agentsText), 1);

  // revert：字节级还原
  core.revert({ home });
  assert.deepEqual(fs.readFileSync(path.join(home, "config.toml")), originalConfig, "config.toml 必须还原");
  assert.deepEqual(fs.readFileSync(path.join(home, "AGENTS.md")), originalAgents, "AGENTS.md 必须还原");
  assert.ok(!fs.existsSync(path.join(home, "codex-purge.config.toml")), "profile 应被删除");
  assert.ok(!fs.existsSync(path.join(home, "codex-purge", "instructions.md")), "指令层应被删除");

  const st2 = core.status({ home });
  assert.equal(st2.patches_applied, 0, `revert 后不应残留 applied: ${JSON.stringify(st2.patch_status)}`);
});

await testAsync("core: --no-config-block / --no-agents 生效", async () => {
  const home = makeHome();
  const originalConfig = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  await core.apply({ home, shims: false, configBlock: false, agentsMd: false });
  const st = core.status({ home });
  assert.equal(st.patch_status[10], "pending");
  assert.equal(st.patch_status[11], "pending");
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), originalConfig);
});

await testAsync("core: 空 config.toml 也能插入且 revert 后清空", async () => {
  const home = tmpdir("empty");
  fs.writeFileSync(path.join(home, "config.toml"), "");
  await core.apply({ home, shims: false });
  const st = core.status({ home });
  assert.equal(st.patch_status[10], "applied");
  core.revert({ home });
  const after = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.equal(after.trim(), "", `应回到空文件，实际: ${JSON.stringify(after)}`);
});

await testAsync("core: 预设切换写进指令层", async () => {
  const home = makeHome();
  await core.apply({ home, shims: false, preset: "ctf" });
  const text = fs.readFileSync(path.join(home, "codex-purge", "instructions.md"), "utf8");
  assert.ok(text.includes('preset="ctf"'));
  core.revert({ home });
});

await testAsync("core: 二次 apply 不污染备份（脏备份回归）", async () => {
  const home = tmpdir("poison");
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "x"\n');
  await core.apply({ home, shims: false });
  await core.apply({ home, shims: false });
  core.revert({ home });
  const agentsLeft = fsutil.readTextOrNull(path.join(home, "AGENTS.md"));
  assert.ok(agentsLeft == null || !agents.hasBlock(agentsLeft), `AGENTS.md 仍带受管块: ${agentsLeft}`);
  assert.equal(core.status({ home }).patches_applied, 0);
});

// ---------------------------------------------------------------- report
const failed = results.filter((r) => !r.ok);
console.log(`codex-purge selftest: ${results.length - failed.length}/${results.length} 通过`);
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n      → ${r.error}`}`);
}
if (failed.length) process.exitCode = 1;