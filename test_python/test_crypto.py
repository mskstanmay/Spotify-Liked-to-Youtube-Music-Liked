from __future__ import annotations

import json
import subprocess
from pathlib import Path

from musicmove_worker.crypto import decrypt_secret, encrypt_secret

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = json.loads(
    (ROOT / "test_python" / "fixtures" / "crypto_fixture.json").read_text(
        encoding="utf-8"
    )
)


def test_decrypts_fixed_node_aes_gcm_fixture():
    assert decrypt_secret(FIXTURE["payload"], FIXTURE["key"]) == FIXTURE["plaintext"]


def test_deterministic_python_ciphertext_equals_fixed_node_fixture():
    payload = encrypt_secret(
        FIXTURE["plaintext"], FIXTURE["key"], iv=bytes.fromhex(FIXTURE["ivHex"])
    )
    assert payload == FIXTURE["payload"]


def test_node_can_decrypt_python_created_token():
    payload = encrypt_secret("created by python", FIXTURE["key"])
    script = """
const { decryptSecret } = require('./src/auth/security');
process.stdout.write(decryptSecret(process.argv[1], process.argv[2]));
"""
    result = subprocess.run(
        ["node", "-e", script, payload, FIXTURE["key"]],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    assert result.stdout == "created by python"


def test_python_can_decrypt_fresh_node_created_token():
    script = """
const { encryptSecret } = require('./src/auth/security');
process.stdout.write(encryptSecret('created by node', process.argv[1]));
"""
    result = subprocess.run(
        ["node", "-e", script, FIXTURE["key"]],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    assert decrypt_secret(result.stdout, FIXTURE["key"]) == "created by node"
