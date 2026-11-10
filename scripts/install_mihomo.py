"""Install a pinned official release into ignored private/bin; verify the release asset digest."""

import gzip
import hashlib
import os
import platform
import tempfile
import urllib.request
from pathlib import Path

VERSION = "v1.19.33"
DIGESTS = {
    ("Darwin", "arm64"): (
        "darwin-arm64",
        "060b64b0f2c9a310831db0fe4adb2878de67bfa606c311813c1f13966aa504b6",
    ),
    ("Linux", "x86_64"): (
        "linux-amd64",
        "132f6f3edf9a65e62f04853aed3358472e0b2b7666daa8419edfa2ddf5bb6323",
    ),
    ("Linux", "aarch64"): (
        "linux-arm64",
        "ba408b317080ee265c46cb923a50018c1b82cbd708551cdd46a1e3e307396187",
    ),
}


def main():
    target, expected = DIGESTS[(platform.system(), platform.machine())]
    name = f"mihomo-{target}-{VERSION}.gz"
    request = urllib.request.Request(
        f"https://github.com/MetaCubeX/mihomo/releases/download/{VERSION}/{name}",
        headers={"User-Agent": "nodema-installer"},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(40_000_001)
    if len(data) > 40_000_000 or hashlib.sha256(data).hexdigest() != expected:
        raise RuntimeError("MIHOMO_DIGEST_MISMATCH")
    directory = Path("private/bin")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, path = tempfile.mkstemp(dir=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(gzip.decompress(data))
        os.chmod(path, 0o700)
        os.replace(path, directory / "mihomo")
    finally:
        if os.path.exists(path):
            os.unlink(path)
    print(f"Installed verified Mihomo {VERSION}")


if __name__ == "__main__":
    main()
