"""UDP through a node: SOCKS5 UDP ASSOCIATE on the node's local mihomo listener.

Wi-Fi Calling needs UDP relayed end to end (IKEv2/IPsec on 500/4500). We cannot speak
IKE to a carrier, so the check proves the generic part: a datagram leaves through the
node and an answer comes back. STUN is tried first (its answer also names the UDP exit
IP, which can differ from the TCP exit); a DNS query is the fallback for exits that
filter STUN. Several attempts, each on a fresh association, so one lost packet never
marks a node as UDP-dead.
"""

import ipaddress
import os
import socket
import struct
import time
from dataclasses import dataclass, field

STUN_MAGIC = 0x2112A442
# (label, host, port, kind). Hostnames are resolved by the node, not the Runner.
TARGETS = (
    ("stun-cloudflare", "stun.cloudflare.com", 3478, "stun"),
    ("stun-google", "stun.l.google.com", 19302, "stun"),
    ("dns-cloudflare", "1.1.1.1", 53, "dns"),
    ("stun-cloudflare", "stun.cloudflare.com", 3478, "stun"),
)


@dataclass
class UdpResult:
    status: str = "NOT_RUN"  # SUCCESS / FAILED / NOT_SUPPORTED / NOT_RUN
    duration_ms: int | None = None
    exit_ip: str | None = None
    attempts: list = field(default_factory=list)


# -- wire formats ---------------------------------------------------------------
def stun_request(transaction: bytes) -> bytes:
    return struct.pack("!HHI", 0x0001, 0, STUN_MAGIC) + transaction


def stun_mapped_address(packet: bytes, transaction: bytes) -> str | None:
    """Exit address from a Binding Success response, or None if it is not one."""
    if len(packet) < 20:
        return None
    kind, length, magic = struct.unpack("!HHI", packet[:8])
    if kind != 0x0101 or magic != STUN_MAGIC or packet[8:20] != transaction:
        return None
    body, offset, plain = packet[20 : 20 + length], 0, None
    while offset + 4 <= len(body):
        attr, size = struct.unpack("!HH", body[offset : offset + 4])
        value = body[offset + 4 : offset + 4 + size]
        offset += 4 + size + (-size % 4)
        if attr not in (0x0020, 0x0001) or len(value) < 8:
            continue
        family = value[1]
        raw = value[4:8] if family == 1 else value[4:20] if family == 2 else b""
        if attr == 0x0020:  # XOR-MAPPED-ADDRESS
            key = struct.pack("!I", STUN_MAGIC) + transaction
            raw = bytes(b ^ key[i] for i, b in enumerate(raw))
        try:
            address = str(ipaddress.ip_address(raw))
        except ValueError:
            continue
        if attr == 0x0020:
            return address
        plain = address
    return plain


def dns_query(ident: int) -> bytes:
    question = b"".join(bytes([len(p)]) + p for p in (b"example", b"com")) + b"\0"
    return struct.pack("!HHHHHH", ident, 0x0100, 1, 0, 0, 0) + question + struct.pack("!HH", 1, 1)


def dns_answered(packet: bytes, ident: int) -> bool:
    return len(packet) >= 12 and struct.unpack("!H", packet[:2])[0] == ident and packet[2] & 0x80


def socks_address(host: str, port: int) -> bytes:
    try:
        ip = ipaddress.ip_address(host)
        kind = b"\x01" if ip.version == 4 else b"\x04"
        return kind + ip.packed + struct.pack("!H", port)
    except ValueError:
        name = host.encode("idna")
        return b"\x03" + bytes([len(name)]) + name + struct.pack("!H", port)


def socks_unwrap(packet: bytes) -> bytes | None:
    """Payload of a SOCKS5 UDP reply (RSV RSV FRAG ATYP ADDR PORT DATA)."""
    if len(packet) < 4 or packet[2] != 0:
        return None
    kind = packet[3]
    if kind == 1:
        start = 4 + 4 + 2
    elif kind == 4:
        start = 4 + 16 + 2
    elif kind == 3 and len(packet) > 4:
        start = 5 + packet[4] + 2
    else:
        return None
    return packet[start:] if len(packet) >= start else None


def _read(sock, size):
    data = b""
    while len(data) < size:
        chunk = sock.recv(size - len(data))
        if not chunk:
            raise OSError("closed")
        data += chunk
    return data


def associate(port: int, timeout: float):
    """Open a UDP association on the local listener; returns (control, relay address)."""
    control = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    try:
        control.settimeout(timeout)
        control.sendall(b"\x05\x01\x00")
        if _read(control, 2) != b"\x05\x00":
            raise OSError("auth")
        control.sendall(b"\x05\x03\x00\x01\x00\x00\x00\x00\x00\x00")
        head = _read(control, 4)
        if head[1] != 0:
            raise OSError("refused")
        if head[3] == 1:
            host = str(ipaddress.ip_address(_read(control, 4)))
        elif head[3] == 4:
            host = str(ipaddress.ip_address(_read(control, 16)))
        elif head[3] == 3:
            host = _read(control, _read(control, 1)[0]).decode()
        else:
            raise OSError("address")
        relay_port = struct.unpack("!H", _read(control, 2))[0]
        if host in ("0.0.0.0", "::"):
            host = "127.0.0.1"
        return control, (host, relay_port)
    except BaseException:
        control.close()
        raise


def attempt(port: int, target, timeout: float):
    """One datagram exchange. Returns the UDP exit IP (STUN), "" (DNS) or raises."""
    _, host, target_port, kind = target
    control, relay = associate(port, timeout)
    try:
        with socket.socket(
            socket.AF_INET6 if ":" in relay[0] else socket.AF_INET, socket.SOCK_DGRAM
        ) as udp:
            udp.settimeout(timeout)
            transaction = os.urandom(12)
            ident = struct.unpack("!H", transaction[:2])[0]
            payload = stun_request(transaction) if kind == "stun" else dns_query(ident)
            deadline = time.monotonic() + timeout
            udp.sendto(b"\0\0\0" + socks_address(host, target_port) + payload, relay)
            while time.monotonic() < deadline:
                udp.settimeout(max(0.05, deadline - time.monotonic()))
                data = socks_unwrap(udp.recv(4096))
                if data is None:
                    continue
                if kind == "stun":
                    exit_ip = stun_mapped_address(data, transaction)
                    if exit_ip:
                        return exit_ip
                elif dns_answered(data, ident):
                    return ""
            raise TimeoutError
    finally:
        control.close()


def probe(port: int, *, timeout: float = 2.5, targets=TARGETS, pause: float = 0.3) -> UdpResult:
    result = UdpResult()
    started = time.monotonic()
    for target in targets:
        began = time.monotonic()
        try:
            exit_ip = attempt(port, target, timeout)
        except Exception as error:  # a broken attempt is a failed attempt, never a crash
            reason = "timeout" if isinstance(error, (TimeoutError, socket.timeout)) else "error"
            result.attempts.append({"target": target[0], "ok": False, "error": reason})
            time.sleep(pause)
            continue
        result.attempts.append(
            {"target": target[0], "ok": True, "ms": round((time.monotonic() - began) * 1000)}
        )
        result.status, result.exit_ip = "SUCCESS", exit_ip or None
        result.duration_ms = round((time.monotonic() - began) * 1000)
        return result
    result.status = "FAILED"
    result.duration_ms = round((time.monotonic() - started) * 1000)
    return result
