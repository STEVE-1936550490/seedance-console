# Seedance Provider 字段映射

## 1. 映射规则

本文只映射 `docs/provider-api.md` 已确认的字段。`TODO_CONFIRM` 字段不进入初始请求、不暴露为 UI 选项，也不生成默认值。

映射层位于 `packages/seedance-provider` 及其可选 Bridge transport 内。前端、API 路由、业务 Worker、Prisma DTO 不读取以下 Provider 原始字段：

- `content`
- `image_url`
- `video_url`
- `audio_url`
- `generate_audio`
- Provider 原始 `status`
- Provider 原始 `error`

## 2. 系统内部创建任务参数

建议真实 Provider 使用独立参数类型，不复用 `MockParameters`：

```ts
interface SeedanceParameters {
  ratio: string;
  duration: number;
  generateAudio: boolean;
  watermark: boolean;
}
```

初始 capabilities 只能暴露当前材料已经出现的字段和值，并要求四个参数显式存在；这样既不猜默认值，也不会发出 demo 从未展示过的缺字段请求：

| 内部字段          | 类型      | 当前可用于设计的值                                      | 说明                                                       |
| ----------------- | --------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `model`           | string    | 由 `SEEDANCE_MODEL_ID` 提供                             | demo 模型名只是示例，不硬编码为生产模型                    |
| `prompt`          | string    | 非空字符串                                              | Provider 文本长度上限 `TODO_CONFIRM`；保留当前平台自身校验 |
| `assets[].role`   | enum      | `REFERENCE_IMAGE`、`REFERENCE_VIDEO`、`REFERENCE_AUDIO` | 当前数据库/UI 只实现图片；视频/音频是目标契约              |
| `assets[].url`    | HTTPS URL | 由 Asset Publisher 生成                                 | URL 可达性和 TTL `TODO_CONFIRM`                            |
| `ratio`           | string    | 当前仅有示例 `"16:9"`                                   | 不扩展为其他比例                                           |
| `duration`        | number    | 当前仅有示例 `11`                                       | 单位和完整范围仍为 `TODO_CONFIRM`                          |
| `generateAudio`   | boolean   | 当前示例为 `true`                                       | 默认值和限制 `TODO_CONFIRM`；初始要求显式值                |
| `watermark`       | boolean   | 当前示例为 `false`                                      | 默认值和限制 `TODO_CONFIRM`；初始要求显式值                |
| `clientRequestId` | string    | 内部唯一值                                              | 当前没有已确认的远端字段，仅用于本地提交保护               |

当前 Mock 专用字段不映射到真实 API：

| Mock 字段                   | 真实 Provider 处理                     |
| --------------------------- | -------------------------------------- |
| `scenario`                  | 删除；仅 Mock 测试使用                 |
| `includeUsage`              | 删除；真实用量只接受 Provider 明确返回 |
| Mock `resolution`           | 不映射；真实分辨率字段尚未确认         |
| Mock `duration` 字符串 `"5" | "10"`                                  | 不复用；真实示例是数字 `11`，完整范围未确认 |

## 3. 创建任务请求映射

已确认的目标请求形状：

```json
{
  "content": [
    {
      "type": "text",
      "text": "<prompt>"
    },
    {
      "type": "image_url",
      "image_url": {
        "url": "<published-asset-url>"
      },
      "role": "reference_image"
    }
  ],
  "generate_audio": true,
  "ratio": "16:9",
  "duration": 11,
  "watermark": false
}
```

SDK 会加入或覆盖 `model`。Direct transport 若未来可用，也必须按已确认协议处理模型映射，不能假定请求模型值等于最终 endpoint。

