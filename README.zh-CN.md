# GPT Image Canvas

[English](README.md) | [简体中文](README.zh-CN.md)

基于 tldraw、Hono、SQLite 和 GPT Image 2 构建的本地专业 AI 画布。

## 环境要求

- Node.js 22 或更新版本。
- pnpm 9.14.2。包管理器版本已固定在 `package.json` 中；可以通过 `corepack prepare pnpm@9.14.2 --activate` 启用。
- Docker Desktop 或兼容的 Docker Engine，用于 Docker 工作流。
- 用于实时生成的 OpenAI API key，且需要具备 `gpt-image-2` 访问权限。没有凭证时应用仍可启动，但生成请求会返回运行时缺少 key 的错误。

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

实时生成前，请在 `.env` 中设置 `OPENAI_API_KEY`。应用默认使用官方 OpenAI Image API 和 `gpt-image-2`。如需转发到 OpenAI 兼容端点，请在 `.env` 中设置 `OPENAI_BASE_URL`。

打开 `http://localhost:5173` 使用 Web 应用。

## Codex 用户

Codex 可以直接在这个仓库中工作。克隆后，让 Codex 读取 `AGENTS.md`，再让它使用固定的包管理器安装依赖并运行检查：

```sh
pnpm install
pnpm typecheck
pnpm build
```

请不要把凭证写进提示词或日志。OpenAI API key 只应放在由 `.env.example` 复制出来的本地 `.env` 文件里，不要粘贴到 Codex 对话中。如果需要让 Codex 验证实时生成，请要求它使用现有 `.env`，且不要打印环境变量值。

如果涉及 UI 修改，让 Codex 运行 `pnpm dev`，并在浏览器中验证 Vite 应用 `http://localhost:5173`。本地临时文件应放在 `.codex-temp/` 下，该目录已被 Git 忽略。

## 开发流程

`pnpm dev` 会同时启动两个服务：

- API：Hono，默认地址为 `http://127.0.0.1:8787`。
- Web：Vite，默认地址为 `http://localhost:5173`，并将 `/api` 代理到 API 服务。

使用右侧 AI 面板输入提示词、选择画面尺寸并生成图像。当画布中选中一张图片形状时，生成按钮会切换为参考图生成。画布编辑后会自动保存到本地 API，最近生成历史提供定位、重跑和下载已存储输出的操作。

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

`OPENAI_API_KEY` 可以在本地启动检查时留空。应用仍会启动，生成端点会返回缺少 key 的 JSON 错误，直到配置凭证为止。

## 本地数据

运行时状态存储在 `DATA_DIR` 下，本地默认是 `./data`，Docker 中默认是 `/app/data`。该目录包含：

- `gpt-image-canvas.sqlite`：默认项目、生成历史和资产元数据。
- `assets/`：生成的图像文件。

Docker Compose 会将宿主机 `./data` 绑定挂载到 `/app/data`，因此项目和生成资产会在容器重建后保留。不要提交 `.env`、`data/`、生成图像、SQLite 文件或构建输出。

## 安全与隐私说明

- 密钥只从 `.env` 或运行时环境变量读取。不要提交 `.env`、展开后的 Docker Compose 配置输出、包含 key 的 shell 历史或包含密钥值的日志。
- 提示词、项目状态、生成资产和 SQLite 数据都是 `DATA_DIR` 下的本地运行时数据。除非你有意导出特定资产，否则应将 `data/` 视为私有数据。
- 发布分支前，请检查 `git status --short`，确认只暂存了源代码、文档和预期 metadata。`.env`、`.ralph/`、`.codex-temp/`、`data/`、生成图像、SQLite 数据库和构建输出都应保持未跟踪。
- 如果真实 API key 曾被提交过，请先轮换该 key。Git ignore 规则只能防止之后泄露，不能从已有 Git 历史中移除密钥。

## 故障排查

- 缺少或空的 `OPENAI_API_KEY`：应用仍会启动；文生图和参考图请求会返回缺少 key 的 JSON 错误。将有效 key 添加到 `.env` 后，重启 API 或 Docker 容器。
- 自定义 provider 地址：在 `.env` 中设置 `OPENAI_BASE_URL`，例如 `https://api.example.com/v1`，然后重启 API 或 Docker 容器。该端点必须兼容 OpenAI API，并支持当前配置的图像模型。
- 缺少模型访问权限：确认 `OPENAI_API_KEY` 所属的 OpenAI organization 和 project 可以访问 `gpt-image-2`。
- 高分辨率生成超时：默认上游请求超时为 20 分钟，可在 `.env` 中调大 `OPENAI_IMAGE_TIMEOUT_MS`。
- 端口已被占用：为 API/Docker 运行时设置 `.env` 中的 `PORT`，或者在 Vite 提示时使用其他端口。
- Docker 构建无法拉取 Node 基础镜像：在 macOS/Linux 可用 `NODE_IMAGE=node:23-bullseye-slim docker compose up --build` 使用本地缓存镜像；在 Windows PowerShell 可先运行 `$env:NODE_IMAGE = 'node:23-bullseye-slim'`，再运行 `docker compose up --build`；也可以恢复 Docker Hub 访问后重新运行 `docker compose up --build`。
- Docker config 默认会输出 `.env` 值。真实凭证存在时，请使用 `docker compose config --quiet --no-env-resolution` 做验证，不要分享展开后的 config 输出。
- 本地状态过期或不需要：停止应用并删除 `data/` 下的文件。这会删除本地项目状态、历史记录和生成资产。

## 许可证

MIT

## 友情链接

- [LINUX DO - 新的理想型社区](https://linux.do/)
