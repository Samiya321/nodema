import json
import os
import secrets
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import httpcore
import yaml

from app.domain import AssetError


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Mihomo:
    """One isolated, loopback-only runtime per worker; one proxy at a time."""

    def __init__(self, binary, *, reuse=True, max_nodes=250):
        self.binary = str(Path(binary).resolve())
        self.process = self.directory = None
        self.control_pool = None
        self.port = self.controller = None
        self.secret = secrets.token_urlsafe(32)
        self.reuse, self.max_nodes = reuse, max_nodes
        self.loaded_count, self.hosts = 0, {}
        self.metrics = {"runtime_starts": 0, "runtime_reloads": 0}

    def preflight(self):
        try:
            completed = subprocess.run(
                [self.binary, "-v"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                check=False,
            )
            if completed.returncode:
                raise OSError
        except (OSError, subprocess.SubprocessError):
            raise AssetError("MIHOMO_UNAVAILABLE") from None

    def set_hosts(self, hosts):
        self.hosts = hosts

    def _control(self, method, path, content=None):
        try:
            if self.control_pool is None:
                self.control_pool = httpcore.ConnectionPool(
                    max_connections=1, max_keepalive_connections=1, keepalive_expiry=30
                )
            return self.control_pool.request(
                method,
                f"http://127.0.0.1:{self.controller}" + path,
                headers={
                    "Authorization": f"Bearer {self.secret}",
                    "Content-Type": "application/json",
                },
                content=content,
                extensions={"timeout": {"connect": 1, "read": 8, "write": 5, "pool": 1}},
            )
        except (httpcore.NetworkError, httpcore.ProtocolError, httpcore.TimeoutException, OSError):
            self.close()
            raise AssetError("MIHOMO_CONTROL_FAILED") from None

    def reset(self):
        if self.process is None:
            return
        if self.process.poll() is not None:
            self.close()
            return
        response = self._control("DELETE", "/connections")
        if response.status not in (200, 204):
            self.close()
            raise AssetError("MIHOMO_RESET_FAILED")

    def start(self, proxy):
        live = self.process is not None and self.process.poll() is None
        if not self.reuse or not live or self.loaded_count >= self.max_nodes:
            self.close()
            self.directory = tempfile.TemporaryDirectory(prefix="nodema-runtime-")
            self.port, self.controller = free_port(), free_port()
            while self.controller == self.port:
                self.controller = free_port()
            live = False
        else:
            self.reset()
        config = {
            "mixed-port": self.port,
            "bind-address": "127.0.0.1",
            "allow-lan": False,
            "external-controller": f"127.0.0.1:{self.controller}",
            "secret": self.secret,
            "mode": "rule",
            "log-level": "silent",
            "ipv6": True,
            "find-process-mode": "off",
            "dns": {"enable": False},
            "hosts": self.hosts,
            "profile": {"store-selected": False},
            "proxies": [proxy],
            "proxy-groups": [{"name": "CHECK", "type": "select", "proxies": [proxy["name"]]}],
            "rules": ["MATCH,CHECK"],
        }
        path = Path(self.directory.name) / "config.yaml"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            yaml.safe_dump(config, stream, allow_unicode=True)
        try:
            if live:
                response = self._control(
                    "PUT", "/configs?force=true", json.dumps({"path": str(path)}).encode()
                )
                if response.status != 204:
                    if response.status == 400:
                        raise AssetError("RUNTIME_CONFIG_REJECTED")
                    raise AssetError("MIHOMO_RELOAD_FAILED")
                selected = self._control("GET", "/proxies")
                try:
                    group = json.loads(selected.content)["proxies"]["CHECK"]
                    if group.get("now") != proxy["name"] or group.get("all") != [proxy["name"]]:
                        raise ValueError
                except (ValueError, TypeError, KeyError):
                    raise AssetError("MIHOMO_PROXY_BINDING_FAILED") from None
                self.loaded_count += 1
                self.metrics["runtime_reloads"] += 1
                return
            valid = subprocess.run(
                [self.binary, "-t", "-d", self.directory.name, "-f", str(path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
            )
            if valid.returncode:
                raise AssetError("RUNTIME_CONFIG_REJECTED")
            self.process = subprocess.Popen(
                [self.binary, "-d", self.directory.name, "-f", str(path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self.loaded_count = 1
            self.metrics["runtime_starts"] += 1
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise AssetError("MIHOMO_START_FAILED")
                try:
                    with httpcore.ConnectionPool() as pool:
                        response = pool.request(
                            "GET",
                            f"http://127.0.0.1:{self.controller}/version",
                            headers={"Authorization": f"Bearer {self.secret}"},
                            extensions={"timeout": {"connect": 0.3, "read": 0.3}},
                        )
                    if response.status == 200 and "version" in json.loads(response.content):
                        return
                except (httpcore.NetworkError, httpcore.TimeoutException, ValueError):
                    pass
                time.sleep(0.05)
            raise AssetError("MIHOMO_START_TIMEOUT")
        except AssetError:
            self.close()
            raise
        except (OSError, subprocess.SubprocessError):
            self.close()
            raise AssetError("MIHOMO_START_FAILED") from None

    def close(self):
        if self.control_pool is not None:
            self.control_pool.close()
            self.control_pool = None
        if self.process is not None:
            if self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=3)
            self.process = None
        self.loaded_count = 0
        if self.directory is not None:
            self.directory.cleanup()
            self.directory = None
