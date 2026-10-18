# DSH 小浣熊 Connect

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![DSH 内核](https://img.shields.io/badge/DSH-0.2.1--rc.1%20~%200.2.x-2f6f4f.svg)](#安装与版本对应)
[![tests](https://img.shields.io/badge/tests-176%20passing-4b6fff.svg)](./CHANGELOG.md)
[![CI](https://github.com/zhlcba/dsh-raccoon-connect/actions/workflows/ci.yml/badge.svg)](https://github.com/zhlcba/dsh-raccoon-connect/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-raccoon-connect?color=cb3837)](https://www.npmjs.com/package/dsh-raccoon-connect)

> **仓库**：[GitHub · zhlcba/dsh-raccoon-connect](https://github.com/zhlcba/dsh-raccoon-connect)
> ｜ **国内镜像**：[Gitee · dhzl/dsh-raccoon-connect](https://gitee.com/dhzl/dsh-raccoon-connect)（GitHub 访问不稳时用这个，内容同步）

把**商汤小浣熊**桌面 App 里的模型（GLM-5.3、GLM-5.3-Flash、Kimi-K3、SenseNova-6.8-Flash-Lite、DeepSeek-V4.1-Flash 等）
接进 **DeepSeek Harness**，在 DSH 的对话窗口里直接选、直接用——**不用填任何 API Key**。
插件复用桌面端自己的登录态，账号切换自动跟随，模型名后面还带着上游的计费倍率与促销标签。

> ### 这是带 DSH 0.2.x 支持的 fork
>
> 上游 [liudapeng0311/dsh-raccoon-work](https://github.com/liudapeng0311/dsh-raccoon-work) 只声明支持 `0.1.5-rc.1`，
> 在 DSH 0.2.x 内核上会被兼容性校验**直接拒绝、装不上**。本 fork 把内核适配补到 0.2.x，
> 并在 Windows + Desktop profile + `0.2.1-rc.2` 上实测可用（模型分组出现、可正常对话）。
>
> **除内核适配外没有改任何东西**——上游协议、令牌语义、倍率算法、识图判定、探测逻辑一律保持原样；
> 176 个上游测试全部通过。逐条改动见 [CHANGELOG.md](./CHANGELOG.md)。
>
> 上游协议与实现思路另参考 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT），
> 但上游协议、令牌语义、倍率算法与探测判定全部按小浣熊网关的**实测行为**重写，见 `docs/upstream-protocol.md`。

## 快速开始

**前置**：本机已安装并登录 [商汤小浣熊桌面端](https://xiaohuanxiong.com)。插件不启动它、也不代替它登录。

```sh
# 1) 安装插件（Desktop profile；Web 端把 desktop 换成 web）
dsh plugin --profile desktop add dsh-raccoon-connect
# 或直接从 GitHub 装：
# dsh plugin --profile desktop add github:zhlcba/dsh-raccoon-connect

# 2) 完全退出 DSH（含托盘）再重新打开

# 3) 模型选择器里选「商汤小浣熊」分组的模型，开聊
```

装完**不需要再登录一次**——插件直接读桌面端写给本地 agent 的凭据文件。

## 常见问题

**桌面端要一直开着吗？**
不用。插件读的是凭据**文件**（`~/.box-agent/config/auth.json`），不是运行中的进程。只要桌面端曾经登录过、
凭据仍在有效期内，关掉 App 照样能用。只有三种情况需要打开 App：首次登录、凭据失效/被吊销、切换账号。

**支持哪些 DSH 版本？**
本 fork 支持 `0.2.1-rc.1` – `0.2.x`（实测 `0.2.1-rc.2`）。上游 0.1.x 线请用[上游仓库](https://github.com/liudapeng0311/dsh-raccoon-work)。
装错世代会被 DSH 的兼容性校验拒绝——这是保护，不是故障。

**和 `dsh-connect-sensenova-token-plan` 有什么区别？**
两者是**互不依赖**的两条通道：那条走商汤控制台的账号密码登录与网页微信扫码；本插件走**桌面端凭据**。
所以上游网页扫码页有任何变动都不影响本插件。

**会消耗我自己的积分吗？**
会——用的是你小浣熊账号自己的额度。插件只做本机转发，不代理、不上传你的数据，凭据也不出本机。
请遵守商汤小浣熊的服务条款，详见文末[免责声明](#免责声明)。

**装完看不到模型分组？**
按顺序查：① 桌面端是否登录过（`~/.box-agent/config/auth.json` 是否存在）；② DSH 是否**完全重启**过；
③ 跑 `dsh plugin --profile desktop exec dsh-raccoon-connect doctor` 看诊断。

## 功能

- **开箱即用**：安装并启用插件后，直接在 DSH 里选模型对话，不需要填任何 key。插件复用商汤小浣熊桌面端的登录状态（它自己给本地 agent 写的那个凭据文件），账号切换自动跟随。

- **倍率与促销**：模型名后面直接带上游目录里的计费倍率和促销标签，例如
  `GLM-5-3-Flash · x0.10 · 限时折扣`、`SenseNova-6.8-Flash-Lite · x0.00 · 限免一个月`。
  倍率只是显示，不影响实际请求；促销按时间窗口实时重算，过期后自动回到原价，原价也拿不到时显示「价格未知」而不是继续挂着折扣价。

- **图片输入**：能不能发图按**逐个模型的实测结果**判定，而不是照抄目录标签。上游目录里唯一的能力信号就是 `vision` 标签，而 2026-09-18 实测发现它在 5 个可见模型里错了 2 个、且两个方向都错：`DeepSeek-V4.1-Flash` 与 `GLM-5-3-Flash` 没有标签却真的能读图，`GLM-5-3` 打了标签但网关会把图片直接丢掉（模型回一句「我看不到这张图片」，比拒绝更难发现）。当前按实测声明支持识图的是 SenseNova-6.8-Flash-Lite、Kimi-K3、GLM-5-3-Flash、DeepSeek-V4.1-Flash；GLM-5-3 声明为纯文本，DSH 不会往里塞图片。上游新上的模型如果标签又标错了，用插件配置里的 `visionModelIds` / `textOnlyModelIds` 手工纠正即可，不必等发版；重跑实测见下方「真机复核」。

- **思考内容**：上游把思考放在非标准的 `delta.reasoning_content` 字段里，插件原样透传，DSH 侧照常显示 reasoning 流。

- **信息查看与刷新**：设置 → 插件 → 「商汤小浣熊」卡片显示账号、身份（个人/企业）、令牌有效期、剩余积分、当前模型列表来源（实时 / 已保存 / 内置兜底）与最近一次失败原因，也可以手动刷新模型列表。

- **推理等级探测**：卡片与输入框上都有「检测」入口，但**默认不做任何猜测**（见下文为什么它通常给出「不可校验」）。

## 安装与版本对应

前置：已安装并登录商汤小浣熊桌面端。插件不启动它、也不代替它登录。

```sh
# ① npm（推荐）
dsh plugin --profile desktop add dsh-raccoon-connect

# ② GitHub 源码（lib/ 已入库，装完即可用）
dsh plugin --profile desktop add github:zhlcba/dsh-raccoon-connect

# ③ 本地目录（开发用）
dsh plugin --profile desktop add link:/path/to/dsh-raccoon-connect
```

装完**完全退出 DSH（含托盘）再启动**，然后在模型选择器里找「商汤小浣熊」分组。

**版本对应**：插件必须与 DSH 核心的世代匹配，混用会导致 DSH 启动失败。

| 插件版本 | 要求的 DSH 核心 | Node | 实测 |
|---|---|---|---|
| `0.2.x`（本 fork） | `>=0.2.1-rc.1 <0.3` | `^22.19.0 \|\| >=24.0.0` | Windows + Desktop，`0.2.1-rc.2` ✅ |
| `0.1.x`（上游） | `0.1.5-rc.1` | 同上 | 上游只在 Web profile 验证过 |

本 fork 的实测范围：Windows、Desktop profile、DSH `0.2.1-rc.2`——插件能注册（`$DSH_HOME/.raccoon-host-heartbeat.json`）、
模型分组出现在选择器、选中模型可正常收发。设置卡片走的是运行时桥接（新内核的 slot 联合类型不含它），
卡片能否渲染未逐一验证；卡片缺席不影响模型服务。`dsh.client.platform` 仍声明为 `web`。

## 配置

插件卡片没有这些字段的编辑控件，改的是 profile 的补丁层 `~/.dsh/profiles/web/cordis.patch.yml`（追加一段针对 `llm-raccoon` 的 `config`，改完重启 DSH）：

```yaml
- id: llm-raccoon
  config:
    # authFile: 'C:/Users/you/.box-agent/config/auth.json'   # 默认读 ~/.box-agent/config/auth.json（别留空串，会覆盖成无效路径）
    # probeConsent: true      # 长期授权「检测推理等级」；默认关，每次检测都花少量积分
    visionModelIds: []      # 强制按「能识图」提供的模型 id
    textOnlyModelIds: []    # 强制按「纯文本」提供的模型 id，优先级高于上一行
```

`visionModelIds` / `textOnlyModelIds` 是给上游标签标错时兜底用的（见「功能」里的图片输入一节）：新模型能发图却被标成纯文本，把 id 加进前者即可，不必等插件发版；反向同理。

## 令牌是怎么复用的，以及一个必须说清的副作用

商汤小浣熊把登录态放在 `~/.box-agent/config/auth.json`（`BOX_AGENT_CONFIG_DIR` 可改位置），
访问令牌 3 小时过期，刷新令牌 30 天。它的刷新接口是**单次使用**语义：换一次令牌，新旧令牌一起轮转。

因此插件的凭据策略与只读复用不同：

- 令牌还在有效期内：直接读用，不做任何刷新，也不发网络请求。
- 令牌接近过期：插件刷新一次，并**把轮转后的新令牌写回 App 自己的 `auth.json`**。
  这是必须的——如果不写回，App 下次拿旧刷新令牌去换就会撞到 `refresh_conflict`，你会被退出登录。
  写回沿用 App 的格式与原子写方式（临时文件 + rename），并保留它原有的其他字段。
  每个进程第一次写回前，会在 `$DSH_HOME` 下留一份被替换文件的备份，作为出问题时的回滚材料。
- 撞到 `refresh_conflict`：先重读 App 文件（很可能 App 自己刚刷新过），拿到有效令牌就继续；
  拿不到才报错，并提示「打开一次商汤小浣熊重新登录」。
- 退出登录：`logout` 只删插件自留的副本和备份，**不动 App 自己的登录文件**。

没有任何登录态时，模型分组直接消失（而不是挂一串必然报错的模型）。

## 为什么「检测推理等级」多半会告诉你「不可校验」

小浣熊网关对 `reasoning_effort` 只做**部分**校验。实测（`sn-glm-5-3-flash`，最小请求）：

| 送进去的值 | 网关反应 |
|---|---|
| `off`、`banana` | 400，`该模型始终思考，不支持关闭思考；请使用 low、high 或 max。` |
| `low` / `medium` / `high` / `xhigh` / `max` | 200 |
| 随手乱写的 `randomword1234567890`、哨兵值 | **也是 200** |

也就是说「某个档位返回 200」根本证明不了它被真正执行——垃圾值同样返回 200。所以探测协议先用一个不存在的哨兵值试探网关是否真在校验；小浣熊的网关会被哨兵骗过，探测如实给出 `non-validating`，**不提供档位下拉**。这是设计上的正确结论，而不是失败：宁可没有档位控制，也不给你五个看起来能用、实际被忽略的选项。

400 报错文案里那句「请使用 low、high 或 max」确实是网关自陈的档位词表，但它是给人看的散文，不是结构化字段，插件不去解析它。

## 为什么探测要点第二次，而参考的那个插件不用

WorkBuddy 的上游在模型列表里**结构化地声明**了推理能力（`reasoning.supports` / `supportedEfforts[]` / `canDisableThinking`），插件照着填下拉就行，一次请求都不多花；探测只是它给"没声明的行"留的备用路径。小浣熊这边没有这个字段——目录行的全部字段是 `name / description / display_description / visible / model_name / tags / ability_level / params / billing_*`，没有任何一处提到档位，App 自己也从不发 `reasoning_effort`。所以档位只能实测，实测就要花积分，于是结论被缓存：按**账号 + 目录行指纹**（id、能力标签、上下文窗口、输出上限）存在 `~/.dsh/.raccoon-probe.json`，有效期 14 天，上游改了这一行就自动作废重测。

缓存要能跨重启生效才有意义。0.1.2 之前它做不到：插件启动后第一次认到账号时走的是"账号变了"这条分支，会把整个探测库清空——而那份记录恰恰就是这个账号自己花钱测的，于是每次重启都得重新点一遍检测。现在这条分支不再清空（跨账号的安全本来就由每条记录自带的账号字段把住：账号不符即视为无记录），重启后下拉直接可用。

## 命令行

```sh
dsh plugin --profile web exec dsh-raccoon-connect status   # 登录态、令牌有效期、剩余积分（--json 机器可读）
dsh plugin --profile web exec dsh-raccoon-connect doctor   # 诊断：路径、心跳、客户端标识、兜底名册
dsh plugin --profile web exec dsh-raccoon-connect logout   # 只删插件自留的凭据副本与备份
```

`status` 和 `doctor` 都**不会**刷新令牌：令牌轮换有写副作用，一个用来看状态的命令不该改登录状态。

## 真机复核

App 改版后，用这两个脚本对着真实网关重跑一遍协议（会花极少积分）：

```sh
npm run build
node tools/live-check.mjs          # 目录 / 积分 / 一次最小对话
node tools/live-stream-check.mjs   # 走完整 harness 链路：pi-ai → 本地 shim → 上游，含工具调用
node tools/vision-check.mjs        # 逐模型实测识图能力（随机色块图，自校验），对的就是 MEASURED_VISION
```

`vision-check.mjs` 会打印每个可见模型的「目录标签 / 插件实测 / 本次判定」三列，判定与标签不一致的行标 `≠tag`。App 改版或上游新增模型后重跑它，把结论回填 `src/catalog.ts` 的 `MEASURED_VISION`。

实测记录与判定都写在 `docs/upstream-protocol.md`。

## 已知限制

- 依赖小浣熊客户端接口（非官方开放 API），App 升级后可能需要跟着改；`~/.box-agent/config/auth.json` 的字段名与刷新语义是最可能变的两处。
- 只在 Windows 上真机验证过。credential 路径按 `os.homedir()` + `BOX_AGENT_CONFIG_DIR` 解析，macOS/Linux 逻辑相同但未实测；若不匹配，用 `RACCOON_AUTH_FILE` 指向实际文件。
- 目录里的 `params.context_window` / `max_tokens` 是唯一依据；上游没给的模型按保守值处理，不猜大窗口。
- 个人版 `X-Org-Code` 目前留空即可；企业版未验证。

## 免责声明

- 本项目仅供个人学习和研究使用，仅驱动使用者自己的小浣熊账号在本机调用，请勿用于商业用途或超出个人合理使用的场景。
- 使用者需遵守商汤小浣熊的服务条款；因使用本项目产生的任何后果（包括账号被限制、额度被清空、服务中断、登录态被刷新覆盖）由使用者自行承担。
- 本项目作者不对任何因使用或滥用本项目产生的直接或间接损失负责。
- 本项目与商汤科技、小浣熊、DeepSeek 均无关联，未获其授权或认可；文中出现的名称仅用于描述兼容关系，商标权利归各自所有。

## 致谢

- [liudapeng0311/dsh-raccoon-work](https://github.com/liudapeng0311/dsh-raccoon-work)（MIT）— **本项目的上游**，
  协议实现、令牌轮转、识图判定与探测逻辑均出自这里；本 fork 只补了 DSH 0.2.x 的内核适配。
- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)（MIT）— DSH provider 插件结构与 shim/探测范式的参照。
- [franksong2702/dsh-codex-connect](https://github.com/franksong2702/dsh-codex-connect)（Apache-2.0）— provider 注册方式的参照。

## 许可证

[MIT](./LICENSE)
