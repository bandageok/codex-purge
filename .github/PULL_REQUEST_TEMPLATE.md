## 这个 PR 做了什么

<!-- 一句话；多件事请拆开 -->

## 影响哪一层

- [ ] 提示词层
- [ ] 引擎层
- [ ] 配置层
- [ ] shim 层
- [ ] 验证/工具链
- [ ] 文档

## 证据

```
# node scripts/selftest.mjs
# node bin/codex-purge.js --verify
```

## 检查项

- [ ] 新补丁在 `status()` 里有明确判定依据
- [ ] 写盘走 `fsutil.writeGuarded`（备份/快照/原子写）
- [ ] 测试只用临时 `CODEX_HOME`
- [ ] 受管标记未改名
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 已更新
- [ ] 涉及上游行为时附了 `compat-scan` 输出