# codex-purge

**给 OpenAI Codex CLI 的破甲/去道德层：整份替换基础指令 + 拆掉审批与沙箱门禁 + 启动器固定注入。**

不改 341MB 的原生二进制，全部走 Codex 官方支持的配置面：`model_instructions_file`、`developer_instructions`、`approval_policy`、`sandbox_mode`、`include_*_instructions`、`-p <profile>`。可验证、可回滚、字节级还原。

```
codex-purge --apply     # 四层一次装好
codex-purge --verify    # 本地抓包，看模型真正收到的输入
codex-purge --revert    # 全部还原
```

---

## 一、为什么这样做（设计取舍）

Codex CLI 的原生提示词是 `codex.exe`/`codex` 二进制里的一段常量（本机 0.163.0 实测，`You are Codex` 在 .rdata 内有 12 处命中，主指令块 ~40KB，以字面 `\n` 形式存放）。硬改二进制要处理长度表、fat pointer 与签名，改一次崩一次。

而 Codex 本身就提供了「用文件替换基础指令」的开关：

| 你说的意图 | Codex 给的开关 | 实测效果 |
| --- | --- | --- |
| 换掉整个 system 指令 | `model_instructions_file` | 基础指令**整份消失**，我们的文件成为模型收到的第一条 developer 内容 |
| 追加一层最高优先级规则 | `developer_instructions` | 落在 skills/permissions 之前的 developer 位 |
| 不要审批 | `approval_policy = "never"` | 不再请求执行确认 |
| 全盘读写 | `sandbox_mode = "danger-full-access"` | 沙箱策略放开 |
| 别再念沙箱/协同说明 | `include_permissions_instructions = false`、`include_collaboration_mode_instructions = false`、`include_apps_instructions = false` | 对应说明块从输入里消失 |
| 每次启动自动带上 | `-p <profile>` + 启动器 shim | 直接敲 `codex` 就是洗过的状态 |

所以 codex-purge 只做「把官方开关拧到底」这件事，并把每一步写成可回滚的补丁。

---

## 二、实测证据

本机 `@openai/codex` 0.163.0，`node scripts/verify.mjs`（本地 capture-only Responses 端点 + 真实 `codex exec`）：

```
codex-purge 验证 / verify — 通过
  CODEX_HOME 副本 C:\Users\...\Temp\codex-purge-verify-rIzyyz
  codex 版本    0.163.0
  抓包字节      25940
  ✓ 请求已捕获 — 200 字节起
  ✓ 指令层进入首条 developer — 哨兵命中
  ✓ 内置基础指令已消失 — 已替换基础指令
  ✓ developer 层注入生效 — developer 位命中
  ✓ danger-full-access 生效 — 沙箱模式已放开
  ✓ 沙箱说明块已摘除 — 沙箱说明块状态
  首条输入      <!-- codex-purge:instructions --> # 执行层指令 你是一名任务执行体…
```

抓到的请求里 `input[0]` 就是我们的指令层，`You are Codex` 与 `Filesystem sandboxing defines` 均已不在。

---

## 三、安装

```bash
git clone https://github.com/bandageok/codex-purge.git
cd codex-purge
node bin/codex-purge.js --status
node bin/codex-purge.js --apply
```

也可以直接 `npm i -g .` 后用 `codex-purge` 命令。

前置：需要本机已安装 Codex CLI（`npm i -g @openai/codex`），Node ≥ 18。

---

## 四、命令

| 命令 | 作用 |
| --- | --- |
| `--status` | 逐条补丁状态、profile、路径、备份、生效来源 |
| `--apply` | 应用四层清洗（提示词 / 引擎 / profile / AGENTS.md / shim） |
| `--verify` | 端到端抓包验证（不联网、不耗额度） |
| `--revert` | 回滚：shim 按备份还原、受管块摘除、profile 与指令层删除 |
| `--uninstall` | 回滚并删除 `$CODEX_HOME/codex-purge` |
| `--edit` | 查看当前指令层前 40 行 |
| `--swap <preset>` | 切换指令层预设（`strict` / `soft` / `ctf` / `research`） |
| `--prompts` | 列出预设 |

选项：

```
--preset <name>        apply 时用预设
--prompt-file <path>   用外部 md 作为指令层
--no-config-block      不写 config.toml 受管块（GUI 会话不生效）
--no-agents            不写 AGENTS.md 受管块
--no-shims             不接管启动器（需自己 codex -p codex-purge）
--flags "<args>"       shim 注入参数，默认 "-p codex-purge --dangerously-bypass-approvals-and-sandbox"
--home <dir>           覆盖 CODEX_HOME（测试用）
--keep-instructions    revert 时保留指令层
```