| 内部来源                    | Provider 字段                     | 转换                                                        |
| --------------------------- | --------------------------------- | ----------------------------------------------------------- |
| `model`                     | `model` / SDK 构造器 `maas_model` | Bridge 初始化使用部署模型 ID；SDK 内部映射后写请求          |
| `prompt`                    | `content[n].type`                 | 固定 `"text"`                                               |
| `prompt`                    | `content[n].text`                 | 原字符串；日志中删除                                        |
| `REFERENCE_IMAGE` asset     | `content[n].type`                 | 固定 `"image_url"`                                          |
| `REFERENCE_IMAGE` asset URL | `content[n].image_url.url`        | Asset Publisher 生成的 Provider 可访问 URL                  |
| `REFERENCE_IMAGE` role      | `content[n].role`                 | 固定 `"reference_image"`                                    |
| `REFERENCE_VIDEO` asset     | `content[n].type`                 | 固定 `"video_url"`                                          |
| `REFERENCE_VIDEO` asset URL | `content[n].video_url.url`        | Asset Publisher 生成的 URL                                  |
| `REFERENCE_VIDEO` role      | `content[n].role`                 | 固定 `"reference_video"`                                    |
| `REFERENCE_AUDIO` asset     | `content[n].type`                 | 固定 `"audio_url"`                                          |
| `REFERENCE_AUDIO` asset URL | `content[n].audio_url.url`        | Asset Publisher 生成的 URL                                  |
| `REFERENCE_AUDIO` role      | `content[n].role`                 | 固定 `"reference_audio"`                                    |
| `parameters.generateAudio`  | `generate_audio`                  | camelCase 转 snake_case；初始值必须显式通过 capability 校验 |
| `parameters.ratio`          | `ratio`                           | 字符串原值；仅允许 capability manifest 已确认值             |
| `parameters.duration`       | `duration`                        | number 原值；当前仅允许已确认示例值                         |
| `parameters.watermark`      | `watermark`                       | camelCase 转 snake_case；初始值必须显式通过 capability 校验 |
| `clientRequestId`           | 无已确认字段                      | 只用于本地/Bridge 提交注册表，不发送未知字段                |

字段顺序不作为协议语义。`content` 项顺序和组合约束仍为 `TODO_CONFIRM`；初始实现维持确定性顺序：文本、参考图片、参考视频、参考音频，同类按 `position` 排序。

### 3.1 不得发送的字段

以下字段尚无确认依据：

- `resolution`
- `fps` / `frame_rate`
- `seed`
- `negative_prompt`
- `callback_url`
- `idempotency_key`
- 任意推测的费用、优先级或 service tier 字段

## 4. 创建任务响应映射

Direct HTTP 已确认在 HTTP 200 响应读取顶层 `id`；Python SDK 对外返回 task ID 字符串。

| Transport 原始值            | Adapter 字段                         | 校验与处理                          |
| --------------------------- | ------------------------------------ | ----------------------------------- |
| HTTP JSON `id`              | `ProviderTaskCreated.providerTaskId` | 必须是非空字符串                    |
| SDK 返回字符串              | `ProviderTaskCreated.providerTaskId` | 必须是非空字符串                    |
| HTTP request/correlation ID | `debug.providerRequestId`            | 字段位置 `TODO_CONFIRM`；当前不读取 |
| 其他响应字段                | 无                                   | 丢弃，不传业务层                    |

建议最小 Direct schema：

```ts
const createResponseSchema = z.object({
  id: z.string().min(1)
});
```

SDK 返回空字符串时不能形成有效 task ID。由于 SDK 可能在非 200 时丢失错误细节，Adapter 返回 `ProviderOutcomeUnknownError`，不得自动再次创建。

## 5. 查询任务请求映射

| 内部输入          | Provider 请求                               | 转换                         |
| ----------------- | ------------------------------------------- | ---------------------------- |
| `providerTaskId`  | `GET /contents/generations/tasks/{task_id}` | path segment 必须 URL encode |
| `providerTaskId`  | SDK `query_video_generation_task(task_id)`  | 原非空字符串                 |
| `clientRequestId` | 无                                          | 查询接口无已确认映射         |
| 本地 task ID      | 无                                          | 不发送给 Provider            |

轮询 job 只携带本地 task ID；Worker 从 PostgreSQL 读取 `providerTaskId` 后调用 Adapter。

## 6. 查询任务响应映射

已确认最小形状：

```json
{
  "status": "succeeded",
  "content": {
    "video_url": "<download-url>"
  },
  "error": "<unknown-shape>"
}
```

建议最小 schema 只挑选已确认字段，丢弃未知字段：

```ts
const queryResponseSchema = z.object({
  status: z.string().min(1),
  content: z
    .object({
      video_url: z.string().url().optional()
    })
    .optional(),
  error: z.unknown().optional()
});
```

| Provider 字段       | Adapter 字段                 | 规则                                        |
| ------------------- | ---------------------------- | ------------------------------------------- |
| `status`            | `debug.providerStatus`       | 只保留短、转义后的允许值；不返回前端        |
| `status`            | `status`                     | 通过 `normalizeStatus()` 映射               |
| `content.video_url` | `outputs[0].available`       | 仅当状态为 `succeeded` 且 URL 存在时为 true |
| `content.video_url` | Adapter 内部临时下载 locator | 不写数据库、不写 job、不写日志、不返回 API  |
| `error`             | `error`                      | 结构未知；只生成稳定通用错误，不透传原文    |
| 未确认的进度字段    | 无                           | 不读取、不生成 `progress`                   |
| 未确认的用量字段    | `usage`                      | 当前 `normalizeUsage()` 返回 `[]`           |

