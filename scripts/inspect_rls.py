#!/usr/bin/env python3
"""Inspect RLS status and policies for Clicktide Supabase tables."""

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
    with psycopg.connect(os.environ["SUPABASE_DB_URL"], connect_timeout=10) as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                select relname, relrowsecurity
                from pg_class
                where relnamespace = 'public'::regnamespace
                  and relname = any(%s)
                order by relname
                """,
                (list(TABLES),),
            )
            rls_rows = cur.fetchall()

            cur.execute(
                """
                select tablename, policyname, cmd, qual, with_check
                from pg_policies
                where schemaname = 'public'
                  and tablename = any(%s)
                order by tablename, policyname
                """,
                (list(TABLES),),
            )
            policy_rows = cur.fetchall()

    print("RLS status")
    for table, enabled in rls_rows:
        print(f"  {table}: {'enabled' if enabled else 'disabled'}")

    print("\nPolicies")
    if not policy_rows:
        print("  none")
    for table, policy, cmd, using_expr, check_expr in policy_rows:
        print(f"  {table}.{policy}: {cmd}")
        print(f"    using: {using_expr}")
        print(f"    check: {check_expr}")


if __name__ == "__main__":
    main()

