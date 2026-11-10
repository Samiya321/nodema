import hashlib
import hmac
import json
import os
import struct

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from app.domain import AssetError, NormalizedNode

FINGERPRINT_VERSION = 1


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")


def fingerprint(node: NormalizedNode, key: bytes) -> bytes:
    if len(key) != 32:
        raise AssetError("INVALID_KEYS")
    return hmac.digest(key, b"nodema:identity:v1\0" + canonical_json(node.identity), hashlib.sha256)


class Cipher:
    """v1 envelope: magic(4), key-id length(1), key-id, nonce(12), ciphertext+tag."""

    def __init__(self, key: bytes, key_id: str):
        if len(key) != 32 or not 1 <= len(key_id.encode("ascii")) <= 32:
            raise AssetError("INVALID_KEYS")
        self._aes = AESGCM(key)
        self._key_id = key_id.encode("ascii")

    def encrypt(self, plaintext: bytes, *, context: str) -> bytes:
        header = b"NMA1" + struct.pack("B", len(self._key_id)) + self._key_id
        nonce = os.urandom(12)
        aad = header + b"\0" + context.encode("ascii")
        return header + nonce + self._aes.encrypt(nonce, plaintext, aad)

    def decrypt(self, envelope: bytes, *, context: str) -> bytes:
        try:
            if len(envelope) < 34 or envelope[:4] != b"NMA1":
                raise ValueError
            size = envelope[4]
            if not 1 <= size <= 32 or envelope[5 : 5 + size] != self._key_id:
                raise ValueError
            header = envelope[: 5 + size]
            nonce = envelope[5 + size : 17 + size]
            return self._aes.decrypt(
                nonce, envelope[17 + size :], header + b"\0" + context.encode("ascii")
            )
        except (InvalidTag, ValueError, TypeError, IndexError):
            raise AssetError("DECRYPTION_FAILED") from None
