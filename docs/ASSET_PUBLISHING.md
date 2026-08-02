# Provider 参考图片安全发布

## 当前结论

参考图片现在可通过私有、S3 兼容的移动云 EOS Bucket 临时发布，不再依赖 Caddy、
DuckDNS 或本机公网 80/443。真实 Seedance 单参考图链路已完成一次验收；默认继续使用
Mock Provider，任何后续真实任务仍需新的单次授权。

2026-08-02 的本轮状态对账没有调用真实 Provider、没有创建收费任务，并保持：

```dotenv
SEEDANCE_PROVIDER=mock
REAL_API_TEST=false
```

## Storage 与发布边界

`LocalStorage` 将 Asset 保存到 `STORAGE_ROOT` 下的受控 `storageKey`。读取、检查和原子
写入都通过 Storage 抽象；路径解析拒绝绝对路径、空值、NUL 和逃逸根目录的路径。
数据库保存 Asset 元数据，文件本体保存在本地卷。

`AssetPublisher.publishForProvider()` 接收 `assetId`、Provider、用途和最短 TTL，返回
只存在于 Worker 内存中的 `PublishedProviderAsset`：Asset ID、角色、MIME、字节数、
SHA-256、HTTPS URL 和过期时间。Worker 不拼 URL；Seedance Adapter 只接收发布后的
对象。签名 URL不写入 Prisma、BullMQ payload、`ProviderSubmission`、任务事件或普通
日志，也不返回前端。

图片路径开放一张 `image/png` 或 `image/jpeg`，role 为 `REFERENCE_IMAGE`。单参考视频
MVP 另开放一段 `video/mp4`、role 为 `REFERENCE_VIDEO`，具体本地安全策略见
[单参考视频 MVP](REFERENCE_VIDEO_MVP.md)。参考音频、多图、多视频、MOV 和 WebP 真实
发布尚未实现。

## Console 签名素材端点

端点：

```text
GET|HEAD /api/provider-assets/:assetId
  ?provider=seedance
  &purpose=reference-image
  &expires=<epoch-ms>
  &signature=<base64url-hmac>
```

HMAC-SHA256 的规范消息绑定版本、`assetId`、`provider`、`purpose` 和 `expires`。验签
先校验固定格式和长度，再使用常量时间比较。过期签名不可复用，超出配置 TTL 的未来
时间也会被拒绝。

授权后仍会重新读取数据库 Asset，并检查：

- kind 必须为 `INPUT_IMAGE`；
- MIME 仅限 PNG/JPEG，文件头必须与数据库 MIME 一致；
- 文件非空且不超过配置上限；
- 实际长度和 SHA-256 必须与数据库元数据一致；
- `storageKey` 只能来自数据库，调用者不能提交路径；
- 文件缺失、元数据不一致和路径穿越全部拒绝。

成功响应设置准确的 `Content-Type`、`Content-Length`、基于 SHA-256 的 `ETag`、
`Cache-Control: private, no-store`，不支持 Range。该端点与普通用户的视频预览/下载
端点分离，并关闭该路由的请求访问日志，避免 query 中的 signature 泄漏。

## 配置与 fail-closed

配置只进入 API 和 Worker，不使用 `NEXT_PUBLIC_`：

```dotenv
SEEDANCE_ASSET_SIGNING_KEY=<至少 32 字节的随机 secret>
SEEDANCE_ASSET_PUBLIC_BASE_URL=https://assets.example.com
SEEDANCE_ASSET_URL_TTL_MS=120000
SEEDANCE_ASSET_MAX_BYTES=10485760
```

前三项必须同时设置或同时不设置。Base URL 必须是无认证信息、query、fragment 和子路径
的外部 HTTPS origin；localhost、`.local`、无点主机名及 IP 字面量全部拒绝。TTL 必须
覆盖 Worker 的 create timeout 和安全余量。

缺少完整素材发布配置时，Seedance 图生视频创建在 API 明确返回
`ASSET_PUBLISHING_NOT_CONFIGURED`，Worker 也会 fail closed。Seedance 纯文任务和 Mock
Provider 不要求这组配置。

## 已完成的 fixture 验收

自动化测试仅使用本地文件、Fastify injection、fake/fixture Bridge 和 Mock MP4，覆盖：

- 正确、错误、异常长度、过期及各绑定字段被篡改的签名；
- Asset 不存在、文件缺失、空文件、超限、MIME/内容不符、checksum/长度不符；
- storageKey 路径穿越和非公网 Base URL；
- GET/HEAD 响应元数据及日志不含完整 URL/signature；
- Adapter 精确生成单个 `reference_image` content；
- fixture Bridge 读取签名素材；
- submit、poll、download、本地持久化、Web 预览和下载完整链路；
- Mock 与纯文任务不依赖素材发布配置。

