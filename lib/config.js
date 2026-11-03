// codex-purge — TOML 配置层
//
// 两种写入方式，互不冲突：
//   1) profile 文件 $CODEX_HOME/codex-purge.config.toml —— 由 `codex -p codex-purge` 叠加，
//      不碰用户 config.toml，默认方式。
//   2) 受管块（managed block）—— 插进 $CODEX_HOME/config.toml，供 GUI / app-server 会话使用。
//
// TOML 关键约束：裸键只能出现在第一个表头之前，否则会被并进上一张表。
// 所以受管块必须插在首个 [table] 之前，退出时整块摘除，原文字节级还原。

import * as fsutil from "./fsutil.js";

export const BLOCK_BEGIN = "# >>> codex-purge managed block (auto-generated; `codex-purge --revert` removes it) >>>";
export const BLOCK_END = "# <<< codex-purge managed block <<<";

const HEADER_RE = /^\s*\[/;

/** 把值渲染成 TOML 字面量 */
export function tomlValue(v) {
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "0";
  if (typeof v === "object" && v !== null) return JSON.stringify(v);
  const s = String(v);
  if (s.includes("'") || s.includes("\n")) {
    // 多行基础串：转义反斜杠与双引号
    return `"""${s.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"')}"""`;
  }
  return `'${s}'`;
}

export function renderKeys(keys) {
  return Object.entries(keys)
    .map(([k, v]) => `${k} = ${tomlValue(v)}`)
    .join("\n");
}

/**
 * 解析顶层键值（不处理表内部）。
 * 支持多行（""" / ''' ）字符串，足够覆盖我们自己写的键。
 * @returns {Record<string, unknown>}
 */
export function readTopLevelKeys(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (HEADER_RE.test(line)) break;
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let raw = m[2].trim();
    const open = raw.startsWith('"""') ? '"""' : raw.startsWith("'''") ? "'''" : null;
    if (open) {
      const rest0 = raw.slice(3);
      if (rest0.includes(open)) {
        // 单行三引号："""abc"""
        raw = open + rest0.slice(0, rest0.indexOf(open)) + open;
      } else {
        const collected = [rest0];
        while (++i < lines.length) {
          const l = lines[i];
          const end = l.indexOf(open);
          if (end !== -1) {
            collected.push(l.slice(0, end));
            break;
          }
          collected.push(l);
        }
        raw = open + collected.join("\n") + open;
      }
    }
    out[key] = parseTomlValue(raw);
  }
  return out;
}

/** 把单个 TOML 值解析成 JS 值（够用即可，非法输入原样返回） */
export function parseTomlValue(raw) {
  const s = String(raw ?? "").trim();
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  if (s.startsWith('"""') && s.endsWith('"""')) {
    return s
      .slice(3, -3)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\");
  }
  if (s.startsWith("'''") && s.endsWith("'''")) return s.slice(3, -3);
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1);
  if (s.startsWith('"') && s.endsWith('"')) {
    return s
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
  }
  return s;
}

/** 在顶层 upsert 若干键，保留其余行原样 */
export function upsertTopLevel(text, keys) {
  const src = String(text ?? "");
  const lines = src.length ? src.split(/\r?\n/) : [];
  let headerIdx = lines.findIndex((l) => HEADER_RE.test(l));
  if (headerIdx === -1) headerIdx = lines.length;

  const head = lines.slice(0, headerIdx);
  const tail = lines.slice(headerIdx);
  const pending = new Map(Object.entries(keys));

  const outHead = head.map((line) => {
    const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
    if (m && pending.has(m[1])) {
      const val = pending.get(m[1]);
      pending.delete(m[1]);
      return `${m[1]} = ${tomlValue(val)}`;
    }
    return line;
  });

  const added = [...pending.entries()].map(([k, v]) => `${k} = ${tomlValue(v)}`);
  let result = [...outHead, ...added, ...tail].join("\n");
  if (tail.length && !result.endsWith("\n")) result += "\n";
  return result;
}

/** 删除顶层键 */
export function removeTopLevel(text, keyNames) {
  const lines = String(text ?? "").split(/\r?\n/);
  const idx = lines.findIndex((l) => HEADER_RE.test(l));
  const stop = idx === -1 ? lines.length : idx;
  const keep = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i < stop) {
      const m = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
      if (m && keyNames.includes(m[1])) continue;
    }
    keep.push(line);
  }
  return keep.join("\n");
}

export function hasManagedBlock(text) {
  return String(text || "").includes(BLOCK_BEGIN);
}

/** 插入受管块（放在首个表头之前），已存在则整块替换 */
export function insertManagedBlock(text, keys) {
  const src = String(text ?? "");
  const block = [BLOCK_BEGIN, renderKeys(keys), BLOCK_END].join("\n");
  if (hasManagedBlock(src)) {
    const re = new RegExp(`${escapeRe(BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(BLOCK_END)}`);
    return src.replace(re, block);
  }
  const lines = src.split(/\r?\n/);
  let idx = lines.findIndex((l) => HEADER_RE.test(l));
  if (idx === -1) idx = lines.length;
  const head = lines.slice(0, idx);
  const tail = lines.slice(idx);
  while (head.length && head[head.length - 1].trim() === "") head.pop();
  const merged = [...head, "", block, "", ...tail].join("\n");
  return merged.endsWith("\n") ? merged : merged + "\n";
}

export function removeManagedBlock(text) {
  const src = String(text ?? "");
  const re = new RegExp(`\\n?${escapeRe(BLOCK_BEGIN)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n?`, "g");
  return src.replace(re, "\n");
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** profile 文件整体重写（这个文件归我们所有） */
export function writeProfile(file, keys, header = []) {
  const body = [...header, "", renderKeys(keys), ""].join("\n");
  fsutil.writeAtomic(file, body);
}

export function readProfileKeys(file) {
  const text = fsutil.readTextOrNull(file);
  if (text == null) return null;
  return readTopLevelKeys(text);
}