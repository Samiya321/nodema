"""Bounded official and GitHub GeoLite downloads; only validated MMDB data is installed."""

import base64
import hashlib
import hmac
import io
import json
import os
import tarfile
import tempfile
import time
import zipfile
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpcore

from app.checker.geoip import verify_mmdb
from app.domain import AssetError
from app.ingestion.fetcher import SafeBackend, read_body, validate_url

EDITIONS = ("GeoLite2-City", "GeoLite2-ASN")
BUNDLE_CONTEXT = "geoip-bundle:v1"
MAX_BUNDLE_BYTES = 268435456
GITHUB_REPOSITORY = "P3TERX/GeoLite.mmdb"
GITHUB_HOSTS = {
    "api.github.com",
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
}


def download_provider(settings):
    provider = settings.geoip_download_provider
    if provider == "auto":
        provider = (
            "maxmind"
            if (
                settings.maxmind_account_id.get_secret_value()
                or settings.maxmind_license_key.get_secret_value()
            )
            else "github"
        )
    return provider


def download_databases(settings, directory):
    provider = download_provider(settings)
    if provider == "disabled":
        return []
    if provider == "github":
        return download_github_databases(
            directory, token=settings.geoip_github_token.get_secret_value()
        )
    return [
        download_mmdb(
            settings.maxmind_account_id.get_secret_value(),
            settings.maxmind_license_key.get_secret_value(),
            edition,
            directory,
        )
        for edition in EDITIONS
    ]


