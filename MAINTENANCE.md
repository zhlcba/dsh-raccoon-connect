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
   用户手动申请 `allow-version` 豁免。

   ⚠️ **但「看起来宽」的范围也会静默挡住预发布内核。** node-semver 的规则：带预发布
   标签的版本，只有当范围里存在**与自己 `major.minor.patch` 元组完全相同、且自身也带
   预发布标签**的比较符时才可能通过。所以 `>=0.2.1-rc.1 <0.3` 只放行 `0.2.1-*`，
   `0.2.2-rc.1` 会被排除。正确写法是显式列出每个 patch 元组的分支：

   ```
   >=0.2.1-rc.1 <0.2.2-0 || >=0.2.2-rc.1 <0.2.3-0 || ... || >=0.2.9-rc.1 <0.3
   ```

   **内核 patch 号升到已有分支之外时（如 `0.2.10`），必须补一条新的 `||` 分支**，
   否则用户装不上。验证方法：

   ```sh
   node -e "const s=require('semver');console.log(s.satisfies('0.2.10-rc.1', require('./package.json').peerDependencies['@deepseek-ai/dsh-llm']))"
   ```
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

### ⚠️ 锁文件里不要留镜像地址（会让 CI 直接装不上）

用国内的 npmmirror 装过依赖后，`package-lock.json` 的 `resolved` 字段会记下镜像地址，
例如 `https://registry.npmmirror.com/zod/-/zod-4.4.3.tgz`。

**较新的 npm 会以 `EALLOWREMOTE` 直接拒绝安装**：

```
npm error code EALLOWREMOTE
npm error Fetching packages of type "remote" have been disabled
npm error Refusing to fetch "zod@https://registry.npmmirror.com/zod/-/zod-4.4.3.tgz"
```

`ci.yml` / `release.yml` 里都升级了 npm，所以一定会撞上。

**修复**（integrity 哈希不用改，镜像内容与官方一致）：

```sh
# 把镜像地址批量换回官方源
python -c "p='package-lock.json';c=open(p,encoding='utf-8').read();open(p,'w',encoding='utf-8').write(c.replace('https://registry.npmmirror.com/','https://registry.npmjs.org/'))"
```

本地开发想用镜像时，**在命令行临时指定 `--registry`，不要写进 `.npmrc`**；装完记得检查 lock 有没有被污染。
`ci.yml` 里已加了一道检查（grep 到 `npmmirror`/`cdn.`/`registry.yarnpkg` 就报错）。

---

## 发 npm 的注意事项

- 包名 `dsh-raccoon-connect`（npm 上未被占用，属于本 fork）。
- **npm 的政策：发布者账号必须启用 2FA**，然后二选一：
  - 交互式：`npm publish --otp=<6 位码>`
  - 非交互式：**创建时勾选了「Bypass 2FA」的 granular access token**
- ⚠️ **本机账号 2FA 只绑了安全密钥（WebAuthn），CLI 永远拿不到 OTP**——
  所以手动发布**必须**用带 Bypass 2FA 的 token。普通 token 会被 `EOTP` 拒绝；
  **关掉 2FA 更糟**，会报 403「...is required to publish packages」。
- `Bypass 2FA` **只在 token 创建时能设**，事后改不了。
- 建议 `npm publish` 时显式带 `--registry=https://registry.npmjs.org/`
  （本机可能配过 npmmirror 镜像，镜像不可发布）。
- `files` 白名单决定包内容：`lib` / `cordis.patch.yml` / 两个 README / `CHANGELOG.md` / `LICENSE`。

---

## CI 自动发布（已配置并验证通过 ✅）

**现状**：Trusted Publisher 已配置，`v0.2.1` 已通过它成功发布（带 SLSA provenance），
全程未使用任何 token。

仓库里有两个工作流：

| 文件 | 触发 | 作用 |
|---|---|---|
| `.github/workflows/ci.yml` | push / PR 到 main | 类型检查 ×2、测试、构建，并检查 `lib/` 与源码同步 |
| `.github/workflows/release.yml` | 推 `v*` tag | 校验 → 构建 → **发布 npm** → 建 GitHub Release |

发布走 **npm Trusted Publishing (OIDC)**：不需要 `NPM_TOKEN`，npm 直接信任
本仓库的 GitHub Actions 身份。**一次性配置**：

1. 登录 npmjs.com → 进入包页面 `dsh-raccoon-connect` → **Settings**
2. 找到 **Trusted Publisher** → 选 **GitHub Actions**
3. 填：
   - Organization or user：`zhlcba`
   - Repository：`dsh-raccoon-connect`
   - Workflow filename：**`release.yml`**（必须与实际文件名一致）
   - Environment：留空
4. 保存

之后发版的完整流程变成：

```sh
# 1. 改 package.json 的 version + 更新 CHANGELOG.md
# 2. 本地验证四道关（见下）
# 3. 提交并推送到 GitHub 和 Gitee
git add -A && git commit -m "release: v0.2.1"
git push origin main
git push gitee main
# 4. 打 tag 推送 —— CI 自动完成发布
git tag v0.2.1 && git push origin v0.2.1
```

> Trusted Publishing 还要求包是 **public** 且仓库是 **public**（两者都满足）。

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
