# Changelog

本仓库是 [liudapeng0311/dsh-raccoon-work](https://github.com/liudapeng0311/dsh-raccoon-work) 的 fork。
上游基线为 `0.1.2`（2026-09-18，commit `1615e3f`）。

**改动原则**：只补 DSH 0.2.x 的内核适配，不碰业务逻辑。上游的协议实现、令牌轮转/写回、识图判定、
倍率与促销计算、推理档位探测判定一律保持原样——这些是上游 README 里花了大量篇幅论证过的部分，
没有实测依据就不该动。

---

## [0.2.3] — 2026-10-24

纯文档修正：README 里的版本对应表写着错误的依赖范围。代码无改动。

### 问题

`README.md` 与 `README.en.md` 的「版本对应」表格把 `0.2.x` 的核心要求写成
`>=0.2.1-rc.1 <0.3`，而 `package.json` 实际用的是**逐个列出的预发布分支**：

```
>=0.2.1-rc.1 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0 || … || >=0.2.9-rc.1 <0.3
```

两者不是同一个东西。按 node-semver 规则，带预发布标签的版本只有在范围里存在
「`major.minor.patch` 元组相同、且自身也带预发布标签」的比较符时才会被接受，
所以 `>=0.2.1-rc.1 <0.3` **匹配不到 `0.2.2` 及以后的预发布内核**——这恰好是 0.2.1
修掉的那件事，但文档当时没跟着改，等于把修好的坑又写回了说明书。

### 改了什么

- 表格里的范围改成「各预发布线的显式并集」，并加脚注解释为什么不能写成 `<0.3`
- 中英两份 README 同步修改

> 发新版本是必要的：npm 上的 README 是**发布时的快照**，不发版本刷不掉。

---

## [0.2.2] — 2026-10-24

修一个**让新模型永远显示不出来**的截断 bug。上游新增模型后，插件仍然只显示 5 个
兜底名册里的模型，卡片上唯一的线索是 `[object Object]`。

### 根因

`src/upstream.ts` 的 `textOf()` 把响应体截断到 4096 字符：

```ts
return (await response.text()).slice(0, 4096)
```

这个上限在 `model_catalog` 文档还小于 4 KiB 时无害。但该文档是**按账号变化的**，
会随模型数量增长。上游把目录扩到 10 个模型（其中 7 个 `visible: true`）后，
响应变成 **5650 字节 / 5140 字符**，于是：

1. `slice(0, 4096)` 把 JSON 从中间切断
2. `JSON.parse` 抛 `Unterminated string at position 4096`
3. `envelope()` 判定为失败（`kind: 'client'`）
4. `fetchCatalog` 捕获后回退到 `FALLBACK_CATALOG`（只有 5 个模型）
5. 卡片显示 `catalog.source: fallback`，错误信息是 `[object Object]`

实测对照：

| | 结果 |
|---|---|
| `slice(0, 4096)` 后解析 | ❌ 失败 |
| 完整 5140 字符解析 | ✅ `code=0`，10 个模型 |

### 改了什么

**1. `textOf()` 不再截断** —— 它的返回值是 `JSON.parse` 的输入，不该有长度上限。
长度限制只应出现在**展示**错误消息的地方（`failure`、错误里的 `slice(0, 512)`）。

**2. 错误信息不再变成 `[object Object]`** —— `RaccoonUpstreamClient.failure()` 抛出的是
普通对象 `{ ok: false, status, kind, message }` 而不是 `Error`，原来 `String(error)`
把所有上游失败都压成了 `[object Object]`，正是它让这个 bug 隐身了两天。
新增 `errorMessage()` 优先读对象里的 `kind` / `status` / `message`。

**3. 新增回归测试** —— `tests/upstream.spec.ts` 里构造一个 >4096 字符的合法目录文档，
断言能解析出全部 12 个模型。测试总数 176 → 177。

> 这个 bug 不影响登录态与计费：诊断时账号 `signed-in`、余额 2306 积分均正常，
> 上游接口直连返回 200 / `code: 0`。

---

## [0.2.1] — 2026-10-18

修一个**会静默挡住未来内核**的依赖范围问题。0.2.0 的 `>=0.2.1-rc.1 <0.3` 看起来是宽范围，
实际上**匹配不到 0.2.2 及以后的预发布内核**。

### 根因

node-semver 的规则：一个带预发布标签的版本，只有在范围里**存在一个与自己
`major.minor.patch` 元组完全相同、且自身也带预发布标签的比较符**时，才可能被范围接受。

`>=0.2.1-rc.1 <0.3` 的两个比较符是：

| 比较符 | 元组 | 带预发布？ |
|---|---|---|
| `>=0.2.1-rc.1` | `0.2.1` | ✅ |
| `<0.3` | `0.3.0` | ❌ |

所以只有 `0.2.1-*` 的预发布能过；`0.2.2-rc.1`、`0.2.3-rc.1` 全都**被静默排除**，
用户会撞上 `ERESOLVE`，只能手工申请版本豁免——这正是 0.2.0 想避免的那种麻烦。

### 改了什么

`peerDependencies` 的 7 个 `@deepseek-ai/dsh-*` 全部改为**显式列出各 patch 元组的预发布分支**：

```
>=0.2.1-rc.1 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0 || ... || >=0.2.9-rc.1 <0.3
```

实测覆盖（semver 7.8.5）：

| 内核版本 | 0.2.0 | 0.2.1 |
|---|---|---|
| `0.2.1-rc.2`（当前） | ✅ | ✅ |
| `0.2.2-rc.1` | ❌ | ✅ |
| `0.2.5-rc.1` | ❌ | ✅ |
| `0.2.9-rc.1` | ❌ | ✅ |
| `0.2.10-rc.1` | ❌ | ❌（两位 patch，需要时再加分支） |
| `0.3.0-rc.1` | ❌ | ❌ |

> 内核升到 `0.2.10` 或 `0.3.x` 时，需要**手动补一条分支**——见 `MAINTENANCE.md`。

### 顺带补上的工程化

- `.github/workflows/ci.yml`：类型检查 ×2 + 测试 + 构建 + `lib/` 同步检查
- `.github/workflows/release.yml`：**Trusted Publishing (OIDC)** 自动发布，推 tag 即发版
- `CONTRIBUTING.md` / `SECURITY.md` / `CODE_OF_CONDUCT.md` / issue & PR 模板
- `.gitattributes`：统一行尾，消除 Windows/Linux 与 `core.autocrlf` 造成的伪差异

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