def download_github_databases(directory, *, token="", pool_factory=None, verify=verify_mmdb):
    """Pin both assets to one release; verify GitHub SHA-256 plus MMDB type and age.

    Checksums detect corrupt/mismatched assets, not a compromised upstream publisher.
    No upstream workflow or executable code is downloaded or run.
    """
    deadline = time.monotonic() + 180
    factory = pool_factory or (
        lambda: httpcore.ConnectionPool(network_backend=SafeBackend(deadline))
    )

    def get(url, limit):
        for _ in range(5):
            url = validate_url(url)
            host = urlsplit(url).hostname
            if host not in GITHUB_HOSTS:
                raise AssetError("GEOIP_DOWNLOAD_ORIGIN_INVALID")
            headers = {"User-Agent": "nodema-geolite-updater", "Accept-Encoding": "identity"}
            if host == "api.github.com":
                headers["Accept"] = "application/vnd.github+json"
                if token:
                    headers["Authorization"] = "Bearer " + token
            with (
                factory() as pool,
                pool.stream(
                    "GET",
                    url,
                    headers=headers,
                    extensions={"timeout": {"connect": 5, "read": 30, "write": 5, "pool": 5}},
                ) as response,
            ):
                if response.status in (301, 302, 303, 307, 308):
                    values = {k.lower(): v for k, v in response.headers}
                    url = urljoin(url, values[b"location"].decode("ascii"))
                    continue
                if response.status != 200:
                    raise AssetError("GEOIP_DOWNLOAD_FAILED")
                return read_body(response.iter_stream(), b"", limit)
        raise AssetError("GEOIP_DOWNLOAD_FAILED")

    try:
        release = json.loads(
            get(f"https://api.github.com/repos/{GITHUB_REPOSITORY}/releases/latest", 1048576)
        )
        if release.get("draft") or release.get("prerelease"):
            raise AssetError("GEOIP_RELEASE_INVALID")
        target = Path(directory)
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        results = []
        with tempfile.TemporaryDirectory(dir=target) as staging:
            for edition in EDITIONS:
                name = edition + ".mmdb"
                assets = [a for a in release["assets"] if a["name"] == name]
                if len(assets) != 1:
                    raise AssetError("GEOIP_RELEASE_INVALID")
                asset = assets[0]
                digest = asset.get("digest", "")
                if (
                    not isinstance(digest, str)
                    or len(digest) != 71
                    or not digest.startswith("sha256:")
                ):
                    raise AssetError("GEOIP_CHECKSUM_REQUIRED")
                if not 0 < asset["size"] <= MAX_BUNDLE_BYTES // 2:
                    raise AssetError("GEOIP_ARCHIVE_TOO_LARGE")
                url = asset["browser_download_url"]
                prefix = f"https://github.com/{GITHUB_REPOSITORY}/releases/download/"
                if not url.startswith(prefix) or not url.endswith("/" + name):
                    raise AssetError("GEOIP_DOWNLOAD_ORIGIN_INVALID")
                data = get(url, MAX_BUNDLE_BYTES // 2)
                if len(data) != asset["size"] or not hmac.compare_digest(
                    hashlib.sha256(data).hexdigest(), digest[7:]
                ):
                    raise AssetError("GEOIP_CHECKSUM_MISMATCH")
                path = Path(staging) / name
                write_private(path, data)
                metadata = verify(path)
                if metadata["type"] != edition:
                    raise AssetError("GEOIP_DATABASE_TYPE_INVALID")
                if not time.time() - 30 * 86400 <= metadata["build_epoch"] <= time.time() + 86400:
                    raise AssetError("GEOIP_DATABASE_STALE")
                results.append(
                    {
                        "edition": edition,
                        "provider": "github",
                        "repository": GITHUB_REPOSITORY,
                        "release": release["tag_name"],
                        "sha256": digest[7:],
                        **metadata,
                    }
                )
            for edition in EDITIONS:
                os.replace(Path(staging) / (edition + ".mmdb"), target / (edition + ".mmdb"))
        return results
    except AssetError:
        raise
    except Exception:
        raise AssetError("GEOIP_UPDATE_FAILED") from None


def write_private(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def pack_databases(directory, output_file, cipher):
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as bundle:
        for edition in EDITIONS:
            path = Path(directory) / (edition + ".mmdb")
            if path.stat().st_size > MAX_BUNDLE_BYTES // 2:
                raise AssetError("GEOIP_ARCHIVE_TOO_LARGE")
            bundle.write(path, edition + ".mmdb")
    write_private(output_file, cipher.encrypt(archive.getvalue(), context=BUNDLE_CONTEXT))


def install_databases(input_file, directory, cipher, *, verify=verify_mmdb):
    try:
        with Path(input_file).open("rb") as stream:
            encrypted = stream.read(MAX_BUNDLE_BYTES + 1048577)
        if len(encrypted) > MAX_BUNDLE_BYTES + 1048576:
            raise AssetError("GEOIP_ARCHIVE_TOO_LARGE")
        plaintext = cipher.decrypt(encrypted, context=BUNDLE_CONTEXT)
        expected = {edition + ".mmdb" for edition in EDITIONS}
        with zipfile.ZipFile(io.BytesIO(plaintext)) as bundle:
            if set(bundle.namelist()) != expected or len(bundle.infolist()) != 2:
                raise AssetError("GEOIP_ARCHIVE_INVALID")
            if any(i.file_size > MAX_BUNDLE_BYTES // 2 for i in bundle.infolist()):
                raise AssetError("GEOIP_ARCHIVE_TOO_LARGE")
            target = Path(directory)
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            # Validate both files before replacing either destination.
            with tempfile.TemporaryDirectory(dir=target) as staging:
                for name in sorted(expected):
                    temporary = Path(staging) / name
                    write_private(temporary, bundle.read(name))
                    verify(temporary)
                for name in sorted(expected):
                    os.replace(Path(staging) / name, target / name)
        return {"status": "INSTALLED", "editions": list(EDITIONS)}
    except AssetError:
        raise
    except Exception:
        raise AssetError("GEOIP_INSTALL_FAILED") from None


def download_mmdb(
    account_id, license_key, edition, directory, *, pool_factory=None, verify=verify_mmdb
):
    if edition not in ("GeoLite2-City", "GeoLite2-ASN") or not account_id or not license_key:
        raise AssetError("MAXMIND_CONFIGURATION_REQUIRED")
    url = f"https://download.maxmind.com/geoip/databases/{edition}/download?suffix=tar.gz"
    authorization = "Basic " + base64.b64encode(f"{account_id}:{license_key}".encode()).decode()
    deadline = time.monotonic() + 120
    factory = pool_factory or (
        lambda: httpcore.ConnectionPool(network_backend=SafeBackend(deadline))
    )
    try:
        archive = None
        for _ in range(5):
            url = validate_url(url)
            headers = {"User-Agent": "nodema-geolite-updater", "Accept-Encoding": "identity"}
            if urlsplit(url).hostname == "download.maxmind.com":
                headers["Authorization"] = authorization
            with (
                factory() as pool,
                pool.stream(
                    "GET",
                    url,
                    headers=headers,
                    extensions={"timeout": {"connect": 5, "read": 30, "write": 5, "pool": 5}},
                ) as response,
            ):
                values = {k.lower(): v for k, v in response.headers}
                if response.status in (301, 302, 303, 307, 308):
                    url = urljoin(url, values[b"location"].decode("ascii"))
                    continue
                if response.status != 200:
                    raise AssetError("GEOIP_DOWNLOAD_FAILED")
                archive = read_body(response.iter_stream(), b"", 104857600)
                break
        if archive is None:
            raise AssetError("GEOIP_DOWNLOAD_FAILED")
        target = Path(directory)
        target.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, temporary = tempfile.mkstemp(dir=target)
        try:
            with (
                os.fdopen(fd, "wb") as stream,
                tarfile.open(fileobj=io.BytesIO(archive), mode="r|gz") as bundle,
            ):
                total, found = 0, False
                for ordinal, member in enumerate(bundle):
                    total += member.size
                    if ordinal > 20 or total > 268435456:
                        raise AssetError("GEOIP_ARCHIVE_TOO_LARGE")
                    if member.isfile() and member.name.endswith("/" + edition + ".mmdb"):
                        extracted = bundle.extractfile(member)
                        while chunk := extracted.read(1_048_576):
                            stream.write(chunk)
                        found = True
                        break
                if not found:
                    raise AssetError("GEOIP_ARCHIVE_INVALID")
            metadata = verify(temporary)
            os.replace(temporary, target / (edition + ".mmdb"))
            return {"edition": edition, **metadata}
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    except AssetError:
        raise
    except Exception:
        raise AssetError("GEOIP_UPDATE_FAILED") from None