状态为 `succeeded` 但缺少合法 `content.video_url` 时返回 `ProviderProtocolError`，内部任务保持 `PROCESSING`，不得写 `SUCCEEDED`。

## 7. 服务商状态到内部状态

Provider Adapter 先将原始状态规范化，Worker 再按本地持久化阶段推进内部状态。

| Provider 原始状态 | Adapter 规范状态               | Worker 当前/目标内部状态  | 处理                                                  |
| ----------------- | ------------------------------ | ------------------------- | ----------------------------------------------------- |
| `pending`         | `PROCESSING`                   | `PROCESSING → PROCESSING` | 安排下一轮询                                          |
| `queued`          | `PROCESSING`                   | `PROCESSING → PROCESSING` | 安排下一轮询                                          |
| `running`         | `PROCESSING`                   | `PROCESSING → PROCESSING` | 安排下一轮询                                          |
| `succeeded`       | `SUCCEEDED`                    | 先保持 `PROCESSING`       | 安排下载；文件与数据库提交后 `PROCESSING → SUCCEEDED` |
| `failed`          | `FAILED`                       | `PROCESSING → FAILED`     | 保存稳定内部错误和完成时间                            |
| 未知非空字符串    | 无，抛 `ProviderProtocolError` | 保持当前非终态            | 记录脱敏值，受控重查并告警，不猜状态                  |
| 缺失/非字符串     | 无，schema/protocol error      | 保持当前非终态            | 不更新业务状态                                        |

内部本地状态不由 Provider 直接产生：

| 内部状态     | 来源                                                 |
| ------------ | ---------------------------------------------------- |
| `DRAFT`      | 本地草稿                                             |
| `QUEUED`     | API 已持久化并等待 submit job                        |
| `SUBMITTING` | Worker 获得唯一提交权，或创建结果未知                |
| `PROCESSING` | 已持久化 `providerTaskId`；也覆盖输出下载阶段        |
| `SUCCEEDED`  | 输出已持久化且数据库事务完成                         |
| `FAILED`     | Provider 明确 `failed` 或不可恢复的本地永久错误      |
| `CANCELLED`  | 提交前本地取消，或未来 Provider 明确确认取消         |
| `EXPIRED`    | 明确 Provider 过期，或达到标注清楚的本地最大轮询期限 |

Provider 尚无已确认的取消和过期原始状态，因此初始 `normalizeStatus()` 不接受推测的 `cancelled` 或 `expired`。

## 8. 视频输出地址映射

| Provider 来源                       | Adapter 行为                                                  | 持久化                                                 |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| `content.video_url`                 | 校验 URL 语法、HTTPS scheme 和 allowlist；仅在 Adapter 内使用 | 禁止保存                                               |
| SDK `download_video(task_id, path)` | Bridge 使用 providerTaskId 重新查询、下载并解密               | 只保存最终本地文件                                     |
| Adapter `downloadOutput()`          | 返回已验证流和媒体元数据                                      | Worker 写入 Storage                                    |
| Storage 确定性 key                  | `outputs/<internalTaskId>.mp4`                                | Asset 保存 storageKey、MIME、大小、可用时保存 checksum |

业务 API 的播放/下载仍读取本地 Storage，不重定向到 Provider URL。这样 Provider URL 过期不会影响已完成任务。

## 9. 用量字段映射

当前材料没有可确认的 Token、用量或费用字段：

```ts
normalizeUsage(_rawResponse: unknown): readonly ProviderUsage[] {
  return [];
}
```

规则：

- 不根据时长、分辨率、文件大小或模型估算用量。
- 不把 Mock `mock_task` 用量映射到真实 Provider。
- 不创建空的伪 UsageRecord。
- 后续确认字段后，必须补 Zod schema、精度、单位和 fixture 测试，再启用映射。

## 10. 错误码和错误信息映射

Provider 业务错误结构和完整错误码是 `TODO_CONFIRM`。初始实现只依据 transport 结果和已确认任务状态生成内部稳定错误：

