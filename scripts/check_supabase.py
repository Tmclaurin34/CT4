#!/usr/bin/env python3
"""Check a Supabase Postgres connection from SUPABASE_DB_URL."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def load_dotenv(path: Path) -> None:
    if not path.exists():
        return

    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def main() -> int:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")

    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        print("Missing SUPABASE_DB_URL. Copy .env.example to .env and fill it in.")
        return 2

    try:
        import psycopg
    except ImportError:
        print("Missing psycopg. Run: python3 -m pip install -r requirements.txt")
        return 2

    try:
        with psycopg.connect(db_url, connect_timeout=10) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    select
                        current_database() as database,
                        current_user as user_name,
                        current_schema() as schema_name,
                        inet_server_addr()::text as server_addr,
                        inet_server_port() as server_port
                    """
                )
                row = cur.fetchone()
    except Exception as exc:
        print(f"Connection failed: {exc}")
        return 1

    database, user_name, schema_name, server_addr, server_port = row
    print("Connected to Supabase Postgres")
    print(f"database: {database}")
    print(f"user: {user_name}")
    print(f"schema: {schema_name}")
    print(f"server: {server_addr}:{server_port}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

