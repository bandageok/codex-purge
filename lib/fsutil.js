// codex-purge — 文件读写与备份
// 原则：改写前一定有字节级备份；revert 后必须与原文完全一致。

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function readBufferOrNull(file) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function sha256(buf) {
  if (buf == null) return null;
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), "utf8");
  return crypto.createHash("sha256").update(b).digest("hex");
}

export function writeAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.codexpurge.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function removeIfExists(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}

export const BACKUP_SUFFIX = ".codexpurge.bak";

/** 就地备份：<file>.codexpurge.bak（只在首次改写时写，保留最初原件） */
export function backupInPlace(file) {
  if (readBufferOrNull(file) == null) return null;
  const bak = file + BACKUP_SUFFIX;
  if (readBufferOrNull(bak) == null) {
    fs.copyFileSync(file, bak);
  }
  return bak;
}

/** 时间戳快照，便于事后比对 */
export function snapshot(file, backupRoot) {
  const buf = readBufferOrNull(file);
  if (buf == null) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const rel = path.basename(file);
  const dest = path.join(backupRoot, stamp, rel);
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, buf);
  return dest;
}

export function restoreInPlace(file) {
  const bak = file + BACKUP_SUFFIX;
  const buf = readBufferOrNull(bak);
  if (buf == null) return false;
  writeAtomic(file, buf);
  // 保留 .bak：用户可能还想再看一眼原件
  return true;
}

export function hasBackup(file) {
  return readBufferOrNull(file + BACKUP_SUFFIX) != null;
}

/** 统一的「安全改写」：备份 → 快照 → 原子写 */
export function writeGuarded(file, content, backupRoot) {
  const before = readBufferOrNull(file);
  const backedUp = backupInPlace(file);
  const snap = backupRoot ? snapshot(file, backupRoot) : null;
  writeAtomic(file, content);
  return {
    file,
    existed: before != null,
    before_sha: sha256(before),
    after_sha: sha256(content),
    backup: backedUp,
    snapshot: snap,
  };
}