from __future__ import annotations

import base64
import os

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _base64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def encryption_key(raw: str) -> bytes:
    try:
        key = base64.b64decode(str(raw), validate=True)
    except Exception as exc:
        raise ValueError(
            "TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key."
        ) from exc
    if len(key) != 32 or base64.b64encode(key).decode("ascii") != raw:
        raise ValueError("TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.")
    return key


def encrypt_secret(
    value: object | None, raw_key: str, *, iv: bytes | None = None
) -> str | None:
    if value is None or value == "":
        return None
    nonce = os.urandom(12) if iv is None else iv
    if len(nonce) != 12:
        raise ValueError("AES-GCM IV must be 12 bytes.")
    encrypted = AESGCM(encryption_key(raw_key)).encrypt(
        nonce, str(value).encode("utf-8"), None
    )
    ciphertext, tag = encrypted[:-16], encrypted[-16:]
    return f"v1.{_base64url_encode(nonce)}.{_base64url_encode(tag)}.{_base64url_encode(ciphertext)}"


def decrypt_secret(payload: str | None, raw_key: str) -> str | None:
    if not payload:
        return None
    parts = str(payload).split(".")
    if len(parts) != 4 or parts[0] != "v1" or not all(parts[1:]):
        raise ValueError("Invalid encrypted secret.")
    try:
        nonce, tag, ciphertext = (_base64url_decode(value) for value in parts[1:])
        plaintext = AESGCM(encryption_key(raw_key)).decrypt(
            nonce, ciphertext + tag, None
        )
    except Exception as exc:
        raise ValueError("Invalid encrypted secret.") from exc
    return plaintext.decode("utf-8")
