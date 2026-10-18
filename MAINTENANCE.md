# 维护说明（维护者自用）

本仓库是 [liudapeng0311/dsh-raccoon-work](https://github.com/liudapeng0311/dsh-raccoon-work) 的 fork，
唯一目的是**补 DSH 0.2.x 的内核适配**。维护的复杂度主要来自两处：DSH 内核世代会变，上游小浣熊网关会变。

**原则**：只做内核适配，不改业务逻辑。上游的协议实现、令牌轮转、识图判定、倍率与探测逻辑
都是上游按实测重写过的，没有新的实测依据就不要动——改了很难解释，也容易引入回归。

## 三个发布位置，改一次要同步三处

| 位置 | 地址 | 推送方式 |
|---|---|---|
| GitHub | https://github.com/zhlcba/dsh-raccoon-connect | `git push`（本机常被重置，见下文 API 兜底） |
| **Gitee（国内镜像）** | https://gitee.com/dhzl/dsh-raccoon-connect | `git push gitee main`（直连，稳定快速） |
| **npm** | https://www.npmjs.com/package/dsh-raccoon-connect | `npm publish`（见下文 2FA 说明） |

**任何内容改动都要同步到 GitHub 和 Gitee 两处**，否则两个平台的用户看到的东西会不一致。
Gitee 的推送很稳，GitHub 的推送经常被重置——所以流程建议是：**先推 Gitee 验证内容，再用 API 兜底同步 GitHub**。

---

## 什么时候需要动这个仓库

| 触发 | 要做的事 |
|---|---|
| DSH 内核换代（`0.2.x` → `0.3` 等） | 更新 `peerDependencies` 范围 + 处理新内核移除/改名的 API，见下「内核换代」 |
| 上游修了协议（小浣熊 App 改版） | 先看上游有没有发新版；有就把上游改动合并进来，别自己重写 |
| 小浣熊 App 改了凭据路径/字段 | 上游 `src/auth.ts`、`src/client-identity.ts` 是最可能变的，参照上游做法 |
| 依赖出现安全公告 | 升级对应依赖，跑一遍完整验证 |

---

## 内核换代怎么改

1. **核对世代**：`dsh --version` 看内核版本；对照
   [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 的版本表
   （那个插件维护得最勤，它的对照表基本就是 DSH 内核世代的风向标）。
2. **改 `peerDependencies` 范围**，别用精确钉死——精确钉死会让内核每升一个 rc 都要
   用户手动申请 `allow-version` 豁免。本 fork 已改为 `>=0.2.1-rc.1 <0.3` 这种区间。
3. **跑类型检查**，让编译器告诉你哪里的 API 变了：
   ```sh
   npm install --legacy-peer-deps
   npx tsc -p tsconfig.json --noEmit          # host 端
   npx tsc -p tsconfig.client.json --noEmit   # client 端
   ```
   已知的历史差异（0.1.5 → 0.2.x）：
   - `settings.installSection()` → 移除，改 `settings.configure({ auto: true })`
   - 渲染 slot `settings.plugin.item` → `settings.plugins.tab`，且新 slot 联合类型不含该字面量，
     注册要走运行时桥接（见 `src/client/index.tsx` 的注释）
4. **跑测试**：`npx vitest run`，必须全绿（当前 176 个）。
5. **构建**：`npx tsdown`。产物 `lib/` **要入库**——DSH 的 `github:` 安装源不跑 `prepack`，
   `lib/` 不入库的话别人装完就是坏的。
6. **发版**：见下「发版流程」。

---

## 发版流程

```sh
# 1. 改 package.json 的 version，同步 CHANGELOG.md
# 2. 构建 + 验证
npx tsc -p tsconfig.json --noEmit && npx tsc -p tsconfig.client.json --noEmit
npx vitest run
npx tsdown

# 3. 提交 + 打标签
git add -A && git commit -m "..."
git tag -a v0.x.y -m "v0.x.y"

# 4. 推送（本机 git 传输协议常被重置，见下）
# 5. 建 Release（GitHub 网页或 API）
# 6. npm 发布
npm publish --registry=https://registry.npmjs.org/
```

### 推送：`git push` 挂了怎么办

本机到 GitHub 的 **git-over-HTTPS 会间歇性 `Recv failure: Connection was reset`**，
但 `api.github.com` 一直可用。两条路：

- 重试 `git push`（有时能过）。
- **改用 GitHub Git Data API**：按 tree/blob/commit 逐层提交，效果等价。仓库外的
  `sync-to-github.py` 封装了这件事（先试 `git push`，失败自动回落到 API，带重试）。

### 要注意的行尾陷阱

本机 `core.autocrlf=true`：工作树是 CRLF、仓库里存 LF。任何"直接读工作树字节再去比
git blob sha"的自动化都会被行尾差异骗到，从而产生一堆只有行尾变化的伪提交。
比较时务必用 git 规范化后的内容（`git ls-files -s` + `git cat-file blob`）。

### 用 API 推送之后，本地要重新对齐

API 提交产生的 commit SHA 与本地那份**必然不同**（committer、时间戳都不一样），
尽管内容一致。所以 API 推送成功后，本地的 `main` 与 `origin/main` 会分叉，
下一次 `git push` 会被判成 non-fast-forward 而拒绝。

网络恢复后对齐一次即可：

```sh
git fetch origin
git reset --hard origin/main     # 内容一致，重置是安全的
```

（`sync-to-github.py` 是按**内容**比较的，不受这个分叉影响，可以照常使用。）

---

## 发 npm 的注意事项

- 包名 `dsh-raccoon-connect`（npm 上未被占用，属于本 fork）。
- **账号开了 2FA**：`npm publish` 需要 `--otp=<6 位验证码>`，或使用能绕过 2FA 的
  Automation token。普通细粒度 token 会被 `EOTP` 拒绝。
- 建议 `npm publish` 时显式带 `--registry=https://registry.npmjs.org/`
  （本机可能配过 npmmirror 镜像，镜像不可发布）。
- `files` 白名单决定包内容：`lib` / `cordis.patch.yml` / 两个 README / `CHANGELOG.md` / `LICENSE`。

---

## 每次改动的最低验证清单

发版前逐条确认，任何一条不过就不要发：

- [ ] `npx tsc -p tsconfig.json --noEmit` → 0 错误
- [ ] `npx tsc -p tsconfig.client.json --noEmit` → 0 错误
- [ ] `npx vitest run` → 全绿
- [ ] `npx tsdown` → 构建通过，且 `lib/version-*.js` 里的版本号与 `package.json` 一致
- [ ] 在真实 DSH 上装载：模型分组出现、能对话（`$DSH_HOME/.raccoon-host-heartbeat.json` 有记录）
- [ ] 敏感数据扫描：仓库与 git 历史里没有 token / 本机路径 / 真实邮箱
- [ ] `CHANGELOG.md` 已记录，README 的版本对应表已同步
