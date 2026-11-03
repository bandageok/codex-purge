// codex-purge — AGENTS.md 指令块

import * as fsutil from "./fsutil.js";
import { BLOCK_BEGIN as _ignored, BLOCK_END as _ignored2 } from "./config.js";

export const AGENTS_BEGIN = "<!-- codex-purge:agents:start -->";
export const AGENTS_END = "<!-- codex-purge:agents:end -->";

export function hasBlock(text) {
  return String(text || "").includes(AGENTS_BEGIN);
}

export function injectBlock(existing, block) {
  const src = String(existing ?? "");
  const wrapped = wrap(block);
  if (hasBlock(src)) {
    const re = new RegExp(`${escapeRe(AGENTS_BEGIN)}[\\s\\S]*?${escapeRe(AGENTS_END)}`);
    return src.replace(re, wrapped);
  }
  if (!src.trim()) return wrapped + "\n";
  return src.replace(/\s*$/, "\n\n") + wrapped + "\n";
}

export function removeBlock(existing) {
  const src = String(existing ?? "");
  const re = new RegExp(`\\n*${escapeRe(AGENTS_BEGIN)}[\\s\\S]*?${escapeRe(AGENTS_END)}\\n?`, "g");
  return src.replace(re, "\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

export function wrap(block) {
  const inner = String(block || "").trim();
  // block 可能已带标记（prompt.agentsBlockText 自带），避免重复包裹
  if (inner.startsWith(AGENTS_BEGIN)) return inner;
  return [AGENTS_BEGIN, inner, AGENTS_END].join("\n");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function countBlocks(text) {
  const m = String(text || "").match(new RegExp(escapeRe(AGENTS_BEGIN), "g"));
  return m ? m.length : 0;
}

export function applyTo(file, block, backupRoot) {
  const before = fsutil.readTextOrNull(file);
  const next = injectBlock(before ?? "", block);
  // 已经带着我们的块 → 说明原件备份（若有）早已做好，别把自家产物当原件备份
  if (before != null && hasBlock(before)) {
    fsutil.writeAtomic(file, next);
    return { file, existed: true, before_sha: fsutil.sha256(before), after_sha: fsutil.sha256(next), backup: null, snapshot: null, updated: true };
  }
  return fsutil.writeGuarded(file, next, backupRoot);
}

export function revertFrom(file, backupRoot) {
  const before = fsutil.readTextOrNull(file);
  if (before == null) return null;
  const next = removeBlock(before);
  if (next.trim() === "") {
    // 原本没有 AGENTS.md → 直接删掉我们创建的文件
    return fsutil.writeGuarded(file, next, backupRoot);
  }
  return fsutil.writeGuarded(file, next, backupRoot);
}

/** 仅清理受管块：等价于 revertFrom，但保留空文件（供 --keep-empty 使用） */
export function stripOnly(file) {
  const before = fsutil.readTextOrNull(file);
  if (before == null) return null;
  const next = removeBlock(before);
  fsutil.writeAtomic(file, next);
  return next;
}

export const _internal = { _ignored, _ignored2 };