#!/usr/bin/env python3
"""Apply a SQL file to the configured Supabase database."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import psycopg


def load_dotenv(path: Path) -> None:
    for raw_line in path.read_text().splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    load_dotenv(root / ".env")

    if len(sys.argv) != 2:
        print("Usage: apply_sql.py path/to/file.sql")
        return 2

    sql_path = Path(sys.argv[1])
    if not sql_path.is_absolute():
        sql_path = root / sql_path

    with psycopg.connect(os.environ["SUPABASE_DB_URL"], connect_timeout=10) as conn:
        with conn.cursor() as cur:
            cur.execute(sql_path.read_text())
        conn.commit()

    print(f"Applied {sql_path.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

