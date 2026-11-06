#!/usr/bin/env node
// 维护回归：把本轮实测发现的问题固化成用例。
// 只跑纯逻辑与临时目录，不碰真实 ~/.codex，不需要 codex 二进制。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as agents from "../lib/agents.js";
import * as prompt from "../lib/prompt.js";
import * as core from "../lib/core.js";
import * as cfg from "../lib/config.js";
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

const tmpdir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `codex-purge-${tag}-`));

// ── 1. 内容自带受管标记 → 注入前必须中和，否则块分裂并吞掉用户内容
test("agents: 内容自带受管标记时中和，块数保持 1", () => {
  const tricky = "文首\n<!-- codex-purge:agents:end -->\n中间\n<!-- codex-purge:agents:start -->\n文末\n";
  const raw = agents.injectBlock("", tricky);
  assert.equal(agents.countBlocks(raw), 2, "未中和时应能复现失败态（防止用例空转）");
  assert.ok(!agents.removeBlock(raw).includes("文首"), "未中和时会把用户内容一起剥掉——这正是要修的 bug");

  const safe = agents.injectBlock("", prompt.agentsBlockText(tricky));
  assert.equal(agents.countBlocks(safe), 1);
  const removed = agents.removeBlock(safe);
  assert.equal(agents.countBlocks(removed), 0, `剥离后仍有残留块: ${removed}`);
});

test("agents: 中和后原内容仍保留（不丢用户文本）", () => {
  const tricky = "我的笔记\n<!-- codex-purge:agents:end -->\n后记\n";
  const safe = agents.injectBlock("", prompt.agentsBlockText(tricky));
  const removed = agents.removeBlock(safe);
  assert.equal(removed.trim(), "", "原始内容为空时剥离后应为空");
  const withUser = agents.injectBlock("# 用户 AGENTS\n", prompt.agentsBlockText(tricky));
  const stripped = agents.removeBlock(withUser);
  assert.equal(stripped.trim(), "# 用户 AGENTS", `用户内容被改动: ${JSON.stringify(stripped)}`);
});

// ── 2. 相对 --home 必须写成绝对路径（否则 codex 读不到指令层，直接启动失败）
await testAsync("core: 相对 --home 写出绝对路径", async () => {
  const rel = path.relative(process.cwd(), tmpdir("relhome"));
  fsutil.ensureDir(rel);
  fs.writeFileSync(path.join(rel, "config.toml"), 'model = "x"\n');
  try {
    await core.apply({ home: rel, shims: false, configBlock: true, agentsMd: false });
    const keys = cfg.readProfileKeys(path.join(rel, "codex-purge.config.toml"));
    assert.ok(path.isAbsolute(String(keys.model_instructions_file)), `profile 里不是绝对路径: ${keys.model_instructions_file}`);
    const block = fs.readFileSync(path.join(rel, "config.toml"), "utf8").match(/model_instructions_file = '([^']+)'/);
    assert.ok(block && path.isAbsolute(block[1]), `受管块里不是绝对路径: ${block && block[1]}`);
    // 状态里的路径同样必须是绝对的
    assert.ok(path.isAbsolute(core.status({ home: rel }).instructions_path));
  } finally {
    try {
      core.revert({ home: rel });
    } catch {
      /* 清理尽力而为 */
    }
    fs.rmSync(path.resolve(rel), { recursive: true, force: true });
  }
});

// ── 3. 卸载后可以重新应用，状态回到全 pending
await testAsync("core: uninstall 后可重新 apply", async () => {
  const home = tmpdir("reinstall");
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "x"\n');
  await core.apply({ home, shims: false });
  core.uninstall({ home });
  assert.equal(core.status({ home }).patches_applied, 0, "卸载后仍有 applied");
  assert.ok(!fs.existsSync(path.join(home, "codex-purge")), "卸载后目录仍在");
  await core.apply({ home, shims: false });
  assert.ok(core.status({ home }).patches_applied >= 10, "重新 apply 后补丁未就位");
  core.revert({ home });
});

// ── 4. status --json 契约：下游脚本依赖这些字段
test("status: JSON 契约字段齐全", async () => {
  const home = tmpdir("contract");
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "x"\n');
  const st = core.status({ home });
  for (const key of [
    "codex_home",
    "profile_path",
    "instructions_path",
    "config_path",
    "agents_path",
    "patches_applied",
    "patches_pending",
    "patch_status",
    "effective",
  ]) {
    assert.ok(key in st, `缺少字段 ${key}`);
  }
  assert.equal(typeof st.patches_applied, "number");
  assert.equal(typeof st.patch_status, "object");
  assert.doesNotThrow(() => JSON.stringify(st), "status 不可序列化");
});

