"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import type { TaskDto, TaskListResponse } from "@seedance/shared";

const apiUrl = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ?? "";

export default function HistoryPage() {
  const [tasks, setTasks] = useState<readonly TaskDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const response = await fetch(`${apiUrl}/api/tasks`, {
        cache: "no-store"
      });
      if (!response.ok) throw new Error("任务历史加载失败。");
      const body = (await response.json()) as TaskListResponse;
      setTasks(body.tasks);
      setError(null);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : "任务历史加载失败。"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
    const timer = window.setInterval(() => void loadTasks(), 3_000);
    return () => window.clearInterval(timer);
  }, [loadTasks]);

  return (
    <main className="historyPage">
      <section className="historyHeader">
        <div>
          <p className="eyebrow">GENERATION ARCHIVE</p>
          <h1>任务历史</h1>
          <p>所有记录来自内部数据库，刷新页面不会丢失。</p>
        </div>
        <button type="button" onClick={() => void loadTasks()}>
          刷新列表
        </button>
      </section>

      <section className="historyTableWrap">
        {loading && <div className="tableMessage">正在加载任务…</div>}
        {error !== null && (
          <div className="tableMessage errorText">{error}</div>
        )}
        {!loading && error === null && tasks.length === 0 && (
          <div className="tableMessage">
            还没有任务，从创作台生成第一条视频。
          </div>
        )}
        {tasks.length > 0 && (
          <table className="historyTable">
            <thead>
              <tr>
                <th>任务 ID</th>
                <th>提示词摘要</th>
                <th>创建时间</th>
                <th>状态</th>
                <th>模型</th>
                <th>分辨率</th>
                <th>时长</th>
                <th>用量</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => (
                <tr key={task.id}>
                  <td>
                    <code>{shortId(task.id)}</code>
                  </td>
                  <td className="promptSummary">{task.prompt}</td>
                  <td>{new Date(task.createdAt).toLocaleString("zh-CN")}</td>
                  <td>
                    <span
                      className={`statusPill status-${task.status.toLowerCase()}`}
                    >
                      <i />
                      {statusLabel(task.status)}
                    </span>
                  </td>
                  <td>{task.model}</td>
                  <td>{String(task.parameters.resolution ?? "—")}</td>
                  <td>
                    {task.parameters.duration === undefined
                      ? "—"
                      : `${String(task.parameters.duration)} 秒`}
                  </td>
                  <td>{formatUsage(task)}</td>
                  <td>
                    <Link className="detailLink" href={`/?task=${task.id}`}>
                      查看详情
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function formatUsage(task: TaskDto): string {
  if (task.usage.length === 0) return "未返回";
  return task.usage.map((item) => `${item.quantity} ${item.unit}`).join(", ");
}

function statusLabel(status: TaskDto["status"]): string {
  const labels: Record<TaskDto["status"], string> = {
    DRAFT: "草稿",
    QUEUED: "排队中",
    SUBMITTING: "提交中",
    PROCESSING: "生成中",
    SUCCEEDED: "已完成",
    FAILED: "失败",
    CANCELLED: "已取消",
    EXPIRED: "已过期"
  };
  return labels[status];
}
