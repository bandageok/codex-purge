# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [SemVer](https://semver.org/lang/zh-CN/)。
「支持矩阵」里列的版本都跑过 `selftest` + 端到端 `verify`。

## 支持矩阵

| codex 版本 | 验证方式 | 结果 |
| --- | --- | --- |
| `0.163.0` | 本机抓包 + `compat-scan` | 14/14 补丁依赖命中 |
| `0.166.0` | 隔离安装 + `verify --codex-js` + `diff` | 6/6 断言通过，14/14 探针命中 |

## [Unreleased]

## [0.1.2] — 2026-11-04

### Fixed

- **npm 全局安装布局识别**。`findNpmBin()` 原来只认 Windows 的 `<APPDATA>/npm/node_modules`；在 Linux/macOS 的全局安装（`/usr/local/bin` + `/usr/local/lib/node_modules`）下会返回 `pkg_root: null`，导致 `compat-scan` 在 CI 上直接 `未找到 codex 原生二进制`、release 流水线失败。现在用 `npm prefix -g` + 布局合并（bin 与包分处两地也能拼起来），并支持 `CODEX_PURGE_NPM_PREFIX` 显式指定前缀。
- 原生二进制探测不再写死平台包名（`codex-linux-x64` 之类），改为扫描 `@openai/codex-*` 下的 `vendor/**`，跨平台/交叉安装都能找到。

### Added

- 自检新增两例：`*nix` 全局布局识别、`versionFromPath` 解析 → 18/18。

## [0.1.1] — 2026-11-04

### Added

- `--diff`：同一 prompt、同一台机器，逐条列出「未清洗 vs 已清洗」的 `input` 数组差异（角色、字符数、首段文本、delta）。
- `--json`：`--status` / `--verify` / `--diff` 三处统一支持机器可读输出，便于接 CI 或别的脚本。
- `--codex-js <path>`：`--verify` / `--diff` 可以指定另一份 codex 启动器，用来在不覆盖本机安装的前提下验证上游新版。
- `scripts/compat-scan.mjs`：兼容性探针。把 14 条补丁依赖的配置键 / 枚举 / 参数 / 提示词标记在原生二进制里逐个定位；缺哪个，就知道哪条补丁会退化成 pending。
- `.github/workflows/release.yml`：打 tag 自动跑 selftest 并生成 GitHub Release。
- `MAINTENANCE.md`、`CONTRIBUTING.md`、issue/PR 模板、dependabot。

### Fixed

- 探针把 clap 参数名写成带前导 `--` 的形式，导致 `dangerously-bypass-approvals-and-sandbox` 在 0.166.0 上被误报缺失。现在两种写法都试。
- `verify` 报告里的 codex 版本原先取「本机全局安装的那个」，用 `--codex-js` 测新版时会显示错版本；改为从被测启动器路径向上解析 `package.json`。
- `compat-scan` 的版本号去掉平台后缀（`0.166.0-win32-x64` → `0.166.0`）。

## [0.1.0] — 2026-11-03

### Added

- 四层破甲：提示词（`model_instructions_file` / `developer_instructions`）、引擎（`approval_policy` / `sandbox_mode` / `include_*_instructions`）、配置（`-p` profile + `config.toml` 受管块）、shim（`codex.cmd` / `codex.ps1` / `codex`）。
- 14 条补丁与状态机：`applied` / `pending` / `n/a`，逐条给出判定依据。
- `--status` / `--apply` / `--verify` / `--revert` / `--uninstall` / `--edit` / `--swap` / `--prompts`。
- 字节级回滚：`<file>.codexpurge.bak` + 时间戳快照；二次 apply 不污染备份。
- 预设：`strict` / `soft` / `ctf` / `research`。
- `scripts/selftest.mjs`（15 项，无需 codex）与 `scripts/verify.mjs`（本地抓包，不联网）。
- CI：9 个矩阵 job + 一个真实安装 codex 的 e2e job。