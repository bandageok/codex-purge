#!/usr/bin/env node
// codex-purge — 端到端验证入口
// 用法: node scripts/verify.mjs [--home <CODEX_HOME>] [--timeout <ms>]

import * as verify from "../lib/verify.js";

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1] || null;
};

const result = await verify.verify({
  home: opt("--home") || undefined,
  timeoutMs: Number(opt("--timeout") || 30000),
});

console.log(verify.summarizeVerify(result));
if (!result.ok) {
  console.log("\n失败提示：确认本机已安装 @openai/codex（npm i -g @openai/codex），");
  console.log("并确认 codex exec 能在无 auth 情况下加载自定义 model_provider。");
  process.exitCode = 1;
}