# Provider Adapter 设计

## 1. 目标与边界

`SeedanceProvider` 隔离供应商协议与内部任务模型。API、Worker、数据库和 UI 不读取
真实 Seedance 响应字段，也不自行解释供应商状态。Mock Provider 与基于私有 AICC
Bridge 的真实实现均已完成；真实实现只开放当前协议证据和一次真实 Demo 已验证的
纯文本参数范围。

本文代码是内部契约草案，其中 `prompt`、参考素材和不透明 `parameters` 是控制台领域输入，并非对 Seedance 2.0 请求字段的声明。

## 2. 接口草案

```ts
type ProviderName = "mock" | "seedance-2";
type ProviderTransport = "mock" | "maas-sdk" | "direct-http";
type ProviderTaskStatus =
  | "SUBMITTING"
  | "PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "EXPIRED";

interface ProviderInputAsset {
  assetId: string;
  mimeType: string;
  sizeBytes: number;
  openStream(): Promise<NodeJS.ReadableStream>;
}

interface CreateTaskInput {
  clientRequestId: string;
  prompt: string;
  referenceImages: readonly ProviderInputAsset[];
  parameters: Readonly<Record<string, unknown>>;
}

interface ProviderTaskSnapshot {
  providerTaskId: string;
  status: ProviderTaskStatus;
  progress?: number;
  outputs: readonly ProviderOutput[];
  error?: ProviderError;
  usage: readonly ProviderUsage[];
  sanitizedResponse?: unknown;
}

interface ProviderOutput {
  kind: "video";
  mimeType?: string;
  openStream(): Promise<NodeJS.ReadableStream>;
}

interface ProviderError {
  code: string;
  message: string;
  retryable: boolean;
}

interface ProviderUsage {
  metric: string;
  quantity: string;
  unit: string;
  raw?: unknown;
}

type ValidationResult =
  | { ok: true; value: Readonly<Record<string, unknown>> }
  | { ok: false; issues: readonly { path: string; message: string }[] };

interface SeedanceProvider {
  readonly name: ProviderName;
  getCapabilities(): Promise<ProviderCapabilities>;
  validateParameters(parameters: unknown): ValidationResult;
  createTask(input: CreateTaskInput): Promise<ProviderTaskSnapshot>;
  getTask(providerTaskId: string): Promise<ProviderTaskSnapshot>;
  cancelTask(providerTaskId: string): Promise<ProviderTaskSnapshot>;
  normalizeStatus(rawStatus: unknown): ProviderTaskStatus;
  calculateUsage(rawResponse: unknown): readonly ProviderUsage[];
}
```

`ProviderCapabilities` 由受版本控制的适配器 schema 生成，描述已确认的输入类型、参数 schema 和是否支持取消等能力。真实字段未确认时返回“不支持/无字段”，不能以常见视频 API 经验补齐。

Provider 名称与 transport 分开配置：`maas-sdk` 通过内网 Python Bridge 使用私有 SDK；`direct-http` 由 Worker 原生调用。两种真实 transport 必须通过同一套契约测试。机密通道协议未确认前，`direct-http` 应启动失败，不能静默发送明文请求；详细依据见 `docs/provider-api.md`。

## 3. 责任划分

适配器负责：

- 将内部输入转换为 Provider 请求并校验 Provider 响应。
- 设置认证、超时、关联 ID，以及文档明确允许的幂等与重试策略。
- 将原始状态、错误和用量规范化。
- 对请求/响应生成脱敏调试摘要。
- 按 Provider 协议上传素材或提供输出流。

调用方负责：

- 从 Storage 解析安全的输入素材流，并保存输出流。
- 驱动内部状态机、调度轮询、保存数据库记录。
- 实施业务级访问控制、任务幂等和文件生命周期。

适配器不得直接更新 `VideoTask`，不得向浏览器返回原始响应，也不得记录 API Key、Authorization、完整提示词、二进制内容或带长期凭证的 URL。

## 4. 错误模型

Provider 实现只抛出受控错误类型：

- `ProviderValidationError`：输入或响应不符合已确认 schema，不重试。
- `ProviderAuthenticationError`：认证失败，不重试并触发运维告警。
- `ProviderRateLimitError`：是否重试及等待时间取自响应与文档。
- `ProviderTransientError`：明确可安全重试的网络/服务错误。
- `ProviderOutcomeUnknownError`：创建结果不明，禁止无条件重发。
- `ProviderUnsupportedOperationError`：例如 Provider 不支持取消。

对外 API 将其映射为稳定内部错误码；用户消息不得泄露供应商凭据、内部地址或原始响应。

## 5. Mock Provider

Mock 实现必须：

- 仅依赖内存或可持久化测试存根，不发起外部网络请求。
- 以 `clientRequestId` 幂等创建任务。
- 支持确定性的 `success`、`failure`、`slow` 测试场景。
- 返回仓库自有或明确授权的短视频 fixture。
- 模拟至少一次 `PROCESSING`，并提供无用量、带用量两类测试数据。
- 对未知参数报验证错误；Mock 参数放在独立 schema 中，明确标记为测试专用。

单元测试覆盖创建幂等、所有状态映射、错误分类、取消能力、用量为空和响应校验。
契约测试约束 Mock 与 Seedance fake Bridge runtime；唯一真实 Demo 另行验证 AICC
create、poll、download 和持久化闭环，不作为日常自动化测试依赖。

## 6. 真实 Provider 剩余协议清单

纯文生视频最小闭环已经完成。以下扩展能力仍需按 `docs/provider-api.md` 逐项确认：

- Base URL、认证方式、密钥轮换和请求头。
- 创建/查询/取消端点及准确字段。
- 模型标识、参数类型、默认值、范围和组合限制。
- 参考图片的格式、数量、大小及传输方式。
- Provider 状态全集、进度语义、错误结构。
- 输出 URL 的有效期、下载认证和文件校验方式。
- 幂等键、超时后查询、限流、重试和回调能力。
- 用量字段、单位及其是否可能缺失。

任何缺项以 TODO 和待确认问题保留，不以假设实现。
