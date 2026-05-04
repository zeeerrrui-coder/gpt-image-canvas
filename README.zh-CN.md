# GPT Image Canvas

[English](README.md) | [简体中文](README.zh-CN.md)

基于 tldraw、Hono、SQLite 和 GPT Image 2 构建的受控 AI 画布。当前版本新增账号密码、管理员后台和积分限制：普通用户注册后默认 0 积分，管理员发放积分后才能生成图片；每张成功生成的图片扣 1 积分，失败不扣积分。

## 效果图

![GPT Image Canvas 效果图](docs/assets/app-preview.png)

## 亮点

- 基于 tldraw 的 AI 画布，支持文生图和参考图生成。
- 生成图像和项目快照默认本地优先保存。
- 可选腾讯云 COS 备份，新生成图支持本地 + COS 双写。
- 生成历史支持定位、重跑、下载和云端上传状态提示。
- 支持 OpenAI 兼容图像端点，并兼容 PackyCode / `gpt-image` 风格响应。
- 新增账号系统、管理员后台和积分限制，适合小范围分发给朋友使用。
- 普通用户看不到 provider、Codex、COS 等敏感配置入口。

## 环境要求

- Node.js 22 或更新版本。
- pnpm 9.14.2。包管理器版本已固定在 `package.json` 中；可以通过 `corepack prepare pnpm@9.14.2 --activate` 启用。
- Docker Desktop 或兼容的 Docker Engine，用于 Docker 工作流。
- 用于实时生成的 OpenAI API key，或管理员在应用中完成的 Codex 登录。
- 管理员初始化环境变量：`ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。

## 快速开始

Windows PowerShell：

```powershell
pnpm install
Copy-Item .env.example .env
pnpm dev
```

macOS/Linux：

```sh
pnpm install
cp .env.example .env
pnpm dev
```

如果使用 API Key 生成，可以在 `.env` 中设置 `OPENAI_API_KEY`，也可以打开应用右上角 `配置` 弹窗保存一个本地 OpenAI 兼容 API 配置。应用默认使用官方 OpenAI Image API 和 `gpt-image-2`。如需转发到 OpenAI 兼容端点，可以在 `.env` 中设置 `OPENAI_BASE_URL`，也可以在弹窗中填写本地 Base URL；如需使用不同的兼容图像模型，请设置 `OPENAI_IMAGE_MODEL` 或弹窗里的高级模型字段。

首次部署前请在 `.env` 设置管理员账号：

```sh
ADMIN_USERNAME=admin
ADMIN_PASSWORD=change-this-password
```

服务启动时，如果数据库里还没有管理员且这两个值都存在，会自动创建管理员账号。普通用户可自行注册，但注册后积分为 0，需要管理员进入“后台”为用户发放积分。

打开 `http://localhost:5173` 使用 Web 应用。

## 账号、积分与路由

- 未登录访问应用时显示登录/注册页，不再显示产品首页。
- `/canvas` 是画布工作区，登录后默认进入画布。
- `/gallery` 是画廊，只显示当前登录用户自己的生成结果。
- `/admin` 是管理员后台，只管理账号和积分，不展示其他用户生成的图片、提示词或画布内容。
- 普通用户注册后积分为 0，无法直接生成图片。
- 管理员可在后台为用户增加或扣减积分。
- 每张成功生成的图片扣 1 积分；全部失败不扣积分；部分成功只按成功张数扣积分。
- 右上角 `配置` 按钮只对管理员显示，弹窗会展示环境 OpenAI、本地 OpenAI 兼容 API、Codex 的优先级和来源详情。
- Provider 优先级默认是环境 OpenAI、本地 OpenAI、Codex，可在弹窗中重新排序。只有更高优先级来源为空或在发起请求前不可用时才会回退。
- 环境变量保持只读。弹窗会掩码显示 `OPENAI_API_KEY`，展示 Base URL、模型、超时，并提示修改 `.env` 后需要重启 API。
- `Codex 登录` 只对管理员开放；授权后的 OAuth token 只保存在本地 API 侧。