| 观察结果                    | 内部错误                                                        | 创建操作                               | 查询/下载操作                     |
| --------------------------- | --------------------------------------------------------------- | -------------------------------------- | --------------------------------- |
| 参数未通过本地 schema       | `PROVIDER_INVALID_PARAMETERS`                                   | 不调用远端                             | 不适用                            |
| HTTP 429                    | `PROVIDER_RATE_LIMITED`                                         | 不自动重发，结果按是否已收到响应分类   | 允许按配置和可信 Retry-After 退避 |
| HTTP 5xx / 网络中断         | `PROVIDER_TRANSIENT_ERROR` 或 `PROVIDER_CREATE_OUTCOME_UNKNOWN` | 若无法证明未创建，进入 outcome unknown | 安全读允许退避                    |
| HTTP 非成功且非暂时类       | `PROVIDER_REQUEST_REJECTED`                                     | 不重试                                 | 默认不重试                        |
| SDK 创建返回空 ID           | `PROVIDER_CREATE_OUTCOME_UNKNOWN`                               | 不重试                                 | 不适用                            |
| 查询 `status=failed`        | `PROVIDER_TASK_FAILED`                                          | 不适用                                 | 进入内部 FAILED                   |
| 查询缺 status / schema 不符 | `PROVIDER_PROTOCOL_ERROR`                                       | 不适用                                 | 保持当前状态，受控重查/告警       |
| 未知 status                 | `PROVIDER_UNKNOWN_STATUS`                                       | 不适用                                 | 保持当前状态，受控重查/告警       |
| 成功状态无 video URL        | `PROVIDER_OUTPUT_MISSING`                                       | 不适用                                 | 不进入 SUCCEEDED                  |
| 下载 URL 过期/不可用        | `PROVIDER_OUTPUT_EXPIRED`                                       | 不适用                                 | 重新查询一次；仍失败则人工处理    |
| 下载类型/大小/签名不符      | `PROVIDER_OUTPUT_INVALID`                                       | 不适用                                 | 清理临时文件，不进入 SUCCEEDED    |
| 真实取消未确认              | `PROVIDER_CANCEL_UNSUPPORTED`                                   | 不适用                                 | 不改变远端处理中任务状态          |

`error` 原始结构未知时：

- 用户消息使用固定、安全文本。
- 日志不写完整 `error`。
- 可以记录响应 schema 版本、HTTP 状态和内部 correlation ID。
- 后续只有在 `docs/provider-api.md` 补充明确结构后才增加 Provider 业务码映射。

## 11. 未确认字段及处理策略

| `TODO_CONFIRM` 项       | 初始处理                                   | 是否阻塞核心骨架 | 是否阻塞真实联调             |
| ----------------------- | ------------------------------------------ | ---------------- | ---------------------------- |
| 完整模型 ID / endpoint  | 从环境读取，不硬编码                       | 否               | 是                           |
| ratio/duration 完整范围 | 只开放已确认示例值                         | 否               | 否，前提是部署模型接受示例值 |
| 分辨率/帧率字段         | 不发送、不展示                             | 否               | 否                           |
| 素材格式/大小限制       | 保留本地限制并将 Provider 限制视为未知     | 否               | 图生视频是                   |
| URL 公网可达性/TTL      | Asset Publisher 抽象                       | 否               | 图生视频是                   |
| Base64/file_id/上传接口 | 不实现                                     | 否               | 否，若 URL 路径可用          |
| 完整状态集合            | 只映射五个已出现状态                       | 否               | 未知状态出现时是             |
| 失败 `error` 结构       | 稳定通用错误                               | 否               | 否                           |
| Provider 错误码         | 只做 transport 分类                        | 否               | 否                           |
| 429/5xx 官方规则        | 查询采用保守本地退避，创建不重发           | 否               | 上线稳定性风险               |
| 远端幂等                | 本地提交锁、Bridge 注册表、outcome unknown | 否               | 收费环境 exactly-once 风险   |
| Webhook                 | 使用轮询                                   | 否               | 否                           |
| 远端取消                | capabilities=false                         | 否               | 否                           |
| 下载 URL 鉴权/TTL       | Adapter 内即时使用并重新查询               | 否               | 是                           |
| 用量/费用               | 返回空数组                                 | 否               | 否，但无法展示真实费用       |
| 审核失败结构            | 暂按 `failed` 通用错误                     | 否               | 否                           |
| AICC direct 协议        | 使用已确认 Python SDK Bridge               | 否               | 若不用 Bridge 则是           |

## 12. 映射测试 fixture

P3 单元测试只使用本地 fixture，不调用网络：

- create success：`{"id":"provider-task-1"}`。
- create missing ID：`{}`。
- query 每个已确认状态：`pending`、`queued`、`running`、`succeeded`、`failed`。
- succeeded with video URL。
- succeeded without video URL。
- failed with string/object/null `error`，验证都不会泄露原始值。
- unknown status。
- malformed JSON 和错误 Content-Type。
- 429、代表性 5xx 和网络超时 transport stub。
- 下载正确 MP4、错误 MIME、超大 Content-Length、截断流和错误文件签名。
- usage 始终为空。

fixture 中只使用虚构域名、虚构 task ID 和无效占位 token。
