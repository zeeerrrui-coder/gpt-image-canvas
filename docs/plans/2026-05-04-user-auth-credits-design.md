# 账号与积分管理设计

## 目标

将当前本地优先的 GPT Image Canvas 改造成可小范围分发使用的受控应用。普通用户可以注册和登录，但注册后没有积分；管理员在后台发放积分后，用户才能生成图片。每张成功生成的图片扣 1 积分，失败不扣积分。

## 权限边界

- 未登录用户只能访问登录和注册入口。
- 普通用户登录后直接进入画布，可打开自己的画廊。
- 普通用户看不到生成服务配置、Codex 登录、COS 配置等敏感配置入口。
- 管理员可以进入管理后台，管理用户状态和积分。
- 管理员后台不提供查看他人图片、提示词或画布内容的能力。
- 管理员可查看账号列表、积分余额、账号状态、发放/扣除流水和聚合统计。

## 账号模型

新增 SQLite 表：

- `users`：用户名、密码哈希、角色、状态、积分余额、创建时间、更新时间。
- `sessions`：登录会话 token 哈希、用户 ID、过期时间、创建时间。
- `credit_transactions`：积分变动流水，记录用户、操作类型、积分变化、生成记录 ID、管理员 ID、备注和创建时间。

首个管理员通过环境变量初始化：

- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`

如果数据库里没有管理员且环境变量齐全，服务启动时创建管理员账号。管理员密码只在创建时读取，不写入日志。

## 积分规则

- 普通用户注册后积分为 `0`。
- 用户提交生成请求时，后端先检查积分余额是否至少覆盖请求数量。
- 请求数量为 `count`，一次请求最多仍按现有配置限制。
- 上游返回后，按成功输出数扣积分。
- 全部失败不扣积分。
- 部分成功时只扣成功张数。
- 生成记录与资产归属到当前用户；画廊只返回当前用户自己的成功作品。

## API 设计

新增认证 API：

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

新增管理 API：

- `GET /api/admin/users`
- `PATCH /api/admin/users/:userId`
- `POST /api/admin/users/:userId/credits`
- `GET /api/admin/credit-transactions`

现有敏感 API 改为仅管理员可访问：

- `/api/provider-config`
- `/api/auth/codex/*`
- `/api/storage/config*`

现有生成与资产 API 改为需要登录：

- `/api/project`
- `/api/gallery`
- `/api/images/generate`
- `/api/images/edit`
- `/api/assets/*`

## 前端设计

- 去掉当前首页作为产品介绍页。
- 未登录时显示中文登录/注册页。
- 登录后默认进入 `/canvas`。
- 导航仅保留“画布”“画廊”；管理员额外显示“后台”。
- 将界面里的 `Gallery` 中文化为“画廊”。
- 普通用户不显示全局 provider 配置按钮、云存储按钮、Codex 登录入口。
- 顶部显示当前用户和积分余额，提供退出登录。
- 积分不足时，生成按钮禁用或提交后显示明确中文错误。

## 安全约束

- 密码使用 Node.js `crypto.scrypt` 加盐哈希。
- 会话 token 只以哈希形式存入 SQLite，浏览器通过 `HttpOnly` Cookie 持有 token。
- 管理 API 必须校验管理员角色。
- 普通用户不能通过直接请求读取或修改 provider、storage、Codex 配置。
- 资产读取需要校验资产归属；管理员也不绕过读取他人资产。

## 验证

- 新增 API 单元测试覆盖注册、登录、权限、积分扣除和失败不扣分。
- 新增前端构建/typecheck 验证。
- 完成后运行 `pnpm typecheck` 和 `pnpm build`。
- UI 改动完成后启动 `pnpm dev`，用浏览器验证登录、注册、后台发积分、生成入口和画廊中文化。