## Provider 配置

Provider 配置弹窗只保存一个本地 OpenAI 兼容 API 配置。本地 API Key 会写入 `DATA_DIR` 下的 SQLite 数据库，读取时只返回掩码，并且在你输入新 key 之前会保留旧值。该弹窗只对管理员显示，普通用户不能通过浏览器界面或 API 读取与修改 provider 配置。

环境变量仍然是最明确的运维控制来源。它们在弹窗中以只读 provider 来源展示，应用不会修改 `.env`，默认优先级也仍然把环境来源放在第一位。即使你在 UI 中调整优先级，只要配置了 `.env`、本地 provider key、Codex token 或 COS 密钥，都不要把这个本地应用公开暴露，除非你自行增加认证和网络隔离。

## 升级到 v0.1.0

升级前建议备份本地运行数据：

Windows PowerShell：

```powershell
Copy-Item -Recurse data data-backup-before-v0.1.0
docker compose up --build
```

macOS/Linux：

```sh
cp -R data data-backup-before-v0.1.0
docker compose up --build
```

请确保 Web 应用和 API 一起重新构建。如果使用 Docker，建议直接访问 `http://localhost:8787`，并避免同时运行 `pnpm dev` 和 Docker 共用同一个 `data/` 目录。

## Codex 用户

Codex 可以直接在这个仓库中工作。克隆后，让 Codex 读取 `AGENTS.md`，再让它使用固定的包管理器安装依赖并运行检查：

```sh
pnpm install
pnpm typecheck
pnpm build
```

请不要把凭证写进提示词或日志。OpenAI API key 只应放在由 `.env.example` 复制出来的本地 `.env` 文件里，或保存到应用内 provider 配置弹窗中，不要粘贴到 Codex 对话中。如果需要让 Codex 验证实时生成，请要求它使用现有本地凭据，且不要打印环境变量或 SQLite 值。

如果涉及 UI 修改，让 Codex 运行 `pnpm dev`，并在浏览器中验证 Vite 应用 `http://localhost:5173`。本地临时文件应放在 `.codex-temp/` 下，该目录已被 Git 忽略。

## 开发流程

`pnpm dev` 会同时启动两个服务：

- API：Hono，默认地址为 `http://127.0.0.1:8787`。
- Web：Vite，默认地址为 `http://localhost:5173`，并将 `/api` 代理到 API 服务。开发服务会严格占用该端口，避免 `5173` 上的旧应用掩盖本项目启动失败。

使用右侧 AI 面板输入提示词、选择画面尺寸并生成图像。当画布中选中一张图片形状时，生成按钮会切换为参考图生成。画布编辑后会自动保存到本地 API，最近生成历史提供定位、重跑和下载已存储输出的操作。

AI 面板顶部也提供云存储按钮。需要将新生成图保存到 COS 时，可在弹窗中启用腾讯云 COS。

完成改动前请运行：

```sh
pnpm typecheck
pnpm build
```

## 脚本

- `pnpm dev` 启动全部 workspace 开发流程。
- `pnpm api:dev` 启动 API 开发流程。
- `pnpm web:dev` 启动 Web 开发流程。
- `pnpm typecheck` 检查 shared、web 和 API 的 TypeScript。
- `pnpm build` 构建 shared、web 和 API 包。
- `pnpm start` 启动构建后的 API 包。

## Docker

Docker Compose 会把共享契约、Web 应用和 API 构建到同一个镜像中。Hono API 会在同一个本地端口同时提供 `/api` 和构建后的 Web bundle，SQLite 数据和生成资产会持久化到宿主机 `./data`。

Windows PowerShell：

```powershell
Copy-Item .env.example .env
docker compose config --quiet --no-env-resolution
docker compose up --build
```

macOS/Linux：

```sh
cp .env.example .env
docker compose config --quiet --no-env-resolution
docker compose up --build
```

