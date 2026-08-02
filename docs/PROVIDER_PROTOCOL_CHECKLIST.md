# 真实 Seedance Provider 协议确认清单

## 1. 使用方式

本清单用于继续向接口文档、平台页面或服务商逐项取证。纯文生视频和单参考图最小闭环
已经由真实 Demo 验证；未勾选项代表扩展能力或正式协议证据仍缺失，不表示 AICC
Bridge、真实创建、轮询或下载尚未实现。不要填写或截图真实 API Key、
Authorization、私钥、完整敏感提示词、完整素材内容或仍有效的签名下载 URL。

每项证据应记录：

- 官方文档标题、版本、发布日期和页面地址，或平台页面名称。
- 适用环境、区域、账号和模型版本。
- 脱敏请求与响应，保留 HTTP 方法、路径、状态码、Header 名和 JSON 字段结构。
- 服务商口头确认的人员、时间和问题原文；后续应尽量补成书面依据。

状态标记：

- `[x]`：当前本地 SDK 源码或 demo 已提供部分证据，仍需阅读备注。
- `[ ]`：`TODO_CONFIRM`，扩展对应真实能力或提高协议保证前需补齐。

## 2. 接口与身份认证

- [x] 真实 Demo 确认当前 AICC Base URL 必须包含 `/api/v3`；`TODO_CONFIRM` 测试/生产环境、区域差异和版本策略。
- [x] SDK 源码使用 Bearer API Key；`TODO_CONFIRM` 官方鉴权文档、Key 权限、轮换和过期规则。
- [ ] `TODO_CONFIRM` 是否要求项目 ID、租户 ID、签名 Header、固定出口 IP、代理或自定义 CA。
- [x] 真实 Demo 使用 `doubao-seedance-2.0`，模型映射返回 200 且 endpoint 有效；`TODO_CONFIRM` 长期权限和版本退役策略。
- [x] SDK 使用 `POST /mapping/query` 查询模型映射；`TODO_CONFIRM` 响应完整 schema 和失败策略。
- [ ] `TODO_CONFIRM` 无 Python SDK 的普通 HTTP 调用是否被官方支持。
- [ ] `TODO_CONFIRM` 若支持直接 HTTP，提供完整 AICC/机密通道协议或官方兼容库。

需要的证据：模型开通页面截图（隐藏账号和密钥）、鉴权文档、Base URL 文档、模型映射脱敏响应。

## 3. 创建任务

- [x] SDK 使用 `POST /contents/generations/tasks`；`TODO_CONFIRM` 正式请求/响应 schema。
- [x] demo 展示 `content`、`generate_audio`、`ratio`、`duration`、`watermark`；`TODO_CONFIRM` 必填性、默认值和约束。
- [x] 纯文真实 Demo 已验证最小请求和顶层非空 `id` 成功响应；`TODO_CONFIRM` 正式完整 schema。
- [x] 单张 JPEG 图生视频已完成一次最小请求和脱敏成功链路；`TODO_CONFIRM` 正式 schema
      与其他图片参数范围。
- [ ] `TODO_CONFIRM` 提示词长度、语言、负向提示词和内容组合规则。
- [ ] `TODO_CONFIRM` 分辨率、比例、时长、帧率字段名、类型、单位、范围和枚举。
- [x] SDK 1.0.0 确认单参考视频使用 `video_url.url`、`reference_video`，并自动加入
      `Input-Has-Video: true`；首尾帧、多视频和组合语义仍 `TODO_CONFIRM`。
- [x] 真实 Demo 验证 HTTP 200 顶层 `id`；`TODO_CONFIRM` 其他成功状态和完整约束。
- [ ] `TODO_CONFIRM` 是否支持幂等键或按客户端请求 ID 查询，及超时后的安全恢复方式。

需要的证据：官方参数表；纯文生视频和图生视频各一份脱敏请求/响应；参数校验失败样例；幂等说明。

## 4. 素材提交

- [x] demo 只展示图片、视频和音频 URL。
- [x] Console 已实现单张 PNG/JPEG 的 EOS 预签名发布及 fixture E2E，并完成一次真实
      JPEG Provider 拉取与图生视频验收；这不扩展为其他格式、数量或组合的协议保证。
- [x] Console 已实现单段 MP4 的本地 ffprobe 校验、私有 EOS 发布、限时 GET URL、
      `video_url/reference_video` 映射和终态清理；真实视频生视频尚未授权或执行。
- [ ] `TODO_CONFIRM` URL 是否必须公网可访问，是否支持短期签名 URL 和允许的协议/host。
- [ ] `TODO_CONFIRM` 是否支持 Base64、`file_id`、multipart 或独立上传接口。
- [ ] `TODO_CONFIRM` 私有对象存储的授权方式和 URL 最短有效期。
- [ ] `TODO_CONFIRM` 图片格式、MIME、大小、分辨率和数量限制。
- [ ] 公开资料可参考 MP4/MOV、单段 2–15 秒、总长不超过 15 秒、最多 3 段及
      480p/720p/1080p/4K；当前 AICC 租户正式限制、编码、大小和帧率仍 `TODO_CONFIRM`。
- [ ] `TODO_CONFIRM` 音频格式、编码、大小、采样率、声道、时长和数量限制。

需要的证据：素材规范页面截图或文档；独立上传接口说明；各素材类型的脱敏有效/无效请求样例。

## 5. 查询、状态和取消

