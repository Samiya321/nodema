import base64

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.domain import AssetError
from app.naming import DEFAULT_TEMPLATE


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", hide_input_in_errors=True)
    database_url: SecretStr
    encryption_key_id: str = Field(default="local-v1", pattern=r"^[A-Za-z0-9_-]{1,32}$")
    encryption_key_b64: SecretStr = SecretStr("")
    fingerprint_key_b64: SecretStr
    source_max_bytes: int = Field(default=10_485_760, gt=0, le=10_485_760)
    source_max_items: int = Field(default=10_000, gt=0, le=10_000)
    source_total_timeout_seconds: float = Field(default=30, gt=0)
    source_max_redirects: int = Field(default=3, ge=0, le=10)
    source_sync_interval_seconds: int = Field(default=86400, gt=0)
    source_substore_max_fetches: int = Field(default=256, ge=1, le=256)
    source_substore_max_items: int = Field(default=50000, ge=1, le=100000)
    source_substore_max_depth: int = Field(default=3, ge=0, le=8)
    source_substore_timeout_seconds: float = Field(default=120, gt=0, le=300)
    name_template: str = DEFAULT_TEMPLATE
    mihomo_binary: str = "private/bin/mihomo"
    mihomo_reuse: bool = True
    mihomo_max_nodes_per_process: int = Field(default=250, ge=1, le=10000)
    check_concurrency: int = Field(default=16, ge=1, le=64)
    check_batch_size: int = Field(default=16, ge=1, le=250)
    runner_probe_id: str = Field(default="auto", pattern=r"^[A-Za-z0-9_-]{1,64}$")
    dns_cache_max_ttl_seconds: float = Field(default=300, ge=0, le=3600)
    dns_negative_ttl_seconds: float = Field(default=15, ge=0, le=300)
    tcp_cache_ttl_seconds: float = Field(default=60, ge=0, le=600)
    tcp_failure_ttl_seconds: float = Field(default=15, ge=0, le=120)
    precheck_gate_enabled: bool = True
    check_force_full: bool = False
    precheck_sample_rate: float = Field(default=0.1, ge=0, le=1)
    failure_cooldown_enabled: bool = True
    failure_cooldown_threshold: int = Field(default=3, ge=2, le=30)
    failure_cooldown_base_hours: int = Field(default=6, ge=1, le=24)
    failure_cooldown_max_hours: int = Field(default=72, ge=1, le=168)
    echo_url: str = ""
    # Landing-IP details: ip-api.com free tier (HTTP only, non-commercial, 15 batches/min).
    ipinfo_enabled: bool = True
    ipinfo_url: str = Field(default="http://ip-api.com/batch", pattern=r"^https?://[^\s]+$")
    ipinfo_refresh_days: int = Field(default=30, ge=1, le=365)
    ipinfo_max_ips: int = Field(default=1000, ge=1, le=5000)
    ipinfo_timeout_seconds: float = Field(default=15, gt=0, le=60)
    echo_token: SecretStr = SecretStr("")
    dns_timeout_seconds: float = Field(default=3, gt=0, le=30)
    tcp_timeout_seconds: float = Field(default=5, gt=0, le=30)
    http_timeout_seconds: float = Field(default=10, gt=0, le=30)
    retry_delay_seconds: float = Field(default=5, ge=0, le=30)
    environment_error_limit: int = Field(default=6, ge=2, le=100)
    degraded_http_ms: int = Field(default=8000, gt=0)
    freshness_hours: int = Field(default=36, gt=0)
    shard_size: int = Field(default=100, gt=0, le=1000)
    # Upper bound on test jobs per run; shards grow beyond shard_size to respect it.
    max_shards: int = Field(default=40, ge=1, le=256)
    shard_lease_seconds: int = Field(default=300, ge=180, le=3600)
    geoip_city_path: str = ""
    geoip_asn_path: str = ""
    geoip_download_provider: str = Field(
        default="auto", pattern=r"^(auto|github|maxmind|disabled)$"
    )
    geoip_github_token: SecretStr = SecretStr("")
    admin_username: str = "admin"
    admin_password: SecretStr = SecretStr("")
    detail_retention_days: int = Field(default=60, ge=1, le=365)
    stats_retention_days: int = Field(default=365, ge=30, le=3650)
    export_ttl_hours: int = Field(default=24, ge=1, le=168)
    github_repository: str = Field(default="", pattern=r"^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?$")
    github_dispatch_token: SecretStr = SecretStr("")
    github_workflow_ref: str = "main"
    scan_timezone: str = "Asia/Shanghai"
    maxmind_account_id: SecretStr = SecretStr("")
    maxmind_license_key: SecretStr = SecretStr("")

    def fingerprint_key(self) -> bytes:
        try:
            key = base64.b64decode(self.fingerprint_key_b64.get_secret_value(), validate=True)
            if len(key) != 32:
                raise ValueError
            return key
        except (ValueError, TypeError):
            raise AssetError("INVALID_KEYS") from None

    def keys(self) -> tuple[bytes, bytes]:
        try:
            aes, hmac = (
                base64.b64decode(v.get_secret_value(), validate=True)
                for v in (self.encryption_key_b64, self.fingerprint_key_b64)
            )
            if len(aes) != 32 or len(hmac) != 32 or aes == hmac:
                raise ValueError
            return aes, hmac
        except (ValueError, TypeError):
            raise AssetError("INVALID_KEYS") from None
