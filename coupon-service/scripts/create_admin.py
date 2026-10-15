"""Create or reset a PF Admin account. The password is hashed with argon2 and never stored in plain text.

   python -m scripts.create_admin --username admin                       (prompts for the password)
   ADMIN_PASSWORD=... python -m scripts.create_admin --username admin    (non-interactive)
"""
import argparse
import asyncio
import getpass
import os
import sys

from sqlalchemy import text

from app import service as svc
from app.db import SessionLocal, init_db


async def main(username: str, password: str):
    await init_db()
    async with SessionLocal() as s:
        await s.execute(text(
            "INSERT INTO admin_users(username,password_hash) VALUES (:u,:h) "
            "ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash"),
            {"u": username, "h": svc.ph.hash(password)})
        await s.execute(text(    # changing a password signs that admin out everywhere
            "DELETE FROM admin_sessions WHERE admin_id=(SELECT id FROM admin_users WHERE username=:u)"),
            {"u": username})
        await s.commit()
    print(f"Admin '{username}' is ready.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--username", default="admin")
    a = ap.parse_args()
    pw = os.environ.get("ADMIN_PASSWORD") or getpass.getpass("Password: ")
    if not os.environ.get("ADMIN_PASSWORD") and pw != getpass.getpass("Repeat password: "):
        sys.exit("Passwords do not match.")
    if len(pw) < 10:
        sys.exit("Use at least 10 characters.")
    asyncio.run(main(a.username.strip().lower(), pw))
