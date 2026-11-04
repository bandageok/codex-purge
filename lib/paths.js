// codex-purge — 路径与宿主探测
// 所有路径都跨平台；Windows 下统一输出正斜杠，避免 TOML 转义地狱。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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
  // npm 全局前缀：Linux/macOS 的包在 lib/node_modules，bin 在 bin/
  push("/usr/local/lib");
  push("/usr/lib");
  push("/opt/homebrew/lib");
  push(path.join(os.homedir(), ".npm-global", "lib"));
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) push(dir);
  }
  return out;
}

/** `npm prefix -g` 的结果（拿不到就返回 null；可用 CODEX_PURGE_NO_NPM_CLI=1 跳过） */
export function npmGlobalPrefix() {
  if (process.env.CODEX_PURGE_NO_NPM_CLI === "1") return null;
  try {
    const out = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["prefix", "-g"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    const p = String(out)
      .trim()
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .pop();
    return p && exists(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * 一个候选目录可能是三种布局之一：
 *   A) Windows npm：  <dir>/node_modules/@openai/codex
 *   B) *nix 全局 bin：<dir>/node_modules/@openai/codex （npm prefix -g /usr/local/bin 的情形）
 *   C) *nix 全局 lib：<dir>/node_modules/@openai/codex，bin 在 <dir>/bin
 * 也可能是「只有启动器、包在别处」的符号链接布局。
 */
function resolveLayout(dir) {
  if (!dir || !exists(dir)) return null;
  const pkgRoot = path.join(dir, "node_modules", PKG);
  const codexJs = path.join(pkgRoot, "bin", "codex.js");
  const hasPkg = exists(codexJs);
  const shims = ["codex", "codex.cmd", "codex.ps1"].filter((n) => exists(path.join(dir, n)));
  if (!hasPkg && !shims.length) return null;
  return { dir, pkgRoot: hasPkg ? pkgRoot : null, codexJs: hasPkg ? codexJs : null, shims };
}

/** 候选目录：环境变量前缀 → npm prefix -g → 平台默认 */
export function candidateDirs() {
  const out = [];
  const pushPrefix = (prefix) => {
    if (!prefix) return;
    for (const d of [path.join(prefix, "bin"), prefix, path.join(prefix, "lib")]) {
      if (!out.includes(d)) out.push(d);
    }
  };
  pushPrefix(process.env.CODEX_PURGE_NPM_PREFIX);
  pushPrefix(npmGlobalPrefix());
  for (const d of npmBinCandidates()) if (!out.includes(d)) out.push(d);
  return out;
}

/** 所有可解析的 npm/codex 布局（测试与多安装场景用） */
export function listNpmLayouts() {
  const layouts = [];
  const seen = new Set();
  for (const dir of candidateDirs()) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const layout = resolveLayout(dir);
    if (!layout) continue;
    layouts.push({
      dir: layout.dir,
      pkg_root: layout.pkgRoot,
      codexJs: layout.codexJs,
      shims: layout.shims,
      platformBin: process.platform === "win32" ? path.join(layout.dir, "codex.exe") : path.join(layout.dir, "codex"),
    });
  }
  return layouts;
}

/**
 * 定位 npm 全局安装。
 * bin 与包可能分处两地（*nix: /usr/local/bin 与 /usr/local/lib/node_modules），
 * 所以这里做合并：包布局优先提供 codexJs / pkg_root，bin 布局提供 shim 文件名。
 */
export function findNpmBin() {
  const layouts = listNpmLayouts();
  if (!layouts.length) return null;
  const withPkg = layouts.find((l) => l.pkg_root) || layouts[0];
  const withShims = layouts.find((l) => l.shims.length) || withPkg;
  return {
    dir: withShims.dir,
    pkg_root: withPkg.pkg_root,
    codexJs: withPkg.codexJs,
    shims: withShims.shims,
    platformBin: withShims.platformBin,
  };
}

/** 读取已安装 @openai/codex 的版本（读 package.json，不启动进程） */
export function codexVersion(bin = findNpmBin()) {
  if (!bin) return null;
  const root = bin.pkg_root || path.join(bin.dir, "node_modules", PKG);
  const pkgPath = path.join(root, "package.json");
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

/** 原生二进制相对路径候选（不同安装布局、不同平台包名都试） */
export function nativeBinaryCandidates(bin = findNpmBin()) {
  if (!bin || !bin.pkg_root) return [];
  const out = [];
  const isCodexBin = (name) => /^codex(\.exe)?$/.test(name);

  // 1) 平台包目录：@openai/codex-<platform>-<arch>/vendor/**/bin/codex(.exe)
  const scoped = path.join(bin.pkg_root, "node_modules", "@openai");
  const platformDirs = [];
  try {
    for (const e of fs.readdirSync(scoped, { withFileTypes: true })) {
      if (e.isDirectory() && e.name.startsWith("codex-")) platformDirs.push(path.join(scoped, e.name));
    }
  } catch {
    /* 没有平台包目录 */
  }
  // 2) 兜底：按当前平台构造包名（老布局）
  if (!platformDirs.length) {
    const name = `codex-${process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux"}-${process.arch === "arm64" ? "arm64" : "x64"}`;
    platformDirs.push(path.join(scoped, name));
  }

  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (isCodexBin(e.name)) out.push(p);
    }
  };
  for (const d of platformDirs) walk(path.join(d, "vendor"));
  return out;
}

