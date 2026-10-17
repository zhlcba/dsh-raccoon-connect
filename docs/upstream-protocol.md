# 商汤小浣熊上游接口实测记录

本文件记录 `dsh-raccoon-connect` 依赖的上游事实，全部来自本机安装
（`D:\apps\raccoon-ai`，App 版本目录 `resources/app.asar`，2026-09-10 构建）
与真实请求，不是推测。插件只认这里写明的行为，App 改版后按本文件复核。

## 1. 登录态来源：`~/.box-agent/config/auth.json`

小浣熊主进程把桌面登录态写成普通 JSON 文件，供其本地 agent（box-agent）使用：

- 路径解析：`process.env.BOX_AGENT_CONFIG_DIR ?? path.join(os.homedir(), '.box-agent', 'config')`，文件名固定 `auth.json`
  （见 asar 内 `build/electron/main/boxAgentAuthFile.js` 的 `getBoxAgentAuthPath`）
- 字段（全部可选，字符串）：`access_token`、`refresh_token`、`office_identity`、`office_org_name`、`office_org_role`
- 读取端还兼容 `token` / `auth_token` 作为 access token 的别名
- 写入方式：`JSON.stringify(payload, null, 2) + '\n'`，`0o600`，先写 `${path}.${pid}.tmp` 再 rename
- 主进程不缓存：`desktopAuthState.readDesktopAuthState()` 每次调用都重读该文件

JWT 载荷实测字段：`exp`、`nbf`、`iss`、`name`（昵称）、`nation_code`、`owner_type`（`users`）、`sid`（会话 id，登录来源前缀，如 `web…`）。
令牌有效期实测：access **3 小时**，refresh **30 天**。

## 2. 令牌刷新：`POST /api/web/auth/v1/refresh`

来自 asar 内渲染端鉴权类（`S.refreshTokenRequest`）：

```
POST https://xiaohuanxiong.com/api/web/auth/v1/refresh
Content-Type: application/json
body: {"refresh_token": "<jwt>"}
→ 200 {"code":0, "data": {"access_token": "...", "refresh_token": "..."}}
```

要点：

- 请求**不带** `Authorization`，令牌只在 body 里
- 响应把 access 与 refresh **一起轮转**，渲染端随后同时回写 localStorage 与桌面 auth 文件
- 轮转是**单次使用**语义：旧 refresh token 再用会返回
  `400 {"code":200822,"message":"refresh_conflict","details":"refresh token conflict or reused"}`
  因此插件刷新成功后必须把新令牌回写到 App 的 `auth.json`，否则下次打开小浣熊会掉登录
- 参数名写错（如 `refreshToken`）返回 `100002 params_invalid_error`；body 缺失返回 `100000 request_body_error`

## 3. 请求头

渲染端 `createHeaders()` 与本地 agent 实测：

| 头 | 值 | 说明 |
|---|---|---|
| `Authorization` | `Bearer <access_token>` | 必需 |
| `X-Org-Code` | `getOrgCode()`，个人版为空串 | 个人版留空即可 |
| `X-Raccoon-Language` | `zh` / `zh-CN` | 影响模型 description 语言 |
| `X-Client-Platform` | `web` / `desktop` | 客户端标识 |
| `X-Client-Version` | App 版本 | |
| `X-Client-Device-ID` | `desktop-device-identity.json` 的 `clientDeviceId`（uuid） | 设备绑定用 |
| `Content-Type` | `application/json` | |

鉴权失败统一返回 `401 {"code":200003,"message":"authorization_verify_error"}`。

## 4. 模型目录：`GET /api/web/llm/v2/model_catalog`

解析器实测（asar chunk `28610`，模块 `2132`）：

```
{ code: 0, data: { categories: [
  { type: "chat", default_model: "<name>", models: [
    { name, description, display_description, visible,
      tags: [...],                    // "image" | "image-understanding" 归一为 "vision"
      ability_level: int>0,           // 缺省按 1
      params: { context_window, max_tokens },
      billing_multiplier,             // 倍率（>0）
      billing_effective_multiplier,   // 折后实际倍率（>=0）
      billing_status: "normal" | "discount" | "limited_free",
      billing_status_note,
      billing_discounts: [{ name, multiplier, daily_start, daily_end, start_at, end_at, active }]
    } ] } ] } }
```

- 只取 `categories` 里 `type === "chat"` 的那一组
- `visible === false` 不展示；名字/描述等于 `raccoon-work`（应用内建 agent 路由位）的行也过滤
- `default_model` 不在列表里时退回首行
- 解析后为空视为失败，不能用空列表冒充目录

