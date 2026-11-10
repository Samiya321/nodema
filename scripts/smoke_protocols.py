"""Real protocol handshakes on loopback only; no real nodes, external Echo or speed tests."""

import argparse
import base64
import copy
import ipaddress
import json
import os
import secrets
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpcore
import yaml
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey
from cryptography.x509.oid import NameOID

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.checker.health import HealthChecker  # noqa: E402
from app.checker.runtime import Mihomo, free_port  # noqa: E402
from app.config import Settings  # noqa: E402
from app.domain import AssetError  # noqa: E402
from app.parsers import parse_document  # noqa: E402


def private_file(path, content):
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(content)


def certificate(directory):
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.now(UTC) - timedelta(minutes=1))
        .not_valid_after(datetime.now(UTC) + timedelta(days=1))
        .add_extension(
            x509.SubjectAlternativeName(
                [x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path, key_path = directory / "cert.pem", directory / "key.pem"
    private_file(cert_path, cert.public_bytes(serialization.Encoding.PEM))
    private_file(
        key_path,
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ),
    )
    return str(cert_path), str(key_path)


class Geo:
    metadata = {}

    def lookup(self, ip):
        return {"country": None, "city": None, "asn": None}

    def close(self):
        pass


def main(binary):
    binary = str(Path(binary).resolve())
    with tempfile.TemporaryDirectory(prefix="nodema-protocol-smoke-") as temporary:
        directory = Path(temporary)
        cert, key = certificate(directory)
        nonce = secrets.token_urlsafe(24)

        class EchoHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path != "/" + nonce:
                    self.send_error(404)
                    return
                # Synthetic metadata, not a measurement of a public exit IP.
                raw = json.dumps(
                    {"nonce": nonce, "ip": "8.8.8.8", "country": "ZZ", "asn": 64512}
                ).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        http = ThreadingHTTPServer(("127.0.0.1", 0), EchoHandler)
        server_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_tls.load_cert_chain(cert, key)
        server_tls.set_alpn_protocols(["h2", "http/1.1"])
        http.socket = server_tls.wrap_socket(http.socket, server_side=True)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        client_tls = ssl.create_default_context(cafile=cert)
        echo_url = f"https://127.0.0.1:{http.server_port}/{nonce}"

        class LocalEcho:
            url = echo_url

            def request(self, port=None):
                pool = (
                    httpcore.HTTPProxy(proxy_url=f"http://127.0.0.1:{port}", ssl_context=client_tls)
                    if port
                    else httpcore.ConnectionPool(ssl_context=client_tls)
                )
                try:
                    with pool:
                        response = pool.request(
                            "GET",
                            echo_url,
                            extensions={
                                "timeout": {"connect": 5, "read": 8, "write": 5, "pool": 5}
                            },
                        )
                    data = json.loads(response.content)
                    if response.status != 200 or data.get("nonce") != nonce:
                        raise ValueError
                    return data
                except Exception:
                    raise AssetError("LOCAL_HTTPS_FAILED") from None

        listeners, identities = [], []
        allocated = {http.server_port}

        def port():
            value = free_port()
            while value in allocated:
                value = free_port()
            allocated.add(value)
            return value

        password = "synthetic-smoke-password"
        uuid = "00000000-0000-4000-8000-000000000001"
        for protocol in ("shadowsocks", "trojan", "anytls", "hysteria2", "vmess", "vless"):
            listener = {"name": protocol, "type": protocol, "listen": "127.0.0.1", "port": port()}
            d = {
                "protocol": protocol,
                "server_host": "127.0.0.1",
                "server_port": listener["port"],
                "transport": "quic" if protocol == "hysteria2" else "tcp",
                "security": "tls"
                if protocol in ("trojan", "anytls", "hysteria2", "vless")
                else "none",
                "tls": {},
                "transport_options": {},
                "protocol_options": {},
            }
            if protocol in ("vmess", "vless"):
                d["uuid"] = uuid
                listener["users"] = [{"username": "synthetic", "uuid": uuid}]
                if protocol == "vmess":
                    d["protocol_options"] = {"cipher": "auto", "alter_id": 0}
                    listener["users"][0]["alterId"] = 0
            else:
                d["password"] = password
                if protocol == "shadowsocks":
                    d["protocol_options"] = {"cipher": "aes-128-gcm"}
                    listener.update(cipher="aes-128-gcm", password=password)
                elif protocol == "trojan":
                    listener["users"] = [{"username": "synthetic", "password": password}]
                else:
                    listener["users"] = {"synthetic": password}
            if d["security"] == "tls":
                listener.update(certificate=cert, **{"private-key": key})
                d["tls"] = {"sni": "localhost", "insecure": True}
            if protocol == "hysteria2":
                listener.update(obfs="salamander", **{"obfs-password": "synthetic-obfs"})
                d["protocol_options"] = {
                    "obfs": {"type": "salamander", "password": "synthetic-obfs"}
                }
            # Exercise the public parser through a real Mihomo configuration export.
            from app.conversion import to_mihomo

            parsed = parse_document(
                yaml.safe_dump({"proxies": [to_mihomo(d, "synthetic")]}).encode()
            )
            assert parsed.complete
            identities.append(parsed.nodes[0].identity)
            listeners.append(listener)
        # Verify the allowlisted SS methods with the pinned binary as well.
        from app.password_conversion import SS_CIPHERS

        for cipher in sorted(SS_CIPHERS - {"aes-128-gcm"}):
            key_size = 16 if cipher == "2022-blake3-aes-128-gcm" else 32
            secret = (
                base64.b64encode(b"S" * key_size).decode()
                if cipher.startswith("2022-")
                else password
            )
            address = port()
            listeners.append(
                {
                    "name": "ss-" + cipher,
                    "type": "shadowsocks",
                    "listen": "127.0.0.1",
                    "port": address,
                    "cipher": cipher,
                    "password": secret,
                }
            )
            identities.append(
                {
                    **identities[0],
                    "server_port": address,
                    "password": secret,
                    "protocol_options": {"cipher": cipher},
                }
            )
        for protocol, transport in (
            ("trojan", "ws"),
            ("trojan", "grpc"),
            ("vmess", "ws"),
            ("vless", "ws"),
        ):
            address = port()
            base = next(d for d in identities if d["protocol"] == protocol)
            listener = dict(next(item for item in listeners if item["type"] == protocol))
            listener.update(
                name=protocol + "-" + transport,
                port=address,
                certificate=cert,
                **{"private-key": key},
            )
            option = (
                {"path": "/synthetic-ws"}
                if transport == "ws"
                else {"service_name": "synthetic-grpc"}
            )
            listener["ws-path" if transport == "ws" else "grpc-service-name"] = next(
                iter(option.values())
            )
            listeners.append(listener)
            identities.append(
                {
                    **base,
                    "server_port": address,
                    "transport": transport,
                    "security": "tls",
                    "tls": {"sni": "localhost", "insecure": True},
                    "transport_options": option,
                }
            )
        reality_key = X25519PrivateKey.generate()
        reality_private = (
            base64.urlsafe_b64encode(
                reality_key.private_bytes(
                    serialization.Encoding.Raw,
                    serialization.PrivateFormat.Raw,
                    serialization.NoEncryption(),
                )
            )
            .decode()
            .rstrip("=")
        )
        reality_public = (
            base64.urlsafe_b64encode(
                reality_key.public_key().public_bytes(
                    serialization.Encoding.Raw, serialization.PublicFormat.Raw
                )
            )
            .decode()
            .rstrip("=")
        )
        reality_port, short_id = port(), secrets.token_hex(8)
        listeners.append(
            {
                "name": "vless-reality",
                "type": "vless",
                "listen": "127.0.0.1",
                "port": reality_port,
                "users": [{"username": "synthetic", "uuid": uuid, "flow": "xtls-rprx-vision"}],
                "reality-config": {
                    "dest": f"127.0.0.1:{http.server_port}",
                    "private-key": reality_private,
                    "short-id": [short_id],
                    "server-names": ["localhost"],
                },
            }
        )
        identities.append(
            {
                "protocol": "vless",
                "uuid": uuid,
                "server_host": "127.0.0.1",
                "server_port": reality_port,
                "transport": "tcp",
                "security": "reality",
                "tls": {
                    "sni": "localhost",
                    "client_fingerprint": "chrome",
                    "reality": {"public_key": reality_public, "short_id": short_id},
                },
                "transport_options": {},
                "protocol_options": {"flow": "xtls-rprx-vision"},
            }
        )
        controller = port()
        controller_secret = secrets.token_urlsafe(32)
        config = {
            "allow-lan": False,
            "bind-address": "127.0.0.1",
            "mode": "rule",
            "log-level": "silent",
            "external-controller": f"127.0.0.1:{controller}",
            "secret": controller_secret,
            "dns": {"enable": False},
            "profile": {"store-selected": False},
            "listeners": listeners,
            "rules": ["MATCH,DIRECT"],
        }
        config_path = directory / "server.yaml"
        private_file(config_path, yaml.safe_dump(config).encode())
        process = None
        checker = None
        try:
            valid = subprocess.run(
                [binary, "-t", "-d", temporary, "-f", str(config_path)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
            )
            if valid.returncode:
                raise AssetError("LOCAL_SERVER_CONFIG_REJECTED")
            process = subprocess.Popen(
                [binary, "-d", temporary, "-f", str(config_path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            deadline = time.monotonic() + 8
            while True:
                if process.poll() is not None:
                    raise AssetError("LOCAL_SERVER_START_FAILED")
                try:
                    with httpcore.ConnectionPool() as pool:
                        response = pool.request(
                            "GET",
                            f"http://127.0.0.1:{controller}/version",
                            headers={"Authorization": "Bearer " + controller_secret},
                            extensions={"timeout": {"connect": 0.2, "read": 0.2}},
                        )
                    if response.status == 200:
                        break
                except (httpcore.NetworkError, httpcore.TimeoutException):
                    pass
                if time.monotonic() > deadline:
                    raise AssetError("LOCAL_SERVER_START_TIMEOUT")
                time.sleep(0.05)
            settings = Settings(
                _env_file=None,
                database_url="postgresql+psycopg://unused",
                encryption_key_b64=base64.b64encode(b"E" * 32).decode(),
                fingerprint_key_b64=base64.b64encode(b"H" * 32).decode(),
            )
            checker = HealthChecker(settings, runtime=Mihomo(binary), echo=LocalEcho(), geoip=Geo())
            checker.preflight()
            for identity in identities:
                result = checker.check(identity, "synthetic")
                if result.status != "UP":
                    raise AssetError("HANDSHAKE_FAILED_" + identity["protocol"].upper())
                label = identity["protocol"]
                if label == "shadowsocks":
                    label += "/" + identity["protocol_options"]["cipher"]
                else:
                    label += "/" + identity["transport"] + "/" + identity["security"]
                print(label + ": LOCAL_HANDSHAKE_AND_HTTPS_OK", flush=True)
            pid = checker.runtime.process.pid
            # Same name, server and protocol, but a different identity: no old
            # authenticated connection or cached proxy may survive the reload.
            identity = next(
                d for d in identities if d["protocol"] == "vless" and d["security"] == "tls"
            )
            invalid = copy.deepcopy(identity)
            invalid["uuid"] = "00000000-0000-4000-8000-000000000099"
            if checker.check(invalid, "synthetic").status in ("UP", "DEGRADED"):
                raise AssetError("STALE_AUTHENTICATED_CONNECTION")
            if checker.check(identity, "synthetic").status != "UP":
                raise AssetError("VALID_IDENTITY_RECOVERY_FAILED")
            if checker.runtime.process.pid != pid or checker.runtime.metrics["runtime_starts"] != 1:
                raise AssetError("RUNTIME_REUSE_FAILED")

            # Pin an otherwise unresolvable hostname while retaining the original SNI.
            class Resolver:
                def resolve_name(self, *args, **kwargs):
                    class Answer:
                        def addresses(self):
                            return ["127.0.0.1"]

                    return Answer()

            checker.cache.resolver = Resolver()
            pinned = copy.deepcopy(identity)
            pinned["server_host"] = "synthetic.invalid"
            if checker.check(pinned, "synthetic").status != "UP":
                raise AssetError("RESOLVED_HOST_PINNING_FAILED")
            print("reuse/same-name-invalid-auth/recovery/dns-pinning: OK", flush=True)
        finally:
            if checker:
                checker.close()
            if process:
                process.terminate()
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=3)
            http.shutdown()
            http.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", default="private/bin/mihomo")
    try:
        main(parser.parse_args().binary)
    except AssetError as error:
        print(error.code, file=sys.stderr)
        sys.exit(1)
