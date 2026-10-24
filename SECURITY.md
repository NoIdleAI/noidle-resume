# 安全政策（Security Policy）

## 支持的版本

| 版本 | 是否支持 |
| --- | --- |
| 0.1.x | ✅ |

## 报告漏洞

**请勿通过公开 Issue 报告安全漏洞。**

请通过以下方式私下联系：

- GitHub：在 [NoIdleAI/noidle-resume](https://github.com/NoIdleAI/noidle-resume) 开一个 **Private vulnerability report**（仓库 Security 页 → Report a vulnerability）

我们承诺：

- 72 小时内确认收到
- 修复后会在 Release 说明中致谢（除非你希望匿名）

## 上报范围建议

**属于安全问题的**（举例）：

- 令牌鉴权被绕过（未持令牌可访问管理面 / API 写接口）
- CSRF / Origin 校验失效
- 服务意外监听到非 `127.0.0.1` 地址
- 恢复引擎以超出登记会话的权限执行操作
- 日志/数据目录中出现未脱敏的敏感信息

**不算安全问题的**（请走普通 Issue）：

- 「本机用户本来就能看到本机数据」类问题（本工具的威胁模型是本机单用户）
- 续跑能力被用户主动用于违反模型服务条款的场景（见 README 声明）
- 一般性功能缺陷

## 安全设计基线（供审计参考）

- 服务只监听 `127.0.0.1`；令牌鉴权，登录态为 HttpOnly Cookie
- 写操作需自定义头 + Origin/Host 双重校验（CSRF 防护）
- 恢复引擎显式 `--permission-mode default`，绝不使用 `--dangerously-skip-permissions`
- 未登记会话的事件不落库；日志脱敏截断
- 访问令牌落盘 `token.txt`，权限 `0600`