## 5. 对话：`POST /api/web/llm/v2/chat/completions`

- 标准 OpenAI Chat Completions 形状，流式 SSE；本地 agent 就是按 `provider: "openai"` +
  `apiBase = https://xiaohuanxiong.com/api/web/llm/v2` 直连（`resources/default-llm-config.json`、
  `~/.box-agent/config/model-profiles.json`），因此插件不需要 WorkBuddy 那类私有报文改写
- App 内置默认档位 `raccoon-chat-ml-5-5`，`contextWindow` 180000 / `maxTokens` 80000；
  账号实际绑定的 hosted profile 见 `office-raccoon/default-session-model-binding.json`
  （如 `sn-glm-5-3-flash`，`contextWindow` 1000000，`maxTokens` 100000，`profileId` `hosted:<hash>`）
- `reasoning_effort`：App 自己**不发送**该参数（bundle 里的同名命中全部来自打包的 openai/ai-sdk 类型定义），
  上游是否校验未知 → 与 WorkBuddy 插件一致，采用用户手动触发的档位探测，不凭经验补齐

## 6. 其他

- 图像生成：`POST /api/web/llm/v2/images/gen`（`default-llm-config.json` 的 `imageGeneration.endpoint`）
- 积分接口已实测：`GET /api/web/points/v1/balance`（返回 `{code,data:{total}}`），
  账单为 `GET /api/web/points/v1/bills?paging.limit&paging.offset&type`；
  倍率与促销徽章另取自目录的 `billing_*` 字段
- 环境别名：`code-test` / `code-stage` / `code-dev.xiaohuanxiong.com` 为测试环境，正式只有裸域
- 图片理解能力判定：**不能只看 `tags` 里的 `vision`**。它是上游唯一公布的能力字段，实测却两个方向都错；
  插件按 §8 的实测结果逐模型判定（`MEASURED_VISION`），标签只作为未测模型的回退依据

## 7. 真机复核结果（2026-09-16，`node tools/live-check.mjs`）

个人账号（`office_identity: personal`，`owner_type: users`）实测：

```
GET /api/web/llm/v2/model_catalog → code=0
data.categories[type=chat].default_model = sn-sensenova-6-8-flash-lite
  sn-sensenova-6-8-flash-lite  SenseNova-6.8-Flash-Lite  ctx 256000  max 63999  rate 0     tags general,chat,rewrite,summary,fast,vision  promos 限免一个月
  sn-glm-5-3                   GLM-5-3                   ctx 1000000 max 100000 rate 0.75  tags general,office,code,vision,debug,analysis,html,reasoning
  sn-kimi-k3                   Kimi-K3                   ctx 1000000 max 100000 rate 1     tags general,office,code,vision,debug,analysis,html,reasoning
  sn-glm-5-3-flash             GLM-5-3-Flash             ctx 1000000 max 100000 rate 0.1   tags general,chat,rewrite,summary,fast            promos 限时折扣
  sn-deepseek-v4-pro           DeepSeek-V4-Pro-0813      ctx 1000000 max 100000 rate 0.5   tags general,code,html,analysis,reasoning,auto
GET /api/web/points/v1/balance → {"total":<余额>}
```

流式实测（`sn-glm-5-3-flash`，19 个 SSE 事件 / 3.2 秒）：思考文本走**非标准字段**
`choices[].delta.reasoning_content`，而 `delta.content` 在思考阶段为空串。pi-ai 的
`openai-completions` 已经按 `reasoning_content → reasoning → reasoning_text` 顺序识别该字段并转成
`thinking_delta`，所以插件不需要自己做字段改写。

两条由此而来的判定：

- 目录里的 `reasoning` 标签**不能**当作"上游支持 `reasoning_effort`"或"会输出思考"的依据：
  `sn-glm-5-3-flash` 没有该标签，实测照样输出 `reasoning_content`。它描述的是 App 侧的路由预设。
  推理档位仍只能靠探测，探测候选因此覆盖目录里全部模型。
- `max_tokens` 给得太小会得到"只有思考、没有正文"的空 `content` 回复（实测 16 tokens 即如此）。
  插件不主动设小档位，输出上限取目录的 `params.max_tokens`。

## 8. 识图能力实测（2026-09-18，`node tools/vision-check.mjs`）

判定方法刻意做成**自校验**的：每次运行现生成一张 96×96 的 PNG，三条竖直色块的颜色从 6 色里随机抽 3 色并打乱，
发一句「按从左到右只说颜色」，再拿答案和真相比。随机有序三色猜中的概率是 1/120，所以一次判定就是结论而不是暗示。

