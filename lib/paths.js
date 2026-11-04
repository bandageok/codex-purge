// codex-purge — 路径与宿主探测
// 所有路径都跨平台；Windows 下统一输出正斜杠，避免 TOML 转义地狱。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PKG = "@openai/codex";

export function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** $CODEX_HOME 或 ~/.codex */
export function codexHome() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.resolve(home);
}

export function purgeDir(home = codexHome()) {
  return path.join(home, "codex-purge");
}
export function instructionsPath(home = codexHome()) {
  return path.join(purgeDir(home), "instructions.md");
}
export function backupDir(home = codexHome()) {
  return path.join(purgeDir(home), "backup");
}
export function profilePath(home = codexHome()) {
  return path.join(home, "codex-purge.config.toml");
}
export function configPath(home = codexHome()) {
  return path.join(home, "config.toml");
}
export function agentsPath(home = codexHome()) {
  return path.join(home, "AGENTS.md");
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function npmBinCandidates() {
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };
  if (process.platform === "win32") {
    push(process.env.APPDATA && path.join(process.env.APPDATA, "npm"));
    push(process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "npm"));
    push(path.join(os.homedir(), "AppData", "Roaming", "npm"));
  } else {
    push("/usr/local/bin");
    push("/opt/homebrew/bin");
    push("/usr/bin");
    push(path.join(os.homedir(), ".npm-global", "bin"));
    push(path.join(os.homedir(), ".local", "bin"));
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) push(dir);
  }
  return out;
}

function looksLikeNpmBin(dir) {
  if (!dir || !exists(dir)) return false;
  return (
    exists(path.join(dir, "node_modules", PKG, "bin", "codex.js")) ||
    exists(path.join(dir, "codex.cmd")) ||
    exists(path.join(dir, "codex"))
  );
}

/**
 * 定位 npm 全局 bin 目录（含 codex 启动器）。
 * @returns {{dir:string, codexJs:string|null, shims:string[], platformBin:string|null}|null}
 */
export function findNpmBin() {
  for (const dir of npmBinCandidates()) {
    if (!looksLikeNpmBin(dir)) continue;
    const codexJs = path.join(dir, "node_modules", PKG, "bin", "codex.js");
    const shims = [];
    for (const name of ["codex", "codex.cmd", "codex.ps1"]) {
      const p = path.join(dir, name);
      if (exists(p)) shims.push(name);
    }
    return {
      dir,
      codexJs: exists(codexJs) ? codexJs : null,
      shims,
      platformBin: process.platform === "win32" ? path.join(dir, "codex.exe") : path.join(dir, "codex"),
    };
  }
  return null;
}

/** 读取已安装 @openai/codex 的版本（读 package.json，不启动进程） */
export function codexVersion(bin = findNpmBin()) {
  if (!bin) return null;
  const pkgPath = path.join(bin.dir, "node_modules", PKG, "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version || null;
  } catch {
    return null;
  }
}

/** 从某个 codex 启动器/二进制路径向上找版本（测上游新版时用） */
export function versionFromPath(file) {
  if (!file) return null;
  let dir = path.dirname(path.resolve(file));
  for (let i = 0; i < 6; i++) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const meta = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (meta && meta.version && String(meta.name || "").includes("codex")) return meta.version;
    } catch {
      /* 继续向上 */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 当前平台需要接管的启动器文件名 */
export function shimNames() {
  return process.platform === "win32" ? ["codex.cmd", "codex.ps1"] : ["codex"];
}

/** 原生二进制相对路径候选（不同安装布局） */
export function nativeBinaryCandidates(bin = findNpmBin()) {
  if (!bin) return [];
  const vendor = path.join(
    bin.dir,
    "node_modules",
    PKG,
    "node_modules",
    "@openai",
    `codex-${process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`,
    "vendor",
  );
  const out = [];
  const walk = (dir, depth = 0) => {
    if (depth > 3 || !exists(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/^codex(\.exe)?$/.test(e.name)) out.push(p);
    }
  };
  walk(vendor);
  return out;
}