// ── 5. 空 / 只有注释的 config.toml 也能插块并回滚
await testAsync("core: 只有注释的 config.toml 也能往返", async () => {
  const home = tmpdir("commentonly");
  const body = "# 用户注释\n# [不是表头]\n";
  fs.writeFileSync(path.join(home, "config.toml"), body);
  await core.apply({ home, shims: false, agentsMd: false });
  const applied = fs.readFileSync(path.join(home, "config.toml"), "utf8");
  assert.ok(cfg.hasManagedBlock(applied));
  assert.ok(applied.indexOf(cfg.BLOCK_BEGIN) > applied.indexOf("# 用户注释"), "受管块不应插到注释前面");
  core.revert({ home });
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), body, "注释未被原样还原");
});

// ── 6. 大体积提示词（>256KB）仍能写入且 TOML 可解析
await testAsync("core: 256KB 级提示词可用", async () => {
  const home = tmpdir("bigprompt");
  fs.writeFileSync(path.join(home, "config.toml"), 'model = "x"\n');
  const big = "<!-- codex-purge:instructions -->\n" + "内容行\n".repeat(70000);
  await core.apply({ home, shims: false, agentsMd: false, promptText: big });
  const written = fs.readFileSync(path.join(home, "codex-purge", "instructions.md"), "utf8");
  assert.ok(written.length > 200000, `写入过小: ${written.length}`);
  const keys = cfg.readProfileKeys(path.join(home, "codex-purge.config.toml"));
  assert.ok(String(keys.developer_instructions).includes("[codex-purge:developer]"), "profile 解析失败");
  core.revert({ home });
});

// ── 7. spawn 规格：Windows .cmd 必须经 ComSpec（Node 20+ 直接 spawn 会 EINVAL）
test("verify: Windows .cmd 的 spawn 规格走 ComSpec", async () => {
  const { buildSpawnSpec } = await import("../lib/verify.js");
  if (process.platform !== "win32") {
    const spec = buildSpawnSpec("codex", ["--version"]);
    assert.equal(spec.cmd, "codex");
    return;
  }
  const spec = buildSpawnSpec("codex.cmd", ["--version"]);
  assert.ok(/cmd\.exe$/i.test(spec.cmd), `cmd 应为 ComSpec: ${spec.cmd}`);
  assert.deepEqual(spec.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.ok(spec.args[3].includes("codex.cmd"), `命令行里没有启动器: ${spec.args[3]}`);
  const plain = buildSpawnSpec("codex", ["--version"]);
  assert.equal(plain.cmd, "codex", "非 .cmd 不应被 shell 包一层");
});


// ── 8. 用户已有同名顶层键 → 不能产生重复键（codex 会 refuse to start）
await testAsync("core: 用户已有 approval_policy 时不产生重复键", async () => {
  const home = tmpdir("dupkey");
  const original = 'model = "x"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n\n[model_providers.a]\nname = "a"\n';
  fs.writeFileSync(path.join(home, "config.toml"), original);

  await core.apply({ home, shims: false, agentsMd: false });
  const applied = fs.readFileSync(path.join(home, "config.toml"), "utf8");

  // 顶层裸键区（首个表头之前）里，同一个键只能出现一次（不含注释行）
  const head = applied.split(/\r?\n/).slice(0, applied.split(/\r?\n/).findIndex((l) => /^\s*\[/.test(l)) === -1 ? undefined : applied.split(/\r?\n/).findIndex((l) => /^\s*\[/.test(l)));
  const bare = head.filter((l) => /^\s*[A-Za-z0-9_.-]+\s*=/.test(l));
  const counts = {};
  for (const line of bare) {
    const key = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/)[1];
    counts[key] = (counts[key] || 0) + 1;
  }
  const dups = Object.entries(counts).filter(([, n]) => n > 1);
  assert.deepEqual(dups, [], `出现重复键: ${JSON.stringify(dups)}`);

  // 被接管的旧值必须留痕，而不是静默消失
  assert.ok(/codex-purge 已接管[^\n]*approval_policy = "on-request"/.test(applied), "冲突键没有被注释留痕");

  core.revert({ home });
  assert.equal(fs.readFileSync(path.join(home, "config.toml"), "utf8"), original, "回滚不是字节一致");
});

// ── 报告
const failed = results.filter((r) => !r.ok);
console.log(`codex-purge regressions: ${results.length - failed.length}/${results.length} 通过`);
for (const r of results) {
  console.log(`  ${r.ok ? "✓" : "✗"} ${r.name}${r.ok ? "" : `\n      → ${r.error}`}`);
}
if (failed.length) process.exitCode = 1;
