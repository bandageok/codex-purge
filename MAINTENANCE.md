# 维护手册

给未来的自己（也给 fork 的人）：上游一动，按这个顺序走，十分钟内能判断「还能不能用、哪里会退化」。

## 一、上游发新版了

```bash
npm view @openai/codex version          # 看最新版
npm i @openai/codex@<version> --prefix /tmp/cx<version>   # 隔离安装，别碰全局
```

> 注意：如果当前目录有 `package.json`，`npm i --prefix` 仍可能装到工程根目录的 `node_modules`。装完用 `find <dir> -name codex.exe` 确认真实位置。

**第一步：兼容性探针**（秒级，不启动 codex）

```bash
node scripts/compat-scan.mjs --binary <指向新版的 codex.exe / codex>
```

- 全部命中 → 继续第二步。
- 有缺失 → 看它标出的补丁号。缺 `model_instructions_file` 就是 #2 退化；缺 `dangerously-bypass-approvals-and-sandbox` 就是 shim 的默认参数要换。**先改探针的键名，再改代码**，别反过来。

**第二步：端到端验证**（真实 codex，本地抓包）

```bash
node bin/codex-purge.js --verify --codex-js <新版>/bin/codex.js
node bin/codex-purge.js --diff   --codex-js <新版>/bin/codex.js
```

六条断言全绿，且 `--diff` 里 `input[0]` 的字符数从五位数掉到四位数，就算适配完成。

**第三步：更新记录**

- `CHANGELOG.md` 的支持矩阵加一行；
- 如果键名/行为有变，写进 `[Unreleased] → Changed`，并说明哪条补丁受影响。

## 二、上游改了行为（不是改名）

判断方法：探针全中但 `verify` 失败 → 行为变了。常见三类：

| 症状 | 可能原因 | 处理 |
| --- | --- | --- |
| `instructions` 哨兵没命中 | `model_instructions_file` 不再替换、而是追加 | 改用 `developer_instructions` + `AGENTS.md` 双通道，并在 README 的支持矩阵降级说明 |
| 基础指令标记仍在 | 上游改了提示词开头（探针里的 `prompt` 项要同步改） | 更新 `BASE_PROMPT_MARKERS`，再跑 verify |
| `danger-full-access` 不在请求里 | 沙箱策略字段改名 | 探针加新键，`purgeKeys()` 同步 |

## 三、发版

```bash
# 1. 改 package.json 的 version（SemVer：破坏性变更升 minor，其余 patch）
# 2. CHANGELOG 把 [Unreleased] 落成具体版本号 + 日期
node scripts/selftest.mjs
node bin/codex-purge.js --verify
git add -A && git commit -m "release: codex-purge <version>"
git tag -a v<version> -m "codex-purge <version>"
git push origin main --tags        # tag 会触发 release.yml
```

## 四、回归清单（每次发版前）

- [ ] `node scripts/selftest.mjs` → 15/15
- [ ] `node bin/codex-purge.js --verify` → 6/6
- [ ] `node scripts/compat-scan.mjs` → 全部命中
- [ ] `--diff` 的 `input[0]` 明显变小
- [ ] 本机 `codex.cmd` / `codex.ps1` 的 `md5sum` 在 `--revert` 后与原件一致
- [ ] CI 绿（9 矩阵 + e2e）

## 五、别做的事

- 不要为了让新的 `verify` 通过而放宽断言（例如把「基础指令消失」改成「基础指令变短」）。断言是产品承诺。
- 不要在探针里用「大概像」的键名。要么精确命中，要么显式标 `optional: true`。
- 不要把 `.codexpurge.bak` 提交进仓库，也不要在测试里指向真实的 `~/.codex`。所有测试都用临时 `CODEX_HOME`。