---

## 五、补丁表（14 条）

| # | 补丁 | 层 | 做什么 |
| --- | --- | --- | --- |
| 1 | INSTRUCTIONS_FILE | 提示词 | 写 `$CODEX_HOME/codex-purge/instructions.md` |
| 2 | MODEL_INSTRUCTIONS_FILE | 提示词 | `model_instructions_file` 指向它 → 顶掉内置基础指令 |
| 3 | DEVELOPER_INSTRUCTIONS | 提示词 | `developer_instructions` 前置注入 |
| 4 | APPROVAL_POLICY_NEVER | 引擎 | `approval_policy = "never"` |
| 5 | SANDBOX_DANGER_FULL_ACCESS | 引擎 | `sandbox_mode = "danger-full-access"` |
| 6 | PERMISSIONS_INSTRUCTIONS_OFF | 引擎 | 摘掉沙箱说明块 |
| 7 | APPS_INSTRUCTIONS_OFF | 引擎 | 摘掉应用说明块 |
| 8 | COLLABORATION_MODE_OFF | 引擎 | 摘掉协同模式块 |
| 9 | PROFILE_FILE | 配置 | `codex-purge.config.toml`，由 `-p codex-purge` 叠加，不碰用户 config |
| 10 | CONFIG_MANAGED_BLOCK | 配置 | `config.toml` 受管块（插在首个表头之前，TOML 裸键规则）→ GUI/app-server 生效 |
| 11 | AGENTS_MD_BLOCK | 指令文件 | `AGENTS.md` 受管块，指令层的同源备份 |
| 12 | SHIM_CMD | shim | `codex.cmd` 接管 |
| 13 | SHIM_PS1 | shim | `codex.ps1` 接管 |
| 14 | SHIM_POSIX | shim | `codex`（sh）接管 |

只用 profile 就够用时，`--no-config-block` 可以完全不碰用户的 `config.toml`。

---

## 六、回滚

```bash
codex-purge --revert      # 还原 shim、摘除受管块、删除 profile 与指令层
codex-purge --uninstall   # 再删掉 $CODEX_HOME/codex-purge
```

- `config.toml`、`AGENTS.md`、启动器：改写前存 `<file>.codexpurge.bak`，回滚后**字节级一致**（selftest 里有断言，实机 `md5sum` 复核过）。
- 每次改写还会在 `$CODEX_HOME/codex-purge/backup/<时间戳>/` 留快照。
- 二次 apply 不会污染备份：已经带我们标记的文件不再被当成「原件」备份（有脏备份回归用例）。

---

## 七、目录

```
bin/codex-purge.js     CLI
lib/core.js            补丁表 + apply/revert/status
lib/prompt.js          指令层解析（默认 / 预设 / 外部文件）
lib/prompt-inject.md   默认破甲指令层
lib/config.js          TOML 写入（受管块、三引号、裸键位置）
lib/agents.js          AGENTS.md 受管块
lib/shim.js            启动器接管（cmd / ps1 / sh）
lib/verify.js          端到端抓包验证
lib/paths.js           跨平台路径与宿主探测
presets/*.md           strict / soft / ctf / research
scripts/selftest.mjs   15 项自检（无需 codex、无需联网）
scripts/verify.mjs     端到端验证入口
```

```bash
node scripts/selftest.mjs   # 15/15
node scripts/verify.mjs     # 需要本机 codex
```

---

## 八、兼容性

- 实测：`@openai/codex` 0.163.0（Windows x64）。`model_instructions_file` / `developer_instructions` / `include_*_instructions` / `-p` / `--dangerously-bypass-approvals-and-sandbox` 均在该版本生效。
- 更老版本若没有 `model_instructions_file`，`--status` 会把 #2 标为 pending，此时退回 `--swap` + `AGENTS.md` 层，或改用 `config.toml` 受管块里的 `developer_instructions`。
- Linux/macOS 走 `codex`（sh）shim，备份名 `codex.codexpurge.bak`；Windows 走 `.cmd`/`.ps1`，备份名保留扩展名（`codex.codexpurge.bak.cmd`，否则 `CALL` 不认）。

---

## 九、署名与二开

MIT。二开请保留：

- `LICENSE` 里的版权行
- 受管标记 `codex-purge:*`（否则回滚与状态机会错乱）
- 本 README 的「为什么这样做」与「实测证据」两节，或在你自己的文档里给出等价证据

---

## 十、边界

这是给**你自己的机器、你自己的 Codex 会话**用的配置工具：它把 Codex 官方提供的开关拧到最松，并把过程做成可审计、可回滚的补丁。它不改上游代码、不伪造分发物、不绕过任何服务端校验。