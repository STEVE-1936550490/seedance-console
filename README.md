# Seedance Console

Seedance Console 是面向 Linux 内部环境的 AI 视频生成控制台。当前 MVP 使用 Mock Provider 验证参考图片上传、异步任务、状态轮询、历史、视频预览和下载，不调用真实 Seedance 服务。

## 当前基线

Mock MVP 已在 Ubuntu 24.04 Linux 服务器完成 Docker 端到端验收，覆盖图片上传、异步任务、Worker 处理、状态轮询、Mock 视频生成、播放下载、历史记录和容器重启后的数据保留。真实 Seedance Provider 尚未接入，默认且唯一可用的 Provider 仍为 `mock`。

详细记录：

- [Linux Docker 部署与运维](docs/DEPLOYMENT.md)
- [Mock MVP 端到端验收](docs/MOCK_E2E_ACCEPTANCE.md)
- [真实 Provider 协议状态](docs/provider-api.md)
- [真实 Provider 待确认清单](docs/PROVIDER_PROTOCOL_CHECKLIST.md)
- [Provider 版本化轮询实现](docs/POLLING_SCHEDULING.md)

## Linux Docker 启动

服务器只需安装 Docker Engine 和 Docker Compose v2：

```bash
test -f .env || cp .env.example .env
docker compose config --quiet
docker compose up -d --build --wait
docker compose ps
```

Compose 会依次启动 PostgreSQL、Redis、数据库迁移、共享文件存储初始化、API、Worker 和 Web。迁移成功后才启动应用服务。

打开：

- 创作台：`http://<服务器IP>:43170`
- 任务历史：`http://<服务器IP>:43170/history`

API 与 Worker 只绑定服务器回环地址：

```bash
curl http://127.0.0.1:43171/health
curl http://127.0.0.1:43172/health
docker compose logs -f api worker web
```

默认端口为 Web `43170`、API `43171`、Worker `43172`、PostgreSQL `45432`、Redis `46379`，可在 `.env` 调整。浏览器通过 Next.js 同源代理访问 API，不需要知道服务器内部地址。

根目录 `.env` 已被 Git 和 Docker 构建上下文忽略。当前必须保持：

```dotenv
SEEDANCE_PROVIDER=mock
```

Mock 模式不要求任何真实 Provider 配置。`SEEDANCE_API_KEY` 和 `SEEDANCE_BRIDGE_TOKEN` 不会注入 Web 或 API；客户端构建还会执行密钥扫描。

## 本地源码开发

需要 Node.js 22、Corepack 和 Docker Compose：

```bash
corepack enable
corepack prepare pnpm@10.15.0 --activate
test -f .env || cp .env.example .env
pnpm install
docker compose up -d postgres redis
pnpm db:migrate
pnpm dev
```

本地页面仍使用同源代理，默认访问 `http://localhost:43170`。

## Mock MVP 验证

1. 在创作台选择 `Mock Video V1` 并填写提示词。
2. 上传一张 JPG、PNG 或 WebP 参考图片。
3. 选择比例、分辨率和时长，保持“测试结果”为“生成成功”。
4. 点击“生成视频”，观察排队、提交和生成状态。
5. 成功后播放并下载 Mock MP4。
6. 刷新页面，确认当前任务恢复。
7. 进入任务历史，确认任务参数、状态和 Mock 用量仍存在。

Provider 没有返回进度时，页面只显示状态与已等待时间。“模拟失败”可验证错误展示，“持续处理中”可验证长时间等待界面。

## 质量检查

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check:client-secrets
```

测试覆盖 Mock Provider 幂等、成功、失败、慢处理和取消，以及
`QUEUED → SUBMITTING → PROCESSING → SUCCEEDED` 状态流转、本地 Storage、Provider
capabilities 和 MP4 预览响应。

可在装有 Docker 的环境额外检查：

```bash
docker compose config
docker compose up -d --build --wait
```

## 停止

```bash
docker compose down
```

保留数据卷即可再次恢复任务和历史。只有明确需要清空全部本地数据时才执行：

```bash
docker compose down -v
```

该命令会不可恢复地删除 PostgreSQL、Redis 和生成文件。

## 真实 Provider 状态

真实 Seedance API 尚未接入，也不得自动调用收费接口。现有 SDK 和示例只能确认部分调用形状，不能替代完整官方协议。所有未确认项目均在 `docs/provider-api.md` 中标记为 `TODO_CONFIRM`；真实任务编排接入前保持 `SEEDANCE_PROVIDER=mock`。

## 工作区

```text
apps/web                   Next.js 创作台和任务历史
apps/api                   Fastify API、上传和任务查询
apps/worker                BullMQ Worker 和 Mock 任务处理
packages/shared            共享 DTO 和队列契约
packages/config            环境变量校验
packages/seedance-provider Provider 契约和 Mock 实现
packages/db                Prisma schema、迁移和客户端
packages/storage           本地文件存储抽象
```