必须先实测而不能读状态码的原因：**网关对纯文本模型不报错**，它直接把 `image_url` 那段丢掉，HTTP 仍是 200，
模型侧收到的是「有一条提醒说你不能处理这张图」，于是回一句「抱歉，我看不到这张图片」。
也就是说 over-claim（多报能力）在这里既不会被 400 拦住，也不会污染账单，只会变成一次让人摸不着头脑的对话。

5 个可见模型逐一实测（每行 2 次独立运行）：

```
model                            tag    measured   verdict    notes
sn-sensenova-6-8-flash-lite      yes    yes        reads images  紫红绿→紫色，红色，绿色 | 绿黄紫→绿色、黄色、紫色
sn-glm-5-3                       yes    no         text only  ≠tag  红绿紫→抱歉，我看不到这张图片——我目前无法处理图像输入 | 紫绿红→抱歉，我无法看到这张图片……
sn-kimi-k3                       yes    yes        reads images  红橙蓝→红、橙、蓝 | 黄紫绿→黄色、紫色、绿色
sn-glm-5-3-flash                 no     yes        reads images ≠tag  红橙紫→红色、橙色、紫色
sn-deepseek-v4-1-flash           no     yes        reads images ≠tag  橙黄绿→橙色、黄色、绿色 | 绿红黄→绿色、红色、黄色
```

由此定下的判定（写进 `src/catalog.ts` 的 `MEASURED_VISION`，`docs` 与单测各自钉住一条）：

- 图片能力按**逐模型实测**声明，优先顺序是：用户配置 `textOnlyModelIds` > `visionModelIds` > `MEASURED_VISION` > 目录 `vision` 标签。
  `textOnly` 压过 `imageInput`，因为拒绝一张图只是一次明确提示，而放行一张被网关丢掉的图会产生「模型自称看不见」的更坏结果。
- 5 个可见模型**全部**记进实测表（包括与标签一致的那 2 个）：只记分歧项的话，上游哪天改标签就会把已测出的能力翻转回去。
- 未测过的 id 仍回落到标签：标签虽不可靠，仍是比"什么都不知道"更好的先验；新模型用 `vision-check.mjs` 实测后回填，
  或临时用配置纠正。
- 这条与 §7 的 `reasoning` 标签教训同源：目录里的标签描述的是 **App 侧的路由预设**，不是网关对该模型的实测能力。

## 9. `reasoning_effort` 的真实校验语义（逐值实测）

对 `sn-glm-5-3-flash` 逐值发最小请求（`max_tokens: 8`，读到首个 SSE 事件即断开）：

| 值 | 结果 |
|---|---|
| 不传 | 200 |
| `low` / `medium` / `high` / `xhigh` / `max` | 200 |
| `none`、`probe_sentinel_deadbeef…`、`randomword1234567890` | **200（被放过）** |
| `off`、`banana` | 400 |

400 报文：

```
litellm.BadRequestError: Custom_raccoonException - 该模型始终思考，不支持关闭思考；请使用 low、high 或 max。
```

结论（决定了插件的行为，不是实现细节）：

- 网关做的是**部分**校验——它拦住"关闭思考"一类的值，但对无意义字符串照单全收。
  因此"某个档位返回 200"不能证明这个档位真被模型执行：垃圾值同样 200。
- 所以探测协议里"哨兵值被接受 ⇒ `non-validating` ⇒ 不给档位控件"这一步，正是对小浣熊
  网关的正确判定；逐档扫出来的 low/medium/high 全都不可信。
- 400 文案里"请使用 low、high 或 max"是网关自陈的档位词表，但它是给人看的散文而不是结构化字段，
  解析它属于脆弱的猜测，插件不解析，只在文档里留此记录。
- `off` / `minimal` 永不探测，也不进档位映射（与本仓库其他 provider 一致）。

## 10. 已知易变点（改版先查这里）

1. `auth.json` 的字段名与 `BOX_AGENT_CONFIG_DIR` 语义
2. refresh 的单次使用语义与是否继续同时回写两份令牌
3. `model_catalog` 的 `categories[].type === "chat"` 与 `billing_*` 命名
4. 个人版 `X-Org-Code` 是否仍可为空
5. `tags` 里的 `vision` 与真实识图能力的对应关系（§8：已实测到两个方向都错，App 改版后请重跑 `tools/vision-check.mjs`）
