import ipaddress
from functools import lru_cache
from pathlib import Path

import geoip2.database
import geoip2.errors


class GeoIP:
    def __init__(self, city_path="", asn_path=""):
        self.city = geoip2.database.Reader(city_path) if city_path else None
        self.asn = geoip2.database.Reader(asn_path) if asn_path else None
        self.metadata = {
            "city_build_epoch": self.city.metadata().build_epoch if self.city else None,
            "asn_build_epoch": self.asn.metadata().build_epoch if self.asn else None,
        }
        self._cache = lru_cache(maxsize=20_000)(self._lookup)

    def lookup(self, ip):
        return self._cache(ip)

    def _lookup(self, ip):
        result = {"country": None, "city": None, "asn": None, "organization": None}
        if not ipaddress.ip_address(ip).is_global:
            return result
        if self.city:
            try:
                value = self.city.city(ip)
                result.update(country=value.country.iso_code, city=value.city.name)
            except geoip2.errors.AddressNotFoundError:
                pass
        if self.asn:
            try:
                value = self.asn.asn(ip)
                result.update(
                    asn=value.autonomous_system_number,
                    organization=value.autonomous_system_organization,
                )
            except geoip2.errors.AddressNotFoundError:
                pass
        return result

    def close(self):
        self._cache.cache_clear()
        for reader in (self.city, self.asn):
            if reader:
                reader.close()


def verify_mmdb(path):
    with geoip2.database.Reader(str(Path(path))) as reader:
        return {
            "type": reader.metadata().database_type,
            "build_epoch": reader.metadata().build_epoch,
        }
