# Changelog

本仓库是 [liudapeng0311/dsh-raccoon-work](https://github.com/liudapeng0311/dsh-raccoon-work) 的 fork。
上游基线为 `0.1.2`（2026-09-18，commit `1615e3f`）。

**改动原则**：只补 DSH 0.2.x 的内核适配，不碰业务逻辑。上游的协议实现、令牌轮转/写回、识图判定、
倍率与促销计算、推理档位探测判定一律保持原样——这些是上游 README 里花了大量篇幅论证过的部分，
没有实测依据就不该动。

---

## [0.2.0] — 2026-10-17

适配 DSH 0.2.x 内核。上游 `0.1.2` 声明 `^0.1.5-rc.1`，在 0.2.x 上会被 DSH 的兼容性校验直接拒绝
（`installation rejected: Plugin ... is incompatible with dsh 0.2.1-rc.2`），装不上。

### 改了什么

**1. `package.json` — 依赖世代与范围**

- `peerDependencies` 全部从 `^0.1.5-rc.1` 迁到 0.2.x 世代，并改用**范围**而不是精确钉死：
  `>=0.2.1-rc.1 <0.3`。上游把 peer 精确钉到 `0.1.5-rc.1`，意味着内核哪怕只升一个 rc 就要重新放行；
  范围可以让整个 0.2.x 线直接装上，不需要逐个版本申请 `allow-version` 豁免。
- `@deepseek-ai/cordis`：`^4.0.2` → `^4.0.5`
- `@deepseek-ai/schemastery`：`^3.18.2` → `^3.18.5`
- `@earendil-works/pi-ai`：`^0.85.1` → `^1.3.0`（0.2.1 世代内核要求 1.x）
- `devDependencies` 同步到同一世代，以便在 0.2.x 上构建。
- 补 `repository` / `homepage` / `bugs` 元数据。
- 版本号 `0.1.2` → `0.2.0`（对应该插件的第一条 0.2.x 支持线）。
- `package-lock.json` 重新生成。顺带修正一处上游遗留：lockfile 里的版本号还停在 `0.1.0`，
  与 `package.json` 的 `0.1.2` 不一致。

**2. `src/index.ts` — 设置服务 API 更名**

`settings.installSection()` 在 0.2.0 的设置服务改造中被移除，改为：

```diff
-    settingsCtx.settings.installSection(ctx, RACCOON_SETTINGS_NS, SECTION, config, {
-      setSource(source) { current = source as () => Config },
-      onChange() { ... },
-    })
+    settingsCtx.settings.configure({ auto: true })
```

新内核从 `Config` schema 自动派生表单，因此不再需要单独注册 section。降级语义与上游一致：
没有设置服务时插件照常提供模型，只是没有可编辑字段。

> 副作用：`installSection` 的 `setSource` 回调原本让 `config` 跟随设置页的实时编辑。
> 新 API 下这条链路不再存在，配置改动需重启 DSH 生效（0.2.x 上内核自身的表单也走 profile patch）。

`SECTION` 常量（`src/index.ts:156`）因此成为未引用代码，**有意保留**——它是给 0.1.x 路径的 schema，
保留便于日后同时支持两代内核，也让本 fork 相对上游的 diff 更小、更易 rebase。

**3. `src/client/index.tsx`、`src/client/RaccoonPluginCard.tsx` — UI 插槽**

设置卡片的插槽名从 `settings.plugin.item` 变为 `settings.plugins.tab`，且新内核的 slot 注册签名
（旧 API 接受 `key` / `priority`）不再被类型系统接受。改动：

- 插槽名更新为 `settings.plugins.tab`。
- 注册调用改走一个不带类型的桥接（`ctx.slots.register as unknown as ...`）。
- 卡片 props 类型从 `PropsRuntime<'settings.plugins.tab'>` 放宽为 `Record<string, unknown>`——
  新内核的渲染 slot 联合类型里不含这个字面量，无法用它索引。

外层原有的 `try/catch` 保持不变，所以**插槽不存在时卡片静默缺席，host 端的模型服务不受影响**。

### 验证状态

| 项 | 结果 |
|---|---|
| 上游测试套件 | ✅ **176 / 176 通过**（11 个文件）——设置 API 与插槽改动未破坏任何既有测试 |
| `tsc` host 端 | ✅ 0 错误 |
| `tsc` client 端 | ✅ 0 错误 |
| `tsdown` 构建 | ✅ 通过 |
| DSH 装载 | ✅ `0.2.1-rc.2` 实测：插件注册成功，模型分组出现，可正常对话 |
| 设置卡片渲染 | ⚠️ 未逐一验证（运行时桥接，缺席不影响模型） |
| macOS / Linux | ⚠️ 未验证（上游也只在 Windows 实测过） |

环境：Windows、DSH Desktop profile、DSH 内核 `0.2.1-rc.2`、Node 24。

> 上游的 `devDependencies` 缺一个传递依赖 `@deepseek-ai/dsh-launch-environment`（`dsh-llm-pi-ai` 需要），
> 会让 `tests/adapter.spec.ts` 与 `tests/index.spec.ts` 两个文件在 0.2.x 上直接加载失败。本 fork 已补上，
> 测试才能全绿。这是上游在 0.1.x 上不曾暴露的环境差异，不是代码缺陷。

### 上游历史（未改动，供对照）

- **0.1.2**（2026-09-18）— 探测缓存跨重启修正：不再因账号分支清空探测库；README 补真机复核。
- **0.1.1** 及更早 — 见上游仓库提交历史。
