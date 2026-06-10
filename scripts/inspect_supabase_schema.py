#!/usr/bin/env python3
"""List Clicktide tables and columns in the connected Supabase database."""

from __future__ import annotations

import os
from pathlib import Path

import psycopg


TABLES = (
    "clicktide",
    "customers",
    "campaigns",
    "shipments",
    "wallet",
    "oauth_states",
    "platform_connections",
)


def load_dotenv(path: Path) -> None:
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main() -> None:
    load_dotenv(Path(__file__).resolve().parents[1] / ".env")
    db_url = os.environ["SUPABASE_DB_URL"]

    with psycopg.connect(db_url, connect_timeout=10) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select table_name, column_name, data_type
                from information_schema.columns
                where table_schema = 'public'
                  and table_name = any(%s)
                order by table_name, ordinal_position
                """,
                (list(TABLES),),
            )
            rows = cur.fetchall()

    if not rows:
        print("No Clicktide tables found.")
        return

    current = None
    for table_name, column_name, data_type in rows:
        if table_name != current:
            current = table_name
            print(f"\n{table_name}")
        print(f"  {column_name}: {data_type}")


if __name__ == "__main__":
    main()

