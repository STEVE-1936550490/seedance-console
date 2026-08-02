"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  ParameterDefinition,
  ProviderCapabilities
} from "@seedance/seedance-provider";
import type { TaskDto } from "@seedance/shared";

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";

const terminalStatuses = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "RECONCILIATION_REQUIRED"
]);

interface UploadedAsset {
  id: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  kind: "image" | "video";
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  codec: string | null;
  frameRate: string | null;
  hasAudio: boolean | null;
}

export default function StudioPage() {
  const [capabilities, setCapabilities] = useState<ProviderCapabilities | null>(
    null
  );
  const [model, setModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [assets, setAssets] = useState<UploadedAsset[]>([]);
  const [task, setTask] = useState<TaskDto | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [clock, setClock] = useState(0);

  const selectedModel = capabilities?.models.find((item) => item.id === model);
  const primaryParameters =
    selectedModel?.parameters.filter((item) => item.group === "primary") ?? [];
  const advancedParameters =
    selectedModel?.parameters.filter((item) => item.group === "advanced") ?? [];
  const maxReferenceImages = capabilities?.maxReferenceImages ?? 0;
  const maxReferenceVideos = capabilities?.maxReferenceVideos ?? 0;
  const acceptedImageTypes =
    capabilities?.provider === "seedance"
      ? "image/jpeg,image/png"
      : "image/jpeg,image/png,image/webp";

  const loadTask = useCallback(async (taskId: string) => {
    const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, {
      cache: "no-store"
    });
    if (!response.ok) {
      if (response.status === 404) {
        window.localStorage.removeItem("seedance:lastTaskId");
        return;
      }
      throw new Error("无法读取任务状态。");
    }
    setTask((await response.json()) as TaskDto);
  }, []);

  useEffect(() => {
    void fetch(`${apiUrl}/api/providers/capabilities`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("无法加载模型能力。");
        }
        return (await response.json()) as ProviderCapabilities;
      })
      .then((nextCapabilities) => {
        setCapabilities(nextCapabilities);
        const firstModel = nextCapabilities.models[0];
        if (firstModel !== undefined) {
          setModel(firstModel.id);
          setParameters(defaultParameters(firstModel.parameters));
        }
      })
      .catch((error: unknown) => {
        setFormError(
          error instanceof Error ? error.message : "模型能力加载失败。"
        );
      });

    const queryTaskId = new URLSearchParams(window.location.search).get("task");
    const persistedTaskId =
      queryTaskId ?? window.localStorage.getItem("seedance:lastTaskId");
    if (persistedTaskId !== null) {
      void loadTask(persistedTaskId).catch(() => undefined);
    }
  }, [loadTask]);

  useEffect(() => {
    if (task === null || terminalStatuses.has(task.status)) {
      return;
    }
    const poller = window.setInterval(
      () => void loadTask(task.id).catch(() => undefined),
      1_500
    );
    return () => window.clearInterval(poller);
  }, [loadTask, task]);

  useEffect(() => {
    if (task === null || terminalStatuses.has(task.status)) {
      return;
    }
    const clock = window.setInterval(
      () => setClock((value) => value + 1),
      1_000
    );
    return () => window.clearInterval(clock);
  }, [task]);

  const elapsed = useMemo(
    () =>
      task === null ? null : formatElapsed(task.createdAt, task.completedAt),
    [clock, task]
  );

  function selectModel(nextModelId: string) {
    setModel(nextModelId);
    const nextModel = capabilities?.models.find(
      (item) => item.id === nextModelId
    );
    setParameters(
      nextModel === undefined ? {} : defaultParameters(nextModel.parameters)
    );
  }

  async function uploadImages(files: FileList | null) {
    if (files === null || files.length === 0) {
      return;
    }
    setUploading(true);
    setFormError(null);
    try {
      if (maxReferenceImages === 0) {
        throw new Error("当前 Provider 不支持参考图片。");
      }
      if (assets.length + files.length > maxReferenceImages) {
        throw new Error(`最多只能添加 ${maxReferenceImages} 张参考图片。`);
      }
      const uploaded: UploadedAsset[] = [];
      for (const file of Array.from(files)) {
        if (!acceptedImageTypes.split(",").includes(file.type)) {
          throw new Error(`${file.name} 的图片格式不受当前 Provider 支持。`);
        }
        const body = new FormData();
        body.append("file", file);
        const response = await fetch(`${apiUrl}/api/assets`, {
          method: "POST",
          body
        });
        if (!response.ok) {
          throw new Error(`${file.name} 上传失败。`);
        }
        uploaded.push((await response.json()) as UploadedAsset);
      }
      setAssets((current) =>
        [...current, ...uploaded].slice(0, maxReferenceImages)
      );
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "素材上传失败。");
    } finally {
      setUploading(false);
    }
  }

  async function uploadVideo(files: FileList | null) {
    const file = files?.[0];
    if (file === undefined) return;
    setUploading(true);
    setFormError(null);
    try {
      if (maxReferenceVideos === 0) {
        throw new Error("当前 Provider 不支持参考视频。");
      }
      if (assets.some((asset) => asset.kind === "video")) {
        throw new Error("当前 MVP 只允许一段参考视频。");
      }
      if (capabilities?.provider === "seedance" && assets.length > 0) {
        throw new Error("当前 Seedance MVP 只允许一项参考图片或视频。");
      }
      if (
        file.type !== "video/mp4" ||
        !file.name.toLowerCase().endsWith(".mp4")
      ) {
        throw new Error("当前 MVP 只接受扩展名与 MIME 均为 MP4 的视频。");
      }
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(`${apiUrl}/api/assets`, {
        method: "POST",
        body
      });
      const result = (await response.json()) as
        UploadedAsset | { error: string };
      if (!response.ok || !("id" in result)) {
        throw new Error(
          `视频上传失败：${"error" in result ? result.error : "UNKNOWN"}`
        );
      }
      setAssets((current) => [...current, result]);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "视频上传失败。");
    } finally {
      setUploading(false);
    }
  }

  async function createTask() {
    if (prompt.trim().length === 0 || model.length === 0) {
      setFormError("请选择模型并填写提示词。");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const response = await fetch(`${apiUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId: crypto.randomUUID(),
          model,
          prompt,
          assetIds: assets.map((asset) => asset.id),
          parameters
        })
      });
      const body = (await response.json()) as
        TaskDto | { error: string; message?: string };
      if (!response.ok || !("id" in body)) {
        throw new Error(
          "message" in body && body.message !== undefined
            ? body.message
            : `任务创建失败：${"error" in body ? body.error : "UNKNOWN"}`
        );
      }
      window.localStorage.setItem("seedance:lastTaskId", body.id);
      setTask(body);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "任务创建失败。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="studioPage">
      <section className="studioIntro">
        <div>
          <p className="eyebrow">VIDEO GENERATION WORKSPACE</p>
          <h1>从想法到画面</h1>
        </div>
        <p>
          当前使用 {capabilities?.label ?? "后端 Provider"}
          。全部任务请求由后端处理， 页面不会直接连接模型服务。
        </p>
      </section>

      <div className="studioGrid">
        <section className="creatorPanel">
          <PanelHeading index="01" title="创作参数" note="能力驱动" />

          <div className="field">
            <label htmlFor="model">模型选择</label>
            <select
              id="model"
              value={model}
              onChange={(event) => selectModel(event.target.value)}
              disabled={capabilities === null}
            >
              {capabilities?.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <small>{selectedModel?.description ?? "正在读取模型能力…"}</small>
          </div>

          <div className="field">
            <div className="labelRow">
              <label htmlFor="prompt">提示词</label>
              <span>{prompt.length} / 5000</span>
            </div>
            <textarea
              id="prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={5_000}
              placeholder="描述镜头、主体、动作、环境与整体氛围…"
              rows={8}
            />
          </div>

          <div className="field">
            <label>参考素材</label>
            <label className="uploadZone">
              <input
                type="file"
                accept={acceptedImageTypes}
                multiple={maxReferenceImages > 1}
                disabled={
                  uploading ||
                  maxReferenceImages === 0 ||
                  assets.length >= maxReferenceImages
                }
                onChange={(event) => void uploadImages(event.target.files)}
              />
              <span className="uploadIcon">＋</span>
              <strong>{uploading ? "正在上传…" : "添加参考图片"}</strong>
              <small>
                {capabilities?.provider === "seedance"
                  ? "JPG 或 PNG"
                  : "JPG、PNG 或 WebP"}
                ，最多 {maxReferenceImages} 张，单文件最大 10MB
              </small>
            </label>
            {maxReferenceVideos > 0 && (
              <label className="uploadZone">
                <input
                  type="file"
                  accept="video/mp4,.mp4"
                  disabled={
                    uploading ||
                    assets.some((asset) => asset.kind === "video") ||
                    (capabilities?.provider === "seedance" && assets.length > 0)
                  }
                  onChange={(event) => void uploadVideo(event.target.files)}
                />
                <span className="uploadIcon">▶</span>
                <strong>{uploading ? "正在检查…" : "添加参考视频"}</strong>
                <small>MP4，2–15 秒；大小受本地上传安全策略限制</small>
              </label>
            )}
            {assets.length > 0 && (
              <div className="assetList">
                {assets.map((asset) => (
                  <div className="assetChip" key={asset.id}>
                    <span>
                      {asset.kind === "video" ? "视频 · " : "图片 · "}
                      {asset.originalName}
                      {asset.durationSeconds === null
                        ? ""
                        : ` · ${asset.durationSeconds.toFixed(2)} 秒`}
                    </span>
                    <button
                      type="button"
                      aria-label={`移除 ${asset.originalName}`}
                      onClick={() =>
                        setAssets((current) =>
                          current.filter((item) => item.id !== asset.id)
                        )
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="parameterGrid">
            {primaryParameters.map((definition) => (
              <DynamicParameter
                key={definition.key}
                definition={definition}
                value={parameters[definition.key]}
                onChange={(value) =>
                  setParameters((current) => ({
                    ...current,
                    [definition.key]: value
                  }))
                }
              />
            ))}
          </div>

          <details className="advancedParameters">
            <summary>
              <span>其他参数</span>
              <small>按模型能力动态显示</small>
            </summary>
            <div className="advancedBody">
              {advancedParameters.map((definition) => (
                <DynamicParameter
                  key={definition.key}
                  definition={definition}
                  value={parameters[definition.key]}
                  onChange={(value) =>
                    setParameters((current) => ({
                      ...current,
                      [definition.key]: value
                    }))
                  }
                />
              ))}
            </div>
          </details>

          {formError !== null && <div className="formError">{formError}</div>}

          <button
            className="generateButton"
            type="button"
            onClick={() => void createTask()}
            disabled={submitting || capabilities === null}
          >
            <span>{submitting ? "正在提交" : "生成视频"}</span>
            <span aria-hidden="true">↗</span>
          </button>
        </section>

        <section className="resultPanel">
          <PanelHeading
            index="02"
            title="生成结果"
            note={task?.id ?? "尚无任务"}
          />
          <TaskResult task={task} elapsed={elapsed} />
        </section>
      </div>
    </main>
  );
}

function PanelHeading({
  index,
  title,
  note
}: {
  index: string;
  title: string;
  note: string;
}) {
  return (
    <div className="panelHeading">
      <div>
        <span>{index}</span>
        <h2>{title}</h2>
      </div>
      <small>{note}</small>
    </div>
  );
}

function DynamicParameter({
  definition,
  value,
  onChange
}: {
  definition: ParameterDefinition;
  value: unknown;
  onChange(value: unknown): void;
}) {
  if (definition.type === "boolean") {
    return (
      <label className="toggleField">
        <span>
          <strong>{definition.label}</strong>
          <small>{definition.description}</small>
        </span>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    );
  }

  return (
    <div className="field compactField">
      <label htmlFor={`parameter-${definition.key}`}>{definition.label}</label>
      <select
        id={`parameter-${definition.key}`}
        value={
          typeof value === "string" || typeof value === "number"
            ? String(value)
            : String(definition.defaultValue)
        }
        onChange={(event) => {
          const option = definition.options.find(
            (item) => String(item.value) === event.target.value
          );
          onChange(option?.value ?? definition.defaultValue);
        }}
      >
        {definition.options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
      <small>{definition.description}</small>
    </div>
  );
}

function TaskResult({
  task,
  elapsed
}: {
  task: TaskDto | null;
  elapsed: string | null;
}) {
  if (task === null) {
    return (
      <div className="emptyResult">
        <div className="emptyOrb">
          <span />
        </div>
        <h3>准备生成</h3>
        <p>填写左侧参数并提交任务，结果将在这里自动更新。</p>
      </div>
    );
  }

  if (task.status === "FAILED" || task.status === "RECONCILIATION_REQUIRED") {
    return (
      <div className="taskState stateFailed">
        <StatusHeader task={task} elapsed={elapsed} />
        <div className="errorResult">
          <span>!</span>
          <div>
            <strong>{task.errorCode ?? "GENERATION_FAILED"}</strong>
            <p>{task.errorMessage ?? "任务执行失败。"}</p>
          </div>
        </div>
      </div>
    );
  }

  if (task.status === "SUCCEEDED" && task.hasVideo) {
    return (
      <div className="taskState stateSucceeded">
        <StatusHeader task={task} elapsed={elapsed} />
        <div className="videoFrame">
          <video
            key={task.id}
            controls
            playsInline
            preload="metadata"
            src={`${apiUrl}/api/tasks/${task.id}/video`}
          >
            浏览器不支持视频播放。
          </video>
          <span className="mockWatermark">MOCK OUTPUT</span>
        </div>
        <div className="resultActions">
          <div>
            <strong>{task.model}</strong>
            <span>
              {String(task.parameters.resolution)} ·{" "}
              {String(task.parameters.duration)} 秒
            </span>
          </div>
          <a href={`${apiUrl}/api/tasks/${task.id}/download`}>下载视频 ↓</a>
        </div>
      </div>
    );
  }

  return (
    <div className="taskState stateWorking">
      <StatusHeader task={task} elapsed={elapsed} />
      <div className="workingVisual">
        <div className="scanFrame">
          <span className="scanLine" />
          <div className="frameGrid" />
        </div>
        <h3>{workingMessage(task.status)}</h3>
        <p>
          Provider
          未返回进度百分比。页面仅显示真实状态与已等待时间，并会自动轮询。
        </p>
      </div>
    </div>
  );
}

function StatusHeader({
  task,
  elapsed
}: {
  task: TaskDto;
  elapsed: string | null;
}) {
  return (
    <div className="statusHeader">
      <div>
        <span className={`statusPill status-${task.status.toLowerCase()}`}>
          <i />
          {statusLabel(task.status)}
        </span>
        <code>{task.id}</code>
      </div>
      <span>已等待 {elapsed ?? "0秒"}</span>
    </div>
  );
}

function defaultParameters(
  definitions: readonly ParameterDefinition[]
): Record<string, unknown> {
  return Object.fromEntries(
    definitions.map((definition) => [definition.key, definition.defaultValue])
  );
}

function statusLabel(status: TaskDto["status"]): string {
  const labels: Record<TaskDto["status"], string> = {
    DRAFT: "草稿",
    QUEUED: "排队中",
    SUBMITTING: "正在提交",
    RECONCILIATION_REQUIRED: "需要人工对账",
    PROCESSING: "生成中",
    SUCCEEDED: "已完成",
    FAILED: "失败",
    CANCELLED: "已取消",
    EXPIRED: "已过期"
  };
  return labels[status];
}

function workingMessage(status: TaskDto["status"]): string {
  if (status === "QUEUED") return "任务正在等待 Worker";
  if (status === "SUBMITTING") return "正在提交到 Mock Provider";
  if (status === "RECONCILIATION_REQUIRED")
    return "已停止自动提交，等待人工对账";
  return "Mock Provider 正在生成视频";
}

function formatElapsed(createdAt: string, completedAt: string | null): string {
  const end =
    completedAt === null ? Date.now() : new Date(completedAt).getTime();
  const seconds = Math.max(
    0,
    Math.floor((end - new Date(createdAt).getTime()) / 1_000)
  );
  if (seconds < 60) return `${seconds}秒`;
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}
