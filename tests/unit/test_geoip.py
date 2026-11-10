from types import SimpleNamespace

import geoip2.errors

from app.checker.geoip import GeoIP


def test_city_miss_does_not_skip_asn_and_results_are_cached(monkeypatch):
    calls = {"city": 0, "asn": 0, "close": 0}

    class Reader:
        def __init__(self, path):
            self.path = path

        def metadata(self):
            return SimpleNamespace(build_epoch=123)

        def city(self, ip):
            calls["city"] += 1
            raise geoip2.errors.AddressNotFoundError("Synthetic city miss")

        def asn(self, ip):
            calls["asn"] += 1
            return SimpleNamespace(
                autonomous_system_number=64512, autonomous_system_organization="Synthetic ASN"
            )

        def close(self):
            calls["close"] += 1

    monkeypatch.setattr("app.checker.geoip.geoip2.database.Reader", Reader)
    geo = GeoIP("city", "asn")
    assert geo.lookup("8.8.8.8") == {
        "country": None,
        "city": None,
        "asn": 64512,
        "organization": "Synthetic ASN",
    }
    geo.lookup("8.8.8.8")
    assert calls == {"city": 1, "asn": 1, "close": 0}
    assert geo.lookup("198.51.100.1")["asn"] is None
    geo.close()
    assert calls["close"] == 2
