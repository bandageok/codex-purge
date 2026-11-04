# 参与开发

## 环境

- Node ≥ 18（CI 覆盖 18 / 20 / 22）
- 本地装了 `@openai/codex` 才能跑端到端验证；只改纯逻辑的话不需要

## 三条命令

```bash
node scripts/selftest.mjs          # 18 项，秒级，不联网
node bin/codex-purge.js --verify   # 端到端抓包（需要 codex）
node scripts/compat-scan.mjs       # 上游依赖探针
```

## 改动前先读

- `MAINTENANCE.md`：上游升级流程与回归清单
- `lib/core.js` 顶部注释：四层模型与补丁表约定

## 约定

1. **补丁要么可判定，要么不叫补丁。** 新加一条补丁，必须同时给 `status()` 一个明确的判定依据（文件存在 / 键值相等 / 标记块存在）。不要用「看起来像」。
2. **写盘必须走 `fsutil.writeGuarded`。** 备份、快照、原子写三件事它都做了；绕过它等于放弃回滚契约。
3. **测试只用临时 `CODEX_HOME`。** 任何测试都不许碰真实的 `~/.codex`。
4. **受管标记不许改名。** `codex-purge:*`、`<!-- codex-purge:agents:start -->`、`# >>> codex-purge managed block` 是状态机与回滚的锚点。
5. **验证优于解释。** 提 PR 时贴 `--status` 与 `--verify` 的真实输出，不要只写"已测试"。

## 提 PR

- 一个 PR 一件事；重构和功能分开。
- 更新 `CHANGELOG.md` 的 `[Unreleased]`。
- 涉及上游行为的改动，附 `compat-scan` 输出。
- CI 绿了再请求 review。

## 提交信息

`type: 一句话`，type 用 `feat` / `fix` / `docs` / `test` / `chore` / `release`。

```
fix: shim 备份名保留可执行扩展名（Windows CALL 只认 .cmd/.bat）
feat: --diff 输出未清洗/已清洗的 input 逐条对照
```