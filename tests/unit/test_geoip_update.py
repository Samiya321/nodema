import io
import tarfile
from contextlib import contextmanager

import httpcore
import pytest

from app.domain import AssetError
from app.geoip_update import download_mmdb, install_databases, pack_databases


def test_geoip_header_auth_redirect_and_safe_extract(tmp_path):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w:gz") as archive:
        member = tarfile.TarInfo("GeoLite2-City_20261107/GeoLite2-City.mmdb")
        member.size = len(b"synthetic-mmdb")
        archive.addfile(member, io.BytesIO(b"synthetic-mmdb"))
    calls = []

    class Pool:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        @contextmanager
        def stream(self, method, url, **kwargs):
            calls.append((url, kwargs["headers"]))
            if len(calls) == 1:
                yield httpcore.Response(
                    302, headers={"Location": "https://downloads.example/city.tar.gz"}
                )
            else:
                yield httpcore.Response(200, content=stream.getvalue())

    result = download_mmdb(
        "synthetic-account",
        "synthetic-license",
        "GeoLite2-City",
        tmp_path,
        pool_factory=Pool,
        verify=lambda _: {"type": "synthetic", "build_epoch": 0},
    )
    assert result["edition"] == "GeoLite2-City"
    assert "Authorization" in calls[0][1] and "Authorization" not in calls[1][1]
    assert all("synthetic-license" not in url for url, _ in calls)
    assert (tmp_path / "GeoLite2-City.mmdb").read_bytes() == b"synthetic-mmdb"


def test_geoip_requires_explicit_credentials(tmp_path):
    with pytest.raises(AssetError, match="MAXMIND_CONFIGURATION_REQUIRED"):
        download_mmdb("", "", "GeoLite2-City", tmp_path)


def test_encrypted_geoip_bundle_round_trip_and_tamper(tmp_path, cipher):
    original = tmp_path / "original"
    original.mkdir()
    for edition in ("GeoLite2-City", "GeoLite2-ASN"):
        (original / (edition + ".mmdb")).write_bytes(b"synthetic-" + edition.encode())
    bundle = tmp_path / "geoip.nma"
    pack_databases(original, bundle, cipher)
    assert b"synthetic-" not in bundle.read_bytes()
    assert bundle.stat().st_mode & 0o777 == 0o600
    target = tmp_path / "installed"
    install_databases(bundle, target, cipher, verify=lambda _: {})
    assert (target / "GeoLite2-City.mmdb").read_bytes() == b"synthetic-GeoLite2-City"
    changed = bytearray(bundle.read_bytes())
    changed[-1] ^= 1
    bundle.write_bytes(changed)
    with pytest.raises(AssetError, match="DECRYPTION_FAILED"):
        install_databases(bundle, target, cipher)


def test_geoip_bundle_rejects_extra_and_traversal_entries(tmp_path, cipher):
    import zipfile

    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        archive.writestr("../escape.mmdb", b"synthetic")
    bundle = tmp_path / "bad.nma"
    bundle.write_bytes(cipher.encrypt(stream.getvalue(), context="geoip-bundle:v1"))
    with pytest.raises(AssetError, match="GEOIP_ARCHIVE_INVALID"):
        install_databases(bundle, tmp_path / "installed", cipher)
    assert not (tmp_path / "escape.mmdb").exists()


def github_fixture(*, change=None, redirect=False):
    import hashlib
    import json
    import time

    from app.geoip_update import EDITIONS

    assets = []
    content = {}
    for edition in EDITIONS:
        name = edition + ".mmdb"
        data = b"synthetic-" + edition.encode()
        url = "https://github.com/P3TERX/GeoLite.mmdb/releases/download/2026.11.10/" + name
        assets.append(
            {
                "name": name,
                "size": len(data),
                "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
                "browser_download_url": url,
            }
        )
        content[url] = data
    release = {"tag_name": "2026.11.10", "draft": False, "prerelease": False, "assets": assets}
    if change:
        change(release)
    calls = []

    class Pool:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        @contextmanager
        def stream(self, method, url, **kwargs):
            calls.append((url, kwargs["headers"]))
            if url.startswith("https://api.github.com/"):
                yield httpcore.Response(200, content=json.dumps(release).encode())
            elif redirect and url.startswith("https://github.com/"):
                yield httpcore.Response(
                    302,
                    headers={
                        "Location": "https://release-assets.githubusercontent.com/test/"
                        + url.rsplit("/", 1)[-1]
                    },
                )
            else:
                name = url.rsplit("/", 1)[-1]
                yield httpcore.Response(
                    200, content=b"synthetic-" + name.removesuffix(".mmdb").encode()
                )

    def verify(path):
        return {"type": path.stem, "build_epoch": int(time.time())}

    return Pool, verify, calls


