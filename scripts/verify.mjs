#!/usr/bin/env node
// codex-purge — 端到端验证 / 前后对照入口
// 用法:
//   node scripts/verify.mjs [--diff] [--json] [--codex-js <path>] [--home <dir>] [--timeout <ms>]

import * as verify from "../lib/verify.js";

const args = process.argv.slice(2);
const opt = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? null : args[i + 1] || null;
};
const has = (flag) => args.includes(flag);

const opts = {
  home: opt("--home") || undefined,
  codexJs: opt("--codex-js") || undefined,
  timeoutMs: Number(opt("--timeout") || 30000),
};

if (has("--diff")) {
  const result = await verify.diff(opts);
  console.log(has("--json") ? JSON.stringify(result, null, 2) : verify.summarizeDiff(result));
  if (!result.ok) {
    console.log("\n抓包不完整：确认 codex 已安装，且本地端口没被拦。");
    process.exitCode = 1;
  }
} else {
  const result = await verify.verify(opts);
  console.log(has("--json") ? JSON.stringify(result, null, 2) : verify.summarizeVerify(result));
  if (!result.ok) {
    console.log("\n失败提示：确认本机已安装 @openai/codex（npm i -g @openai/codex），");
    console.log("并确认 codex exec 能在无 auth 情况下加载自定义 model_provider。");
    process.exitCode = 1;
  }
}
