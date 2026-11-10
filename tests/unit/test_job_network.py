import json
import stat

import pytest

from app.domain import AssetError
from app.job_network import finish, interfaces, start


def test_default_route_counters_exclude_loopback_and_other_interfaces(tmp_path):
    routes = tmp_path / "route"
    routes.write_text(
        "Iface Destination Gateway Flags\n"
        "eth0 00000000 01020304 0003\n"
        "lo 00000000 00000000 0003\n"
        "docker0 00100000 00000000 0001\n"
    )
    counters = tmp_path / "eth0/statistics"
    counters.mkdir(parents=True)
    (counters / "rx_bytes").write_text("1200")
    (counters / "tx_bytes").write_text("300")
    assert interfaces(tmp_path, routes) == {"eth0": {"rx": 1200, "tx": 300}}
    assert interfaces(tmp_path, tmp_path / "absent") == {}


def test_job_network_private_snapshot_and_delta(tmp_path):
    path = tmp_path / "private/sample.json"
    start(path, read=lambda: {"eth0": {"rx": 100, "tx": 50}})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    value = finish(path, read=lambda: {"eth0": {"rx": 150, "tx": 70}})
    assert value["network_samples"] == 1
    assert value["network_rx_bytes"] == 50 and value["network_tx_bytes"] == 20
    assert value["started_at"].tzinfo is not None


@pytest.mark.parametrize(
    "before,after",
    [
        ({}, {}),
        ({"eth0": {"rx": 100, "tx": 50}}, {}),
        ({"eth0": {"rx": 100, "tx": 50}}, {"eth0": {"rx": 1, "tx": 60}}),
        ({"eth0": {"rx": 100, "tx": 50}}, {"eth1": {"rx": 200, "tx": 80}}),
    ],
)
def test_missing_or_reset_counters_report_missing_coverage(tmp_path, before, after):
    path = tmp_path / "sample.json"
    start(path, read=lambda: before)
    value = finish(path, read=lambda: after)
    assert value["network_samples"] == 0
    assert value["network_rx_bytes"] == value["network_tx_bytes"] == 0


def test_job_sample_rejects_oversized_malformed_and_symlink_files(tmp_path):
    path = tmp_path / "sample.json"
    for raw in ("x" * 65537, "[]", '{"version":1}', "null"):
        path.write_text(raw)
        with pytest.raises(AssetError, match="INVALID_JOB_SAMPLE"):
            finish(path)
    start(path, read=lambda: {"eth0": {"rx": 1, "tx": 2}})
    value = json.loads(path.read_text())
    value["interfaces"]["eth0"]["rx"] = True
    path.write_text(json.dumps(value))
    with pytest.raises(AssetError, match="INVALID_JOB_SAMPLE"):
        finish(path, read=lambda: {"eth0": {"rx": 5, "tx": 8}})
    link = tmp_path / "link"
    link.symlink_to(path)
    with pytest.raises(AssetError, match="INVALID_JOB_SAMPLE"):
        start(link)
    with pytest.raises(AssetError, match="INVALID_JOB_SAMPLE"):
        finish(link)
