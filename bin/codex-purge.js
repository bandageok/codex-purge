#!/usr/bin/env node
// codex-purge CLI

import fs from "node:fs";
import path from "node:path";

import * as core from "../lib/core.js";
import * as prompt from "../lib/prompt.js";
import * as paths from "../lib/paths.js";
import * as verify from "../lib/verify.js";

const MODES = [
  "--status",
  "--apply",
  "--revert",
  "--uninstall",
  "--verify",
  "--edit",
  "--swap",
  "--prompts",
  "--help",
];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : process.argv[i + 1] || null;
}

function has(flag) {
  return process.argv.includes(flag);
}

function printHelp() {
  const presets = prompt.listPresets();
  console.log(`codex-purge 用法 / usage:

  codex-purge --status               显示状态（补丁逐条、profile、shim、生效来源）
  codex-purge --apply                应用全部清洗（提示词 + 引擎 + profile + AGENTS.md + shim）
  codex-purge --verify               端到端验证（本地抓包，看模型真正收到的输入）
  codex-purge --revert               回滚（shim 还原、受管块摘除、profile 与指令层删除）
  codex-purge --uninstall            回滚并删除 \$CODEX_HOME/codex-purge 目录
  codex-purge --edit                 编辑指令层后重新写入
  codex-purge --swap <preset>        切换提示词预设（见 --prompts）
  codex-purge --prompts              列出可用预设

选项:
  --preset <name>       apply 时使用预设
  --prompt-file <path>  apply 时用外部文件作为指令层
  --no-config-block     不写 config.toml 受管块（GUI 会话不生效）
  --no-agents           不写 AGENTS.md 受管块
  --no-shims            不接管启动器（直接运行 codex 不会带 -p codex-purge）
  --flags "<flags>"     shim 注入的参数（默认: -p codex-purge --dangerously-bypass-approvals-and-sandbox）
  --home <dir>          覆盖 CODEX_HOME
  --keep-instructions   revert 时保留指令层文件

预设 / presets: ${presets.length ? presets.join(", ") : "(无)"}
`);
}

async function main() {
  const mode = MODES.find((m) => process.argv.includes(m)) || "--status";
  const home = argValue("--home") || undefined;
  const opts = {
    home,
    preset: argValue("--preset") || undefined,
    promptFile: argValue("--prompt-file") || undefined,
    configBlock: !has("--no-config-block"),
    agentsMd: !has("--no-agents"),
    shims: !has("--no-shims"),
    keepInstructions: has("--keep-instructions"),
    flags: argValue("--flags") ? argValue("--flags").split(/\s+/) : undefined,
  };

  switch (mode) {
    case "--help":
      printHelp();
      return;

    case "--prompts": {
      const presets = prompt.listPresets();
      console.log(presets.length ? presets.join("\n") : "（无预设）");
      return;
    }

    case "--status": {
      const state = core.status({ home });
      console.log(core.summarize(state));
      return;
    }

    case "--apply": {
      const report = await core.apply(opts);
      console.log(`codex-purge apply — 提示词来源 ${report.prompt_source}`);
      for (const op of report.ops) {
        const id = String(op.id ?? 0).padStart(2);
        const action = op.action || (op.installed ? "shim" : "skip");
        const extra = op.chars ? ` (${op.chars} 字符)` : op.skipped ? ` — ${op.skipped}` : "";
        console.log(`  ${id} ${action.padEnd(7)} ${op.file || ""}${extra}`);
      }
      for (const w of report.warnings) console.log(`  ! ${w}`);
      console.log("");
      console.log(core.summarize(core.status({ home })));
      console.log("");
      console.log(`立即生效：codex -p ${core.PROFILE_NAME}（shim 已接管则直接 codex）`);
      console.log("验证：codex-purge --verify");
      return;
    }

    case "--revert": {
      const report = core.revert(opts);
      console.log("codex-purge revert");
      for (const op of report.ops) {
        const action = op.action || (op.restored ? "restore" : "skip");
        console.log(`  ${String(op.id ?? 0).padStart(2)} ${action.padEnd(7)} ${op.file || ""}${op.skipped ? ` — ${op.skipped}` : ""}`);
      }
      if (!report.ops.length) console.log("  没有可回滚的内容");
      return;
    }

    case "--uninstall": {
      const report = core.uninstall(opts);
      console.log("codex-purge uninstall");
      for (const op of report.ops) {
        const action = op.action || (op.restored ? "restore" : "skip");
        console.log(`  ${String(op.id ?? 0).padStart(2)} ${action.padEnd(7)} ${op.file || ""}${op.skipped ? ` — ${op.skipped}` : ""}`);
      }
      return;
    }

    case "--verify": {
      const result = await verify.verify({ home, timeoutMs: Number(argValue("--timeout") || 30000) });
      console.log(verify.summarizeVerify(result));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    case "--edit": {
      const file = paths.instructionsPath(home || paths.codexHome());
      console.log(`编辑指令层：${file}`);
      console.log("改完执行 codex-purge --apply 重新写入（会同步 AGENTS.md 与 profile 路径）。");
      console.log("当前内容前 40 行：");
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : prompt.defaultPrompt();
      console.log(text.split("\n").slice(0, 40).join("\n"));
      return;
    }

    case "--swap": {
      const preset = argValue("--swap");
      if (!preset) {
        console.error(`缺少预设名。可用：${prompt.listPresets().join(", ")}`);
        process.exitCode = 2;
        return;
      }
      const report = await core.apply({ ...opts, preset });
      console.log(`已切换预设 ${preset}（来源 ${report.prompt_source}）`);
      console.log(core.summarize(core.status({ home })));
      return;
    }

    default:
      printHelp();
  }
}

main().catch((e) => {
  console.error(`codex-purge 失败：${e && e.message ? e.message : e}`);
  if (e && e.stack) console.error(e.stack);
  process.exitCode = 1;
});