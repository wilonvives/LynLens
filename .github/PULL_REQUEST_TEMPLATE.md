<!--
谢谢你的 PR！请填以下三块再提交。空着或乱填会拖慢 review。
-->

## 改了什么

<!-- 简短列点，让 reviewer 30 秒内知道做了什么 -->

-
-

## 为什么

<!-- 解决什么问题、解锁什么场景。链上对应 issue（如有）：closes #N -->


## 怎么测的

<!-- 你自己手动验证过哪些路径？说得越具体越好 -->

- [ ] `pnpm test` 全绿
- [ ] `pnpm lint` 0 errors
- [ ] `pnpm typecheck` 0 errors
- [ ] 自己跑了 dev、点了相关功能验证不挂

## AI-first 自检

LynLens 是 AI-first 设计——UI 能做的事 agent 也要能做。**新功能必须**：

- [ ] 加了 / 改了对应的 MCP 工具（`packages/desktop/src/main/agent-tools/*.ts`）
- [ ] 或：N/A（这个 PR 不引入用户可见行为，纯重构 / 文档 / 测试）

## 文件大小自检

- [ ] 没有让任何文件 > 800 行（CLAUDE.md 硬规则）
- [ ] 新文件 < 400 行（典型目标）
