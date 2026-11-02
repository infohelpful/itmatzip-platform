"""Reset the tools.itmatzip.com admin login (web-ui/tools/admin/_auth.json).

The admin stores only one-way hashes, so a forgotten password cannot be recovered; this writes
new ones. Run it yourself so the password is typed only into this prompt:

    python scripts/reset-admin-auth.py

Then commit and push _auth.json; the cPanel deploy copies it to the server.
Matches admin/api.php: user_hash = sha256(username),
pass_hash = PBKDF2-SHA256(password, salt + pepper, iterations, 32 bytes).
"""
from __future__ import annotations

import getpass
import hashlib
import json
import secrets
import sys
from pathlib import Path

AUTH_FILE = Path(__file__).resolve().parents[1] / "web-ui" / "tools" / "admin" / "_auth.json"
ITERATIONS = 210_000


def main() -> int:
    username = input("새 관리자 아이디: ").strip()
    if not username:
        print("아이디가 비어 있습니다.")
        return 1
    password = getpass.getpass("새 암호 (화면에 보이지 않습니다): ")
    if len(password) < 12:
        print("암호는 12자 이상으로 해 주세요.")
        return 1
    if getpass.getpass("암호 확인: ") != password:
        print("두 암호가 다릅니다.")
        return 1
    salt, pepper = secrets.token_bytes(16), secrets.token_bytes(32)
    auth = {
        "algo": "pbkdf2-sha256",
        "iterations": ITERATIONS,
        "user_hash": hashlib.sha256(username.encode("utf-8")).hexdigest(),
        "salt": salt.hex(),
        "pepper": pepper.hex(),
        "pass_hash": hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt + pepper, ITERATIONS, 32).hex(),
    }
    AUTH_FILE.write_text(json.dumps(auth, indent=2) + "\n", encoding="utf-8")
    print(f"저장했습니다: {AUTH_FILE}")
    print("다음: git add web-ui/tools/admin/_auth.json 후 커밋·푸시하면 서버에 반영됩니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
