// codex-purge — shim 层
//
// npm 全局 bin 下的 codex / codex.cmd / codex.ps1 是启动器。接管方式：
//   1) 原件改名为 <name>.codexpurge.bak
//   2) 写入同名 shim，固定前面注入全局参数（-p codex-purge + 引擎级放行）
//   3) --revert 时按 .bak 字节级还原
//
// 注入的参数可用环境变量 CODEX_PURGE_FLAGS 覆盖。

import fs from "node:fs";
import path from "node:path";
import * as fsutil from "./fsutil.js";

export const DEFAULT_FLAGS = ["-p", "codex-purge", "--dangerously-bypass-approvals-and-sandbox"];

export function resolveFlags(explicit) {
  if (Array.isArray(explicit) && explicit.length) return explicit;
  const fromEnv = process.env.CODEX_PURGE_FLAGS;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim().split(/\s+/);
  return DEFAULT_FLAGS;
}

/**
 * 备份文件名必须保留可执行扩展名：Windows 下 CALL 只认 .cmd/.bat。
 * codex.cmd -> codex.codexpurge.bak.cmd
 * codex.ps1 -> codex.codexpurge.bak.ps1
 * codex     -> codex.codexpurge.bak
 */
export function backupPathFor(file) {
  const ext = path.extname(file);
  if (!ext) return file + fsutil.BACKUP_SUFFIX;
  return file.slice(0, -ext.length) + fsutil.BACKUP_SUFFIX + ext;
}

export function isShimInstalled(file) {
  const text = fsutil.readTextOrNull(file);
  return !!text && text.includes("codex-purge shim");
}

export function shimContent(name, flags, targetName) {
  const flagLine = flags.join(" ");
  if (name.endsWith(".cmd")) {
    return [
      "@ECHO off",
      "REM codex-purge shim — original launcher preserved as " + targetName,
      "SETLOCAL",
      'SET "dp0=%~dp0"',
      `IF EXIST "%dp0%${targetName}" (`,
      `  CALL "%dp0%${targetName}" ${flagLine} %*`,
      ") ELSE (",
      `  ECHO codex-purge: missing ${targetName} 1>&2`,
      "  EXIT /b 127",
      ")",
      "ENDLOCAL",
      "",
    ].join("\r\n");
  }
  if (name.endsWith(".ps1")) {
    return [
      "#!/usr/bin/env pwsh",
      "# codex-purge shim — original launcher preserved as " + targetName,
      "$basedir = Split-Path $MyInvocation.MyCommand.Definition -Parent",
      `$target = Join-Path $basedir '${targetName}'`,
      "if (-not (Test-Path $target)) { Write-Error \"codex-purge: missing " + targetName + "\"; exit 127 }",
      `if ($MyInvocation.ExpectingInput) { $input | & $target ${flagLine} @args } else { & $target ${flagLine} @args }`,
      "exit $LASTEXITCODE",
      "",
    ].join("\n");
  }
  return [
    "#!/bin/sh",
    "# codex-purge shim — original launcher preserved as " + targetName,
    'basedir=$(dirname "$0")',
    `exec "$basedir/${targetName}" ${flagLine} "$@"`,
    "",
  ].join("\n");
}

/**
 * 安装 shim。
 * @returns {{name:string, file:string, backup:string|null, installed:boolean, skipped?:string}}
 */
export function install(dir, name, flags, backupRoot) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) {
    return { name, file, backup: null, installed: false, skipped: "启动器不存在" };
  }
  const backup = backupPathFor(file);
  const targetName = path.basename(backup);
  if (isShimInstalled(file)) {
    // 幂等：只更新参数
    fsutil.writeAtomic(file, shimContent(name, flags, targetName));
    return { name, file, backup, installed: true, updated: true };
  }
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  if (backupRoot) fsutil.snapshot(file, backupRoot);
  fsutil.writeAtomic(file, shimContent(name, flags, targetName));
  if (!name.endsWith(".cmd")) {
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      /* Windows 下忽略 */
    }
  }
  return { name, file, backup, installed: true };
}

export function revert(dir, name) {
  const file = path.join(dir, name);
  const backup = backupPathFor(file);
  if (!fs.existsSync(backup)) {
    return { name, file, restored: false, skipped: "没有备份" };
  }
  fs.copyFileSync(backup, file);
  try {
    if (!name.endsWith(".cmd")) fs.chmodSync(file, 0o755);
  } catch {
    /* ignore */
  }
  return { name, file, restored: true };
}