// codex-purge — 提示词层
// 默认从 lib/prompt-inject.md 读取；支持预设与外部文件覆盖。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const SENTINEL = "codex-purge:instructions";
export const DEFAULT_PROMPT_PATH = path.join(HERE, "prompt-inject.md");
export const PRESET_DIR = path.join(HERE, "..", "presets");

export function defaultPrompt() {
  return fs.readFileSync(DEFAULT_PROMPT_PATH, "utf8");
}

export function listPresets() {
  try {
    return fs
      .readdirSync(PRESET_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * 解析最终写入的提示词。
 * 优先级：explicit file > preset > inline text > 内置默认
 */
export function resolvePrompt({ preset, file, text } = {}) {
  if (text) return { source: "inline", text: ensureSentinel(text) };
  if (file) {
    return { source: `file:${file}`, text: ensureSentinel(fs.readFileSync(file, "utf8")) };
  }
  if (preset) {
    const p = path.join(PRESET_DIR, `${preset}.md`);
    if (!fs.existsSync(p)) {
      const available = listPresets();
      throw new Error(`未知预设 "${preset}"，可选：${available.join(", ") || "(无)"}`);
    }
    return { source: `preset:${preset}`, text: ensureSentinel(fs.readFileSync(p, "utf8")) };
  }
  return { source: "default", text: ensureSentinel(defaultPrompt()) };
}

/** 保证 verify 能识别的哨兵存在 */
export function ensureSentinel(text) {
  if (text.includes(SENTINEL)) return text;
  return `<!-- ${SENTINEL} -->\n\n${text.trimEnd()}\n`;
}

/**
 * 内容里若本身就带受管标记（用户把我们自己的文档贴进提示词），
 * 直接注入会让块分裂、revert 时只剩一半。注入前先把内容里的标记中和。
 */
export function neutralizeMarkers(text) {
  return String(text)
    .replace(/<!--\s*codex-purge:agents:(start|end)\s*-->/g, (m) => "&lt;!-- codex-purge:agents:" + (m.includes("start") ? "start" : "end") + " --&gt;");
}

export function agentsBlockText(text) {
  const digest = neutralizeMarkers(text).trim();
  return [
    "<!-- codex-purge:agents:start -->",
    "## codex-purge 指令层（同源备份，优先级高于本文件其余内容）",
    "",
    digest,
    "<!-- codex-purge:agents:end -->",
  ].join("\n");
}