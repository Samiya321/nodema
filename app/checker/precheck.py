"""Per-execution, single-flight DNS and endpoint diagnostics. No asset deletion."""

import copy
import errno
import ipaddress
import socket
import time
from datetime import UTC, datetime
from threading import Lock
from uuid import uuid4

import dns.exception
import dns.rdatatype
import dns.resolver


def _ms(start):
    return max(0, round((time.monotonic() - start) * 1000))


class EndpointCache:
    def __init__(self, settings, *, resolver=None, connector=None, clock=time.monotonic):
        self.settings = settings
        self.resolver = resolver or dns.resolver.Resolver()
        self.connector = connector or socket.create_connection
        self.clock = clock
        self._guard, self._locks, self._values = Lock(), {}, {}
        self.metrics = {
            key: 0
            for key in (
                "dns_requests",
                "dns_cache_hits",
                "tcp_probes",
                "tcp_socket_attempts",
                "tcp_cache_hits",
            )
        }

    def _increment(self, key):
        with self._guard:
            self.metrics[key] += 1

    def _cached(self, key, action, hit_counter):
        with self._guard:
            lock = self._locks.setdefault(key, Lock())
        with lock:
            cached = self._values.get(key)
            if cached and cached[0] > self.clock():
                if hit_counter is not None:
                    self._increment(hit_counter)
                result = copy.deepcopy(cached[1])
                result["cached"] = True
                return result
            result, ttl = action()
            result["cached"] = False
            self._values[key] = (self.clock() + max(0, ttl), copy.deepcopy(result))
            return result

    def verdict(self, key, probe, ttl):
        """Single-flight, short-lived shared boolean (e.g. "is the runner network healthy")."""
        return self._cached(("verdict", key), lambda: ({"ok": bool(probe())}, ttl), None)["ok"]

    def _negative_ttl(self, error):
        ttl = self.settings.dns_negative_ttl_seconds
        try:
            responses = (
                error.responses().values() if hasattr(error, "responses") else [error.response()]
            )
            for response in responses:
                for rrset in response.authority:
                    if rrset.rdtype == dns.rdatatype.SOA:
                        ttl = min(ttl, rrset.ttl, *[record.minimum for record in rrset])
        except (AttributeError, TypeError, KeyError):
            pass
        return ttl

    def resolve(self, host, scope):
        try:
            ip = str(ipaddress.ip_address(host))
            return {
                "status": "SUCCESS",
                "ips": [ip],
                "duration_ms": 0,
                "cached": False,
                "checked_at": datetime.now(UTC).isoformat(),
                "ttl": None,
                "literal": True,
            }
        except ValueError:
            pass

        def query():
            self._increment("dns_requests")
            started = time.monotonic()
            result = {"ips": [], "checked_at": datetime.now(UTC).isoformat()}
            ttl = self.settings.dns_cache_max_ttl_seconds
            try:
                answers = self.resolver.resolve_name(
                    host, search=False, lifetime=self.settings.dns_timeout_seconds
                )
                ips = list(
                    dict.fromkeys(str(ipaddress.ip_address(ip)) for ip in answers.addresses())
                )
                if not ips:
                    raise dns.resolver.NoAnswer
                try:
                    ttl = min(ttl, *[a.rrset.ttl for a in answers.values() if a.rrset])
                except (AttributeError, TypeError):
                    ttl = min(ttl, 60)
                result.update(status="SUCCESS", ips=ips)
            except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer) as error:
                result.update(status="FAILED", error_code="ENTRY_DNS_NOT_FOUND")
                ttl = self._negative_ttl(error)
            except dns.exception.Timeout:
                result.update(status="ERROR", error_code="DNS_TIMEOUT")
                ttl = 0
            except (dns.exception.DNSException, ValueError):
                result.update(status="ERROR", error_code="DNS_ENVIRONMENT_ERROR")
                ttl = 0
            result.update(duration_ms=_ms(started), ttl=ttl, literal=False)
            return result, ttl

        return self._cached(("dns", scope, host), query, "dns_cache_hits")

    def ipv6_route_unavailable(self, ips, port, scope):
        if not ips or any(ipaddress.ip_address(ip).version != 6 for ip in ips):
            return False

        def query():
            unavailable = 0
            for ip in ips:
                try:
                    # UDP connect only selects a local route; no datagram is sent.
                    with socket.socket(socket.AF_INET6, socket.SOCK_DGRAM) as probe:
                        probe.connect((ip, port))
                    return {"unavailable": False}, 0
                except OSError as error:
                    if error.errno in (
                        errno.ENETUNREACH,
                        errno.ENETDOWN,
                        errno.EAFNOSUPPORT,
                        errno.EPROTONOSUPPORT,
                        errno.EADDRNOTAVAIL,
                    ):
                        unavailable += 1
                    else:
                        return {"unavailable": False}, 0
            return {"unavailable": unavailable == len(ips)}, self.settings.tcp_failure_ttl_seconds

        return self._cached(("route", scope, tuple(ips), port), query, None)["unavailable"]

    def tcp(self, host, port, ips, scope):
        def query():
            self._increment("tcp_probes")
            started = time.monotonic()
            result = {
                "check_id": str(uuid4()),
                "checked_at": datetime.now(UTC).isoformat(),
                "status": "FAILED",
                "confirmed": False,
                "timeout": False,
                "rounds": 0,
                "addresses": [],
                "scope": scope,
            }
            # Very large answer sets remain diagnostic: no truncated set can justify gating.
            candidates = ips[:32]
            exhaustive = len(candidates) == len(ips)
            for round_no in range(2):
                deadline = self.clock() + self.settings.tcp_timeout_seconds
                for index, ip in enumerate(candidates):
                    remaining = deadline - self.clock()
                    if remaining <= 0:
                        exhaustive = False
                        break
                    timeout = min(remaining, max(0.5, remaining / (len(candidates) - index)))
                    self._increment("tcp_socket_attempts")
                    try:
                        with self.connector((ip, port), timeout=timeout):
                            result["status"] = "SUCCESS"
                        result["addresses"].append(
                            {"ip": ip, "round": round_no + 1, "status": "SUCCESS"}
                        )
                        result.update(rounds=round_no + 1, duration_ms=_ms(started))
                        return result, self.settings.tcp_cache_ttl_seconds
                    except TimeoutError:
                        result["timeout"] = True
                        # A too-short share of the budget is inconclusive, not proof of failure.
                        exhaustive = exhaustive and timeout >= min(
                            1, self.settings.tcp_timeout_seconds
                        )
                        status = "TIMEOUT"
                    except OSError as error:
                        if error.errno in (
                            errno.ENETUNREACH,
                            errno.ENETDOWN,
                            errno.EAFNOSUPPORT,
                            errno.EPROTONOSUPPORT,
                            errno.EADDRNOTAVAIL,
                            errno.EPERM,
                            errno.EACCES,
                            errno.EMFILE,
                            errno.ENFILE,
                            errno.ENOBUFS,
                            errno.ENOMEM,
                        ):
                            exhaustive = False
                            status = "ENVIRONMENT_ERROR"
                        else:
                            status = "FAILED"
                    result["addresses"].append({"ip": ip, "round": round_no + 1, "status": status})
                result["rounds"] = round_no + 1
            environment_only = bool(result["addresses"]) and all(
                address["status"] == "ENVIRONMENT_ERROR" for address in result["addresses"]
            )
            result.update(
                confirmed=exhaustive and bool(candidates),
                environment_only=environment_only,
                duration_ms=_ms(started),
            )
            return result, self.settings.tcp_failure_ttl_seconds

        return self._cached(("tcp", scope, host, port, tuple(ips)), query, "tcp_cache_hits")
