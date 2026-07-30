# Seedance Console

Seedance Console 是面向 Linux 内部环境的 AI 视频生成控制台。当前 MVP 使用 Mock Provider 验证参考图片上传、异步任务、状态轮询、历史、视频预览和下载，不调用真实 Seedance 服务。

## Linux Docker 启动

服务器只需安装 Docker Engine 和 Docker Compose v2：

```bash
test -f .env || cp .env.example .env
docker compose up -d --build
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
SEEDANCE_PROVIDER_DRIVER=mock
```

即使 `.env` 中已经填写 `MAAS_API_KEY`，Compose 也不会将其注入 Web、API 或 Mock Worker。客户端构建还会执行密钥扫描。

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

## 下一步

下次从 Linux Docker 端到端验收继续，暂不接入真实 Provider：

1. 执行 `docker compose up -d --build --wait`，检查全部服务健康状态。
2. 验证上传图片、数据库建任务、Redis 排队和 Worker 调用 Mock Provider。
3. 验证状态轮询、视频播放与下载，以及刷新后的任务恢复和历史记录。
4. 检查浏览器请求、页面源码和构建产物中不存在 API Key。
5. 修复目标服务器环境中发现的问题，再决定是否进入真实 Provider 阶段。

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
