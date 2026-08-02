from __future__ import annotations

import sqlite3
import threading
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Submission:
    status: str
    provider_task_id: str | None
    error_code: str | None = None
    provider_http_status: int | None = None
    provider_error_code: str | None = None
    provider_request_id: str | None = None
    provider_trace_id: str | None = None
    create_attempt_id: str | None = None
    request_payload_sha256: str | None = None
    bridge_request_id: str | None = None
    request_started_at: str | None = None
    request_ended_at: str | None = None
    failure_stage: str | None = None
    exception_type: str | None = None
    request_body_sent: bool | None = None
    stack_fingerprint: str | None = None


class SubmissionRegistry:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._connection = sqlite3.connect(
            path, check_same_thread=False, isolation_level=None
        )
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=FULL")
        self._connection.execute(
            """
            CREATE TABLE IF NOT EXISTS submissions (
              client_request_id TEXT PRIMARY KEY,
              status TEXT NOT NULL,
              provider_task_id TEXT,
              error_code TEXT,
              provider_http_status INTEGER,
              provider_error_code TEXT,
              provider_request_id TEXT,
              provider_trace_id TEXT,
              create_attempt_id TEXT,
              request_payload_sha256 TEXT,
              bridge_request_id TEXT,
              request_started_at TEXT,
              request_ended_at TEXT,
              failure_stage TEXT,
              exception_type TEXT,
              request_body_sent INTEGER,
              stack_fingerprint TEXT,
              updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        existing_columns = {
            row[1]
            for row in self._connection.execute(
                "PRAGMA table_info(submissions)"
            ).fetchall()
        }
        for name, column_type in (
            ("error_code", "TEXT"),
            ("provider_http_status", "INTEGER"),
            ("provider_error_code", "TEXT"),
            ("provider_request_id", "TEXT"),
            ("provider_trace_id", "TEXT"),
            ("create_attempt_id", "TEXT"),
            ("request_payload_sha256", "TEXT"),
            ("bridge_request_id", "TEXT"),
            ("request_started_at", "TEXT"),
            ("request_ended_at", "TEXT"),
            ("failure_stage", "TEXT"),
            ("exception_type", "TEXT"),
            ("request_body_sent", "INTEGER"),
            ("stack_fingerprint", "TEXT"),
        ):
            if name not in existing_columns:
                self._connection.execute(
                    f"ALTER TABLE submissions ADD COLUMN {name} {column_type}"
                )
        self._lock = threading.Lock()

    def begin(
        self,
        client_request_id: str,
        *,
        create_attempt_id: str | None = None,
        request_payload_sha256: str | None = None,
        bridge_request_id: str | None = None,
    ) -> tuple[bool, Submission]:
        with self._lock:
            self._connection.execute("BEGIN IMMEDIATE")
            try:
                row = self._connection.execute(
                    """
                    SELECT status, provider_task_id, error_code,
                           provider_http_status, provider_error_code,
                           provider_request_id, provider_trace_id,
                           create_attempt_id, request_payload_sha256,
                           bridge_request_id, request_started_at,
                           request_ended_at, failure_stage, exception_type,
                           request_body_sent, stack_fingerprint
                    FROM submissions WHERE client_request_id = ?
                    """,
                    (client_request_id,),
                ).fetchone()
                if row is not None:
                    self._connection.execute("COMMIT")
                    return False, Submission(*row)
                self._connection.execute(
                    """
                    INSERT INTO submissions(
                      client_request_id, status, create_attempt_id,
                      request_payload_sha256, bridge_request_id
                    ) VALUES (?, 'STARTED', ?, ?, ?)
                    """,
                    (
                        client_request_id,
                        create_attempt_id,
                        request_payload_sha256,
                        bridge_request_id,
                    ),
                )
                self._connection.execute("COMMIT")
                return True, Submission("STARTED", None)
            except Exception:
                self._connection.execute("ROLLBACK")
                raise

    def accept(
        self,
        client_request_id: str,
        provider_task_id: str,
        *,
        provider_request_id: str | None = None,
        provider_trace_id: str | None = None,
        request_started_at: str | None = None,
        request_ended_at: str | None = None,
        request_body_sent: bool | None = None,
    ) -> None:
        with self._lock:
            self._connection.execute(
                """
                UPDATE submissions
                SET status = 'ACCEPTED', provider_task_id = ?,
                    provider_request_id = COALESCE(?, provider_request_id),
                    provider_trace_id = COALESCE(?, provider_trace_id),
                    request_started_at = COALESCE(?, request_started_at),
                    request_ended_at = COALESCE(?, request_ended_at),
                    request_body_sent = COALESCE(?, request_body_sent),
                    updated_at = CURRENT_TIMESTAMP
                WHERE client_request_id = ?
                """,
                (
                    provider_task_id,
                    provider_request_id,
                    provider_trace_id,
                    request_started_at,
                    request_ended_at,
                    request_body_sent,
                    client_request_id,
                ),
            )

    def mark_unknown(
        self,
        client_request_id: str,
        *,
        error_code: str,
        provider_http_status: int | None = None,
        provider_error_code: str | None = None,
        provider_request_id: str | None = None,
        provider_trace_id: str | None = None,
        request_started_at: str | None = None,
        request_ended_at: str | None = None,
        failure_stage: str | None = None,
        exception_type: str | None = None,
        request_body_sent: bool | None = None,
        stack_fingerprint: str | None = None,
    ) -> None:
        with self._lock:
            self._connection.execute(
                """
                UPDATE submissions
                SET status = 'OUTCOME_UNKNOWN', provider_task_id = NULL,
                    error_code = ?, provider_http_status = ?,
                    provider_error_code = ?, provider_request_id = ?,
                    provider_trace_id = ?, request_started_at = ?,
                    request_ended_at = ?, failure_stage = ?,
                    exception_type = ?, request_body_sent = ?,
                    stack_fingerprint = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE client_request_id = ?
                """,
                (
                    error_code,
                    provider_http_status,
                    provider_error_code,
                    provider_request_id,
                    provider_trace_id,
                    request_started_at,
                    request_ended_at,
                    failure_stage,
                    exception_type,
                    request_body_sent,
                    stack_fingerprint,
                    client_request_id,
                ),
            )

    def mark_not_created(
        self,
        client_request_id: str,
        *,
        error_code: str,
        provider_http_status: int | None = None,
        provider_error_code: str | None = None,
        provider_request_id: str | None = None,
        provider_trace_id: str | None = None,
        request_started_at: str | None = None,
        request_ended_at: str | None = None,
        failure_stage: str | None = None,
        exception_type: str | None = None,
        request_body_sent: bool | None = None,
        stack_fingerprint: str | None = None,
    ) -> None:
        self.mark_unknown(
            client_request_id,
            error_code=error_code,
            provider_http_status=provider_http_status,
            provider_error_code=provider_error_code,
            provider_request_id=provider_request_id,
            provider_trace_id=provider_trace_id,
            request_started_at=request_started_at,
            request_ended_at=request_ended_at,
            failure_stage=failure_stage,
            exception_type=exception_type,
            request_body_sent=request_body_sent,
            stack_fingerprint=stack_fingerprint,
        )
        with self._lock:
            self._connection.execute(
                "UPDATE submissions SET status = 'NOT_CREATED' "
                "WHERE client_request_id = ?",
                (client_request_id,),
            )

    def recover(self, client_request_id: str) -> str | None:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT provider_task_id FROM submissions
                WHERE client_request_id = ? AND status = 'ACCEPTED'
                """,
                (client_request_id,),
            ).fetchone()
            return None if row is None else row[0]

    def confirm_not_created(self, client_request_id: str) -> bool:
        with self._lock:
            cursor = self._connection.execute(
                """
                UPDATE submissions
                SET status = 'NOT_CREATED', provider_task_id = NULL,
                    updated_at = CURRENT_TIMESTAMP
                WHERE client_request_id = ?
                  AND status IN ('STARTED', 'OUTCOME_UNKNOWN', 'NOT_CREATED')
                """,
                (client_request_id,),
            )
            return cursor.rowcount == 1

    def _set(
        self, client_request_id: str, status: str, provider_task_id: str | None
    ) -> None:
        with self._lock:
            self._connection.execute(
                """
                UPDATE submissions
                SET status = ?, provider_task_id = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE client_request_id = ?
                """,
                (status, provider_task_id, client_request_id),
            )
