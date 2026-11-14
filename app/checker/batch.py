"""Many nodes per mihomo process, each behind its own loopback listener.

The per-worker runtime reloads its config for every node. Here a batch of prepared
nodes is loaded once into a short-lived process; every node gets a `mixed` listener
bound to exactly that proxy, so checks run concurrently without reloads. Unmatched
traffic is REJECTed (never DIRECT), so a misrouted request cannot pass as a working
node. A few processes rotate: a batch's process exits once all its checks finished,
so slow nodes in one batch never hold up the next.
"""

import os
import secrets
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import httpcore
import yaml

from app.domain import AssetError


def _ports(count):
    """Distinct free loopback ports (held open together so none repeats)."""
    sockets = []
    try:
        for _ in range(count):
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            sockets.append(sock)
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()


def _listening(port, timeout=0.5):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout):
            return True
    except OSError:
        return False


class Batch:
    """One running process and the listener port of every node it holds."""

    def __init__(self, pool, process, directory, ports):
        self.pool, self.process, self.directory = pool, process, directory
        self.ports = ports  # proxy name -> port
        self.remaining = len(ports)

    def alive(self):
        return self.process is not None and self.process.poll() is None

    def listener(self, name):
        return (self.ports[name], self.alive) if name in self.ports else None

    def release(self):
        self.pool._release(self)

    def stop(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.process = None
        if self.directory is not None:
            self.directory.cleanup()
            self.directory = None


class ListenerPool:
    def __init__(self, binary, *, processes=3, start_timeout=10):
        self.binary = str(Path(binary).resolve())
        self.processes, self.start_timeout = max(1, processes), start_timeout
        self.active = set()
        self.condition = threading.Condition()
        self.metrics = {"batch_runtimes": 0, "batch_nodes": 0, "batch_rejected": 0}

    # -- config -----------------------------------------------------------------
    def _config(self, proxies, hosts, ports, controller, secret):
        return {
            "bind-address": "127.0.0.1",
            "allow-lan": False,
            "external-controller": f"127.0.0.1:{controller}",
            "secret": secret,
            "mode": "rule",
            "log-level": "silent",
            "ipv6": True,
            "find-process-mode": "off",
            "dns": {"enable": False},
            "hosts": hosts,
            "profile": {"store-selected": False},
            "proxies": proxies,
            "listeners": [
                {
                    "name": f"in-{proxy['name']}",
                    "type": "mixed",
                    "listen": "127.0.0.1",
                    "udp": True,
                    "port": ports[proxy["name"]],
                    "proxy": proxy["name"],
                }
                for proxy in proxies
            ],
            "rules": ["MATCH,REJECT"],
        }

    def _write(self, directory, config, name="config.yaml"):
        path = Path(directory) / name
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as stream:
            yaml.safe_dump(config, stream, allow_unicode=True)
        return path

    def _valid(self, directory, proxies, hosts):
        if not proxies:
            return True
        ports = {p["name"]: 1024 + i for i, p in enumerate(proxies)}
        path = self._write(directory, self._config(proxies, hosts, ports, 9, "x"), "test.yaml")
        try:
            return (
                subprocess.run(
                    [self.binary, "-t", "-d", str(directory), "-f", str(path)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=20,
                ).returncode
                == 0
            )
        except (OSError, subprocess.SubprocessError):
            raise AssetError("MIHOMO_UNAVAILABLE") from None

    def _accepted(self, directory, proxies, hosts):
        """Split a rejected batch in halves until the proxies mihomo refuses are found."""
        if self._valid(directory, proxies, hosts):
            return proxies
        if len(proxies) == 1:
            self.metrics["batch_rejected"] += 1
            return []
        middle = len(proxies) // 2
        return self._accepted(directory, proxies[:middle], hosts) + self._accepted(
            directory, proxies[middle:], hosts
        )

    # -- lifecycle --------------------------------------------------------------
    def load(self, ready):
        """Start a process for {name: ready} (prepare() output). Blocks while every
        process slot is busy. Nodes left out (rejected config, listener not up) get
        no listener and are checked by the per-worker runtime instead."""
        with self.condition:
            while len(self.active) >= self.processes:
                self.condition.wait()
            self.active.add(None)  # reserve a slot while starting
        try:
            batch = self._start(ready)
        except BaseException:
            with self.condition:
                self.active.discard(None)
                self.condition.notify_all()
            raise
        with self.condition:
            self.active.discard(None)
            if batch.remaining:
                self.active.add(batch)
            self.condition.notify_all()
        if not batch.remaining:
            batch.stop()
        return batch

    def _start(self, ready):
        directory = tempfile.TemporaryDirectory(prefix="nodema-batch-")
        hosts = {}
        for item in ready.values():
            hosts.update(item["hosts"])
        proxies = self._accepted(directory.name, [item["proxy"] for item in ready.values()], hosts)
        if not proxies:
            directory.cleanup()
            return Batch(self, None, None, {})
        ports_list = _ports(len(proxies) + 1)
        controller = ports_list.pop()
        ports = {proxy["name"]: port for proxy, port in zip(proxies, ports_list, strict=True)}
        secret = secrets.token_urlsafe(32)
        path = self._write(directory.name, self._config(proxies, hosts, ports, controller, secret))
        try:
            process = subprocess.Popen(
                [self.binary, "-d", directory.name, "-f", str(path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except OSError:
            directory.cleanup()
            raise AssetError("MIHOMO_START_FAILED") from None
        batch = Batch(self, process, directory, ports)
        if not self._wait_ready(process, controller, secret):
            batch.stop()
            return Batch(self, None, None, {})
        # A listener that did not bind (port taken meanwhile) must not look like a dead node.
        missing = [name for name, port in ports.items() if not _listening(port)]
        for name in missing:
            del batch.ports[name]
        batch.remaining = len(batch.ports)
        self.metrics["batch_runtimes"] += 1
        self.metrics["batch_nodes"] += batch.remaining
        return batch

    def _wait_ready(self, process, controller, secret):
        deadline = time.monotonic() + self.start_timeout
        while time.monotonic() < deadline:
            if process.poll() is not None:
                return False
            try:
                with httpcore.ConnectionPool() as pool:
                    response = pool.request(
                        "GET",
                        f"http://127.0.0.1:{controller}/version",
                        headers={"Authorization": f"Bearer {secret}"},
                        extensions={"timeout": {"connect": 0.3, "read": 0.3}},
                    )
                if response.status == 200:
                    return True
            except (httpcore.NetworkError, httpcore.TimeoutException, OSError):
                pass
            time.sleep(0.05)
        return False

    def _release(self, batch):
        with self.condition:
            batch.remaining -= 1
            done = batch.remaining <= 0
            if done:
                self.active.discard(batch)
                self.condition.notify_all()
        if done:
            batch.stop()

    def close(self):
        with self.condition:
            batches, self.active = list(self.active), set()
            self.condition.notify_all()
        for batch in batches:
            if batch is not None:
                batch.stop()