默认在 `http://localhost:8787` 打开应用。如需使用其他本地端口，请在启动 Docker Compose 前设置 `.env` 中的 `PORT`。

Docker Compose 还会默认设置 `SQLITE_JOURNAL_MODE=DELETE` 和 `SQLITE_LOCKING_MODE=EXCLUSIVE`。这样可以避开 Docker Desktop 绑定挂载 `./data` 目录时常见的 SQLite `SQLITE_IOERR_SHMOPEN` 错误，同时仍然把项目和生成资产保存在宿主机上。

Compose 构建支持与参考项目 `open-managed-flow` 相同的网络相关 build args：`NODE_IMAGE`、`NPM_CONFIG_REGISTRY`、`APT_MIRROR` 和 `APT_SECURITY_MIRROR`。Compose 中默认的 `NODE_IMAGE` 是 `node:23-bullseye-slim`，因为它满足应用的 `>=22` 运行时要求，并且在 Docker Hub 不可用时更常见于本地缓存。如需强制使用 Node 22 基础镜像，可以运行：

Windows PowerShell：

```powershell
$env:NODE_IMAGE = 'node:22-bookworm-slim'
docker compose up --build
```

macOS/Linux：

```sh
NODE_IMAGE=node:22-bookworm-slim docker compose up --build
```

`OPENAI_API_KEY` 可以在本地启动检查、使用管理员配置的本地 provider 或使用管理员 Codex 登录生成时留空。应用仍会启动；如果没有任何可用 provider，生成端点会返回 `missing_provider` JSON 错误，浏览器会显示登录/注册页。

## 腾讯云 COS 备份

生成图始终先保存到本地。用户在应用内云存储弹窗启用 COS 后，新生成图还会上传到：

```text
<key-prefix>/YYYY/MM/<assetId>.<ext>
```

COS 表单默认值来自 `.env`：

- `COS_DEFAULT_BUCKET`
- `COS_DEFAULT_REGION`
- `COS_DEFAULT_KEY_PREFIX`

保存 COS 配置前会执行一次测试上传和删除。由于当前应用没有服务端账号系统，`SecretKey` 会保存在本地 SQLite 数据库中，但读取配置接口只返回掩码状态，不会回显明文。

COS 上传失败不会导致生成失败。图片仍可从本地读取，生成历史中会显示云备份失败标记。

## 本地数据

运行时状态存储在 `DATA_DIR` 下，本地默认是 `./data`，Docker 中默认是 `/app/data`。该目录包含：

- `gpt-image-canvas.sqlite`：默认项目、生成历史、资产元数据、云端上传元数据、一个可选本地 provider 配置、可选 COS 配置，以及 Codex OAuth token 记录。
- `assets/`：生成的图像文件。

Docker Compose 会将宿主机 `./data` 绑定挂载到 `/app/data`，因此项目和生成资产会在容器重建后保留。不要提交 `.env`、`data/`、生成图像、SQLite 文件或构建输出。

## 安全与隐私说明

- 密钥只从 `.env`、运行时环境变量或本地 SQLite 设置数据库读取。不要提交 `.env`、展开后的 Docker Compose 配置输出、包含 key 的 shell 历史、SQLite 数据库或包含密钥值的日志。
- 从右上角 provider 弹窗保存的本地 API Key 会存储在 SQLite 中，并由 provider-config API 掩码返回。保存本地 API Key 后，请将 `data/gpt-image-canvas.sqlite` 视为敏感文件；如果没有自行增加认证和网络控制，不要公开暴露这个本地应用。
- Codex OAuth access token、refresh token、ID token、邮箱、账号 ID、过期时间和刷新时间会存储在 `DATA_DIR` 下的本地 SQLite 中。完成 Codex 登录后，请将该 SQLite 数据库视为敏感运行时数据。
- 从 UI 保存的 COS SecretKey 会存储在本地 SQLite 中，并由设置接口掩码返回。配置 COS 后，请将 `data/gpt-image-canvas.sqlite` 也视为敏感文件。
- 提示词、项目状态、生成资产和 SQLite 数据都是 `DATA_DIR` 下的本地运行时数据。除非你有意导出特定资产，否则应将 `data/` 视为私有数据。
- 发布分支前，请检查 `git status --short`，确认只暂存了源代码、文档和预期 metadata。`.env`、`.ralph/`、`.codex-temp/`、`data/`、生成图像、SQLite 数据库和构建输出都应保持未跟踪。
- 如果真实 API key 曾被提交过，请先轮换该 key。Git ignore 规则只能防止之后泄露，不能从已有 Git 历史中移除密钥。

