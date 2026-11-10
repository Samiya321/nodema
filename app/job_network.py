"""Linux default-route interface counters. No packet capture and no test downloads."""

import json
import math
import os
import re
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

from app.domain import AssetError


def interfaces(root=Path("/sys/class/net"), routes=Path("/proc/net/route")):
    try:
        names = set()
        for line in routes.read_text().splitlines()[1:]:
            fields = line.split()
            if len(fields) >= 4 and fields[1] == "00000000" and int(fields[3], 16) & 2:
                names.add(fields[0])
        result = {}
        for name in names:
            if name == "lo" or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", name):
                continue
            path = root / name / "statistics"
            rx, tx = int((path / "rx_bytes").read_text()), int((path / "tx_bytes").read_text())
            if rx < 0 or tx < 0:
                raise ValueError
            result[name] = {"rx": rx, "tx": tx}
        return result
    except (OSError, ValueError):
        return {}


def start(path, *, read=interfaces):
    path = Path(path)
    if path.is_symlink():
        raise AssetError("INVALID_JOB_SAMPLE")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    value = {
        "version": 1,
        "started_at": datetime.now(UTC).isoformat(),
        "monotonic": time.monotonic(),
        "interfaces": read(),
    }
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {"status": "JOB_SAMPLE_STARTED", "network_available": bool(value["interfaces"])}


def finish(path, *, read=interfaces):
    try:
        path = Path(path)
        if path.is_symlink():
            raise ValueError
        with path.open("rb") as stream:
            raw = stream.read(65537)
        if len(raw) > 65536:
            raise ValueError
        value = json.loads(raw)
        started = datetime.fromisoformat(value["started_at"])
        baseline = value["interfaces"]
        if (
            value["version"] != 1
            or started.tzinfo is None
            or not isinstance(baseline, dict)
            or type(value["monotonic"]) not in (int, float)
            or not math.isfinite(value["monotonic"])
        ):
            raise ValueError
        current = read()
        rx = tx = 0
        valid = bool(baseline) and set(baseline) == set(current)
        for name, counts in baseline.items():
            if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,64}", name):
                raise ValueError
            if set(counts) != {"rx", "tx"} or any(
                type(v) is not int or v < 0 for v in counts.values()
            ):
                raise ValueError
            if not valid:
                continue
            delta_rx, delta_tx = (
                current[name]["rx"] - counts["rx"],
                current[name]["tx"] - counts["tx"],
            )
            if delta_rx < 0 or delta_tx < 0:
                valid = False
            rx += max(0, delta_rx)
            tx += max(0, delta_tx)
        return {
            "started_at": started,
            "network_samples": int(valid),
            "network_rx_bytes": rx if valid else 0,
            "network_tx_bytes": tx if valid else 0,
        }
    except (ValueError, TypeError, KeyError, OSError, AttributeError):
        raise AssetError("INVALID_JOB_SAMPLE") from None
