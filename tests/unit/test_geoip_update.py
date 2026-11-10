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