def test_github_both_assets_verified_and_token_not_forwarded(tmp_path):
    from app.geoip_update import download_github_databases

    pool, verify, calls = github_fixture(redirect=True)
    result = download_github_databases(
        tmp_path, token="synthetic-github-token", pool_factory=pool, verify=verify
    )
    assert len(result) == 2
    assert all(r["release"] == "2026.11.10" and len(r["sha256"]) == 64 for r in result)
    assert "Authorization" in calls[0][1]
    assert all("Authorization" not in headers for _, headers in calls[1:])
    assert all("synthetic-github-token" not in url for url, _ in calls)
    assert (tmp_path / "GeoLite2-ASN.mmdb").stat().st_mode & 0o777 == 0o600


@pytest.mark.parametrize(
    "failure,expected",
    [
        ("digest", "GEOIP_CHECKSUM_MISMATCH"),
        ("missing", "GEOIP_CHECKSUM_REQUIRED"),
        ("origin", "GEOIP_DOWNLOAD_ORIGIN_INVALID"),
        ("large", "GEOIP_ARCHIVE_TOO_LARGE"),
        ("type", "GEOIP_DATABASE_TYPE_INVALID"),
        ("stale", "GEOIP_DATABASE_STALE"),
    ],
)
def test_github_rejects_bad_second_asset_without_replacing_first(tmp_path, failure, expected):
    from app.geoip_update import download_github_databases

    def change(release):
        asset = release["assets"][1]
        if failure == "digest":
            asset["digest"] = "sha256:" + "0" * 64
        if failure == "missing":
            asset.pop("digest")
        if failure == "origin":
            asset["browser_download_url"] = "https://untrusted.example/GeoLite2-ASN.mmdb"
        if failure == "large":
            asset["size"] = 268435456

    pool, verify, calls = github_fixture(change=change)

    def custom_verify(path):
        result = verify(path)
        if path.stem.endswith("ASN"):
            if failure == "type":
                result["type"] = "GeoLite2-City"
            if failure == "stale":
                result["build_epoch"] = 0
        return result

    first = tmp_path / "GeoLite2-City.mmdb"
    first.write_bytes(b"previous-good-city")
    with pytest.raises(AssetError, match=expected):
        download_github_databases(tmp_path, pool_factory=pool, verify=custom_verify)
    assert first.read_bytes() == b"previous-good-city"
    assert not (tmp_path / "GeoLite2-ASN.mmdb").exists()


def test_geoip_provider_and_optional_failure_keeps_scan_running(
    tmp_path, monitor_settings, monkeypatch
):
    import json

    from pydantic import SecretStr
    from typer.testing import CliRunner

    import app.cli as cli
    import app.geoip_update as geo

    assert geo.download_provider(monitor_settings) == "github"
    official = monitor_settings.model_copy(update={"maxmind_account_id": SecretStr("synthetic")})
    assert geo.download_provider(official) == "maxmind"
    monkeypatch.setattr(cli, "Settings", lambda: monitor_settings)

    def fail(*args):
        raise AssetError("GEOIP_DOWNLOAD_FAILED")

    monkeypatch.setattr(geo, "download_databases", fail)
    output = tmp_path / "github_output"
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    result = CliRunner().invoke(
        cli.app, ["geoip-pack", "--output-file", str(tmp_path / "geoip.nma")]
    )
    assert result.exit_code == 0
    assert json.loads(result.stdout)["status"] == "UNAVAILABLE"
    assert output.read_text() == "geoip_ready=false\n"
    assert not (tmp_path / "geoip.nma").exists()


def test_cached_databases_are_reused_only_when_complete_and_recent(tmp_path):
    import time

    from app.geoip_update import cached_databases

    now = time.time()
    epochs = {"GeoLite2-City": now - 2 * 86400, "GeoLite2-ASN": now - 3 * 86400}

    def verify(path):
        edition = path.name.removesuffix(".mmdb")
        if not path.exists():
            raise FileNotFoundError(path)
        return {"type": edition, "build_epoch": epochs[edition]}

    assert cached_databases(tmp_path, 8, verify=verify) is None  # nothing restored
    for edition in epochs:
        (tmp_path / f"{edition}.mmdb").write_bytes(b"synthetic")
    hit = cached_databases(tmp_path, 8, verify=verify)
    assert [d["edition"] for d in hit] == ["GeoLite2-City", "GeoLite2-ASN"]
    assert all(d["provider"] == "cache" for d in hit)
    assert cached_databases(tmp_path, 0, verify=verify) is None  # reuse disabled
    epochs["GeoLite2-ASN"] = now - 20 * 86400
    assert cached_databases(tmp_path, 8, verify=verify) is None  # too old: download
