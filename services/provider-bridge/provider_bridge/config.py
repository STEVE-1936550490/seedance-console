from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


def _required(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    raise ValueError(f"Missing required configuration: {' or '.join(names)}")


def _positive_integer(name: str, default: int) -> int:
    raw = os.environ.get(name, str(default))
    value = int(raw)
    if value <= 0:
        raise ValueError(f"{name} must be positive")
    return value


def _boolean(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    if raw == "true":
        return True
    if raw == "false":
        return False
    raise ValueError(f"{name} must be true or false")


@dataclass(frozen=True)
class BridgeConfig:
    host: str
    port: int
    provider: str
    provider_mode: str
    real_api_test: bool
    bridge_token: str
    base_url: str
    api_key: str
    model_id: str
    public_key_path: Path
    private_key_path: Path
    registry_path: Path
    temporary_root: Path
    output_host_allowlist: tuple[str, ...]
    request_timeout_seconds: int
    download_timeout_seconds: int
    max_download_bytes: int

    @classmethod
    def from_environment(cls) -> "BridgeConfig":
        base_url = _required(
            "AICC_BASE_URL", "MAAS_BASE_URL", "SEEDANCE_BASE_URL"
        )
        parsed = urlparse(base_url)
        if parsed.scheme != "https" or not parsed.hostname:
            raise ValueError("AICC Base URL must be an HTTPS URL")
        allowlist = tuple(
            value.strip().lower()
            for value in os.environ.get(
                "AICC_OUTPUT_HOST_ALLOWLIST", ""
            ).split(",")
            if value.strip()
        )
        return cls(
            host=os.environ.get("BRIDGE_HOST", "0.0.0.0"),
            port=_positive_integer("BRIDGE_PORT", 43173),
            provider=os.environ.get("SEEDANCE_PROVIDER", "mock"),
            provider_mode=os.environ.get("BRIDGE_PROVIDER_MODE", "disabled"),
            real_api_test=_boolean("REAL_API_TEST"),
            bridge_token=_required("SEEDANCE_BRIDGE_TOKEN"),
            base_url=base_url.rstrip("/"),
            api_key=_required(
                "AICC_API_KEY", "MAAS_API_KEY", "SEEDANCE_API_KEY"
            ),
            model_id=_required(
                "AICC_MODEL_ID", "MAAS_MODEL", "SEEDANCE_MODEL_ID"
            ),
            public_key_path=Path(
                os.environ.get(
                    "AICC_PUBLIC_KEY_PATH",
                    "/var/lib/seedance-bridge/keys/seedance_pub.pem",
                )
            ),
            private_key_path=Path(
                os.environ.get(
                    "AICC_PRIVATE_KEY_PATH",
                    "/var/lib/seedance-bridge/keys/seedance_priv.pem",
                )
            ),
            registry_path=Path(
                os.environ.get(
                    "BRIDGE_REGISTRY_PATH",
                    "/var/lib/seedance-bridge/registry/submissions.sqlite3",
                )
            ),
            temporary_root=Path(
                os.environ.get(
                    "BRIDGE_TEMP_ROOT", "/var/lib/seedance-bridge/tmp"
                )
            ),
            output_host_allowlist=allowlist,
            request_timeout_seconds=_positive_integer(
                "AICC_REQUEST_TIMEOUT_SECONDS", 120
            ),
            download_timeout_seconds=_positive_integer(
                "AICC_DOWNLOAD_TIMEOUT_SECONDS", 180
            ),
            max_download_bytes=_positive_integer(
                "AICC_MAX_DOWNLOAD_BYTES", 536_870_912
            ),
        )

    @property
    def create_enabled(self) -> bool:
        return (
            self.provider in {"seedance", "aicc"}
            and self.provider_mode == "aicc"
            and self.real_api_test
        )