- [x] SDK 使用 `GET /contents/generations/tasks/{task_id}`；`TODO_CONFIRM` 完整响应 schema。
- [x] 源码/示例出现 `pending`、`queued`、`running`、`succeeded`、`failed`。
- [ ] `TODO_CONFIRM` 完整状态集合、大小写、含义、终态和允许流转。
- [ ] `TODO_CONFIRM` 查询频率、推荐轮询间隔、最长处理时间、404 和任务过期语义。
- [x] 真实 Demo 已验证处理中和成功响应；`TODO_CONFIRM` 普通失败与审核失败响应。
- [x] SDK 提供 `DELETE /contents/generations/tasks/{task_id}`。
- [ ] `TODO_CONFIRM` DELETE 是删除还是取消、允许状态、重复调用、竞态和最终状态。
- [ ] `TODO_CONFIRM` 取消是否收费、是否保留输出、任务成功与取消同时发生时如何判定。
- [ ] `TODO_CONFIRM` 是否支持 Webhook；若支持，需补事件、签名、重放防护、重试和顺序语义。

需要的证据：任务状态文档；四类查询响应；取消/删除官方说明和脱敏响应；Webhook 文档。

## 6. 成功输出与下载

- [x] SDK 查询成功后读取 `content.video_url`。
- [x] SDK 对视频 URL 发起流式 GET，且可解密带 `x-tos-meta-enc-dek` 的文件。
- [x] 真实 Demo 已验证 `content.video_url`、SDK 下载/解密和 MP4 输出；`TODO_CONFIRM` 完整媒体元数据与多输出语义。
- [ ] `TODO_CONFIRM` 视频 URL 是否需要 API 鉴权或仅依赖签名，允许 host 和重定向规则。
- [ ] `TODO_CONFIRM` 视频 URL 有效期、刷新方式和任务记录保留期。
- [ ] `TODO_CONFIRM` 下载 Content-Type、Content-Length、最大文件大小、校验和与 Range 支持。
- [ ] `TODO_CONFIRM` 文件加密是否强制、密钥轮换和历史视频解密要求。

需要的证据：脱敏成功查询响应（签名参数整体替换为占位符）、下载响应 Header、URL TTL 和加密说明。

## 7. 失败、重试和限流

- [ ] `TODO_CONFIRM` 创建、查询、取消和下载的失败响应 schema。
- [ ] `TODO_CONFIRM` 完整业务错误码表和对应 HTTP 状态。
- [ ] `TODO_CONFIRM` 参数、鉴权、素材、审核、配额、任务不存在和服务故障样例。
- [ ] `TODO_CONFIRM` 429 的限流 Header、`Retry-After` 和重试规则。
- [ ] `TODO_CONFIRM` 哪些 5xx 可重试、退避上限和最大次数。
- [ ] `TODO_CONFIRM` 创建请求超时或 5xx 后是否可能已经计费/创建，如何查重。
- [ ] `TODO_CONFIRM` 账号、模型和区域的 QPS、并发任务、队列、日/月配额。

需要的证据：错误码文档；429 和代表性 4xx/5xx 脱敏响应；限流与重试政策。

## 8. 用量、费用和审核

- [ ] `TODO_CONFIRM` Token、用量、计费数量、单位、币种和费用字段路径。
- [ ] `TODO_CONFIRM` 用量何时最终确定、失败/取消/审核拒绝是否计费。
- [ ] `TODO_CONFIRM` 费用是预估还是实付、精度和税费语义。
- [ ] `TODO_CONFIRM` 内容审核发生阶段、失败状态/错误码和可展示消息。
- [ ] `TODO_CONFIRM` 审核失败后是否允许安全重试，以及如何避免重复计费。

需要的证据：计费规则页面截图、成功/失败/取消的脱敏用量响应、内容安全错误说明。

## 9. AICC、数据安全与 SDK 运维

- [x] SDK 源码使用 `/v1/security/token` 和 `X-AICC-Encryption-*` Header 建立机密请求通道。
- [x] SDK 可请求 `RSA_OAEP_4096_AES_256` 视频文件加密。
- [ ] `TODO_CONFIRM` AICC/机密计算是否强制、覆盖哪些数据和调用阶段。
- [ ] `TODO_CONFIRM` 远程证明验证、信任根、失败语义和协议版本兼容策略。
- [ ] `TODO_CONFIRM` 数据驻留、服务端保留、训练使用、删除和合规说明。
- [ ] `TODO_CONFIRM` SDK wheel 是否允许进入私有镜像或制品库。
- [ ] `TODO_CONFIRM` SDK 官方下载、签名、校验和更新渠道。
- [ ] `TODO_CONFIRM` 官方支持的 Python、Linux 和 CPU 架构。
- [ ] `TODO_CONFIRM` SDK 日志关闭、日志级别和脱敏配置。
- [ ] `TODO_CONFIRM` SDK 调用超时、线程/进程安全和客户端复用要求。

需要的证据：AICC/机密计算白皮书或官方说明、SDK 发布页/授权说明、支持矩阵和日志配置文档。

## 10. 后续协议扩展所需脱敏样例包

为扩展参考素材、错误分类、取消和计费能力，建议继续提供以下材料：

1. 模型开通页面截图，隐藏账号、余额、Key 和其他个人信息。
2. 官方接口目录或文档页面截图，包含 Base URL、鉴权、创建、查询和取消/删除。
3. 一份纯文生视频创建请求与成功响应。
4. 一份图生视频创建请求与成功响应。
5. 查询处理中、成功、普通失败、审核失败各一份响应。
6. 429、参数错误、鉴权错误和代表性 5xx 响应。
7. 成功下载响应 Header；完整签名 URL 必须替换为占位符。
8. 参数范围、素材限制、状态枚举、错误码、并发/限流和计费页面。

所有样例应使用非敏感测试内容，并将以下值整体替换：

```text
Authorization: Bearer <REDACTED>
API Key: <REDACTED>
providerTaskId: <REDACTED_TASK_ID>
signed video URL: <REDACTED_SIGNED_URL>
asset URL: <REDACTED_ASSET_URL>
```
