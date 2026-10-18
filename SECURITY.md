# 安全政策 / Security Policy

## 报告漏洞

**请不要开公开 issue。** 用以下任一方式私下报告：

1. **推荐**：[GitHub 私密安全通告](https://github.com/zhlcba/dsh-raccoon-connect/security/advisories/new)
   （Security → Report a vulnerability）
2. 或邮件联系维护者（见 GitHub 个人主页）

请尽量包含：

- 受影响的版本（插件版本 + DSH 内核版本）
- 复现步骤或最小验证用例
- 影响评估（能读到什么、能改到什么、需不需要本地权限）
- 你希望的署名方式（或匿名）

**我会在 7 天内确认收到**，并在修复发布后于 CHANGELOG 中致谢（除非你要求匿名）。

## 支持范围

| 在范围内 | 说明 |
|---|---|
| 插件自身代码 | 本仓库 `src/` 下的实现 |
| 凭据处理 | 读取桌面 App 登录态、令牌轮转、日志是否泄露敏感信息 |
| 安装/装载面 | 构建产物、`cordis.patch.yml`、客户端注入 |

| 不在范围内 | 去哪报告 |
|---|---|
| **上游插件逻辑** | [liudapeng0311/dsh-raccoon-work](https://github.com/liudapeng0311/dsh-raccoon-work) |
| **DSH 本体** | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) |
| **商汤小浣熊服务端/客户端** | 商汤官方渠道 |
| 上游服务本身的鉴权/计费设计 | 商汤官方渠道 |

## 已知的设计取舍（不是漏洞）

- 插件**复用桌面 App 已保存的登录态**（`auth.json`），这是它的工作方式，不是提权。
- 令牌以明文存放在用户自己的配置目录中，权限继承自该用户的文件系统 ACL——
  与本机其他用户级凭据同等信任级别。
- 插件的模型调用经上游网关，本地不做额外代理或中间人。

## 维护者自查清单（发布前）

- [ ] 仓库与 git 历史中无 token / 本机绝对路径 / 真实邮箱
- [ ] `~/.npmrc` 不含 `_authToken`（发布用命令行传入）
- [ ] 构建产物与源码一致（`lib/` 已随源码更新）
- [ ] 依赖无已知高危公告