## 故障排查

- 缺少或空的 `OPENAI_API_KEY`：应用仍会启动。如果没有本地 API 配置或 Codex 会话，文生图和参考图请求会返回 `missing_provider`。管理员可以把有效 key 添加到 `.env` 后重启 API 或 Docker 容器，也可以从 `配置` 保存本地 API Key，或使用 `Codex 登录`。
- Codex 登录无法完成：确认机器可以访问 `https://auth.openai.com`，保持设备登录弹窗打开直到授权完成；用户码过期后重新开始登录流程。不要粘贴或记录 token 值。
- 自定义 provider 地址：在 `.env` 中设置 `OPENAI_BASE_URL`，例如 `https://api.example.com/v1`，然后重启 API 或 Docker 容器；也可以在 `配置` 中填写本地 Base URL。该端点必须兼容 OpenAI API，并支持当前配置的图像模型。
- 缺少模型访问权限：确认当前 active provider key 所属的 OpenAI organization 和 project 可以访问当前配置的图像模型。如果兼容端点需要不同模型名，请设置 `OPENAI_IMAGE_MODEL` 或本地高级模型字段。
- 高分辨率生成超时：默认上游请求超时为 20 分钟，可在 `.env` 中调大 `OPENAI_IMAGE_TIMEOUT_MS`，或调整本地 provider 超时字段。
- 端口已被占用：为 API/Docker 运行时设置 `.env` 中的 `PORT`；如果 Web 的 `5173` 被占用，请先关闭占用进程，或显式运行 `pnpm web:dev -- --port 5174` 并打开打印出来的地址。
- Docker 构建无法拉取 Node 基础镜像：在 macOS/Linux 可用 `NODE_IMAGE=node:23-bullseye-slim docker compose up --build` 使用本地缓存镜像；在 Windows PowerShell 可先运行 `$env:NODE_IMAGE = 'node:23-bullseye-slim'`，再运行 `docker compose up --build`；也可以恢复 Docker Hub 访问后重新运行 `docker compose up --build`。
- Docker config 默认会输出 `.env` 值。真实凭证存在时，请使用 `docker compose config --quiet --no-env-resolution` 做验证，不要分享展开后的 config 输出。
- Docker 中出现 SQLite `SQLITE_IOERR_SHMOPEN`：保留 Compose 默认的 `SQLITE_JOURNAL_MODE=DELETE` 和 `SQLITE_LOCKING_MODE=EXCLUSIVE`，重新构建，并确认没有本地 API 进程同时占用同一个 `data/` 数据库。
- SQLite `SQLITE_CORRUPT`：停止所有应用进程，备份 `data/`，再从备份恢复，或删除 SQLite 文件让应用创建新数据库。`data/assets/` 下的生成图片文件可以保留。
- `/api/project` 自动保存返回 400：查看 Docker 日志中的 `Project save rejected`。大画布快照支持到 100 MB；导入的 data URL 图片仍可能让快照变得很大。
- 本地状态过期或不需要：停止应用并删除 `data/` 下的文件。这会删除本地项目状态、历史记录和生成资产。

## 许可证

MIT

## 友情链接

- [LINUX DO - 新的理想型社区](https://linux.do/)