fixture 成功不代表真实 Provider 已能访问此服务器。

## 已完成的真实单参考图验收

此前获得单次授权后，任务 `cms9w5wu70006lj019o2gbni8` 使用一张 JPEG 经私有 EOS
预签名 URL 完成真实 `create → running → succeeded → download → persist`。输出 MP4 为
7,309,809 字节，数据库与文件 SHA-256 一致。EOS 对象 `seedance-inputs/3c567b17…`
随后删除，验收时 `HeadObject` 返回 404；数据库、Redis、前端与日志未发现完整预签名
URL 或凭证泄漏。完整证据见
[真实 Provider Demo 最终检查点](REAL_PROVIDER_DEMO_CHECKPOINT.md)。

## EOS/S3 预签名发布

生产推荐 `ASSET_PUBLISHER=eos`。Worker 在 Seedance create 前重新验证本地文件，然后以
随机 256-bit 对象名上传到私有 Bucket，设置准确的 `Content-Type`，并用 AWS SDK v3
生成限时 GET URL。URL 只存在于 Worker 当前调用内存；数据库仅保存 task/asset、
publisher、bucket、object key、过期时间和清理状态。

Endpoint、Region 和寻址方式必须采用 EOS 控制台或租户官方文档给出的值。实现使用 SDK
默认 SigV4，并允许通过 `EOS_FORCE_PATH_STYLE` 切换 path-style；没有写死区域、Endpoint
或虚拟主机寻址。

```dotenv
ASSET_PUBLISHER=eos
EOS_ENDPOINT=https://<由 EOS 提供>
EOS_REGION=<由 EOS 提供>
EOS_BUCKET=<私有 Bucket>
EOS_ACCESS_KEY_ID=<仅服务器环境变量>
EOS_SECRET_ACCESS_KEY=<仅服务器环境变量>
EOS_OBJECT_PREFIX=seedance-inputs/
EOS_PRESIGN_TTL_SECONDS=3600
EOS_FORCE_PATH_STYLE=false
EOS_DELETE_ON_TERMINAL=true
```

上传/签名失败不会调用 Provider。确认请求未发送或 Provider 明确拒绝时立即开放清理；
结果不确定时保留绑定并进入人工对账。已绑定 providerTaskId 后，只有 Provider 明确
FAILED/CANCELLED/EXPIRED，或视频下载、持久化和校验完成后的 SUCCEEDED 才写入
`providerAssetCleanupReadyAt` 并删除对象。本地 poll 超时不开放清理。删除失败只保存
`OBJECT_DELETE_FAILED`，不改变任务终态，也不保存远端错误正文。

视频对象使用独立的 `seedance-inputs/videos/` 子前缀；图片现有对象命名保持兼容。两者
都使用不可预测随机 key，并设置与本地验证一致的 Content-Type、Content-Length。

## EOS 连通性验收

2026-08-02 已在部署环境完成一次验收：fixture 上传成功，预签名 GET 返回正确的
`image/png` 与 SHA-256，删除后同一 URL 返回 404。Bucket 凭据、完整对象 key 和签名
URL 均未写入仓库或日志。

在凭据、Bucket、Endpoint、Region 或寻址方式变更后，应重新运行：

```bash
pnpm eos:verify
```

脚本上传内置 1×1 PNG，生成 5 分钟 GET URL，以 HTTP GET 校验状态、Content-Type 和
SHA-256，最后删除对象。输出只包含 Bucket、脱敏 key、大小、SHA-256 前缀和 TTL。

## 生产切换与回滚

部署 migration 后设置 EOS 变量及 `ASSET_PUBLISHER=eos`，先保持
`SEEDANCE_PROVIDER=mock` 运行连通性脚本，再重启 Worker/API，最后按变更流程切换真实
Provider。回滚只需改回 `ASSET_PUBLISHER=hmac`、恢复三项 HMAC 配置并重启；新表可以
保留，不应在回滚时删除。切换前应清理 `deletedAt IS NULL` 的遗留 EOS 对象。

## 后续真实图生视频前置条件

再次授权真实图片任务前仍必须由部署/运维确认：

1. Bucket 保持私有读写，凭证只授予指定前缀所需的 Put/Get/Delete 权限。
2. 保持 2026-08-02 已通过的 EOS 上传、GET 和删除闭环；配置变更后重新验收。
3. 单参考图和当前 TTL 已完成一次真实验收；正式图片格式、大小和最短 TTL 仍以服务商
   资料为准。
4. 获得真实图片 Demo 的明确授权后，才可开启真实 create 门。

因此不得把一次成功扩展为未确认的参数范围，也不得在没有新授权时再次执行真实任务。
