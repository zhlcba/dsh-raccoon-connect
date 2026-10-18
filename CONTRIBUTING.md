# 贡献指南 / Contributing

感谢你有兴趣改进这个项目。**开始之前请先读这一节**——本仓库是一个有明确边界的 fork，
不理解这一点容易做出会被拒绝的改动。

## 本仓库的定位

这是 [liudapeng0311/dsh-raccoon-work](https://github.com/liudapeng0311/dsh-raccoon-work) 的 fork，
**唯一目的是补 DSH 0.2.x 的内核适配**。

上游已经用实测重写过整套业务逻辑——协议实现、令牌轮转、识图判定、计费倍率、能力探测。
**没有新的实测依据就不要动这些代码**：改了很难解释，也很容易引入回归。

## 欢迎的贡献

| 类型 | 说明 |
|---|---|
| **DSH 内核适配** | 新内核版本移除/改名的 API、slot 变更、peer 依赖范围调整 |
| **兼容性修复** | 让插件在更多 DSH 版本、更多平台上正常装载 |
| **Bug 修复** | 带**复现步骤**的真实缺陷 |
| **文档改进** | README、CHANGELOG、安装说明、版本对应表 |
| **测试** | 补充覆盖，尤其是内核适配相关的回归测试 |

## 不适合本仓库的改动

- 重写上游的协议/鉴权/计费逻辑（请提到**上游**去讨论）
- 大范围重构、换语言、换框架
- 与本插件功能无关的"顺手优化"
- 引入新的运行时依赖（除非无法避免，且需说明理由）

> 如果你不确定某个改动属于哪一类，**先开 issue 讨论**，比直接提 PR 高效得多。

## 开发环境

```sh
git clone https://github.com/zhlcba/dsh-raccoon-connect.git
cd dsh-raccoon-connect
npm install --legacy-peer-deps
```

## 提交前必须全部通过

```sh
npx tsc -p tsconfig.json --noEmit          # host 端类型检查 → 0 错误
npx tsc -p tsconfig.client.json --noEmit   # client 端类型检查 → 0 错误
npx vitest run                             # 测试全绿
npx tsdown                                 # 构建通过
```

**四条缺一不可。** CI 也会跑同样的检查，本地先过一遍能省一轮来回。

## 代码约定

- **最小 diff**：只改与本次目标直接相关的行，不要夹带格式化或重构。
- **`lib/` 要一起提交**：DSH 的 `github:` 安装源不跑 `prepack`，`lib/` 不入库的话
  别人装完就是坏的。
- **不要提交** `node_modules/`、`ref/`、`probe/`、`*.tgz`。
- **配置文件用纯 ASCII 注释**：YAML/JSON 里写中文注释会引入编码风险。
- 新增/修改行为时，同步更新 `CHANGELOG.md`。

## 提交 PR

1. Fork 本仓库，从 `main` 开分支。
2. 提交信息用 Conventional Commits 风格（`fix:` / `feat:` / `docs:` / `chore:`）。
3. PR 描述里写清楚：**改了什么、为什么、怎么验证的**。
4. 涉及内核适配的，注明**验证用的 DSH 版本号**。

## 安全

发现安全问题时**不要开公开 issue**，请按 [SECURITY.md](./SECURITY.md) 的方式私下报告。

---

## Contributing (English)

This repository is a narrowly scoped fork whose only purpose is adding **DSH 0.2.x
kernel support**. Upstream's protocol, auth, billing and capability logic is
intentionally left untouched — please do not change it without measured evidence.

Welcome: kernel adaptation, compatibility fixes, bug fixes with reproduction
steps, documentation, tests.

Not welcome: rewriting upstream's protocol/auth logic (discuss upstream instead),
large refactors, unrelated cleanups, new runtime dependencies.

Run all four checks before submitting a PR (both `tsc` passes, `vitest`, `tsdown`),
keep the diff minimal, and commit `lib/` alongside source.
