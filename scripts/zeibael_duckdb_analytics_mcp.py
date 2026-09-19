#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import duckdb
from fastmcp import FastMCP

mcp = FastMCP("zeibael-duckdb-analytics")
ROOT = Path(os.environ.get("ZEIBAEL_DUCKDB_DATA_DIR", "data/analytics")).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
MAX_ROWS = int(os.environ.get("ZEIBAEL_DUCKDB_MAX_ROWS", "500"))

SAFE_PREFIX = re.compile(r"^\s*(select|with|describe|show|summarize|explain)\b", re.I)
FORBIDDEN = re.compile(
    r"\b(insert|update|delete|merge|copy|attach|detach|install|load|pragma|set|call|create|drop|alter|export|import)\b",
    re.I,
)

def _qident(s: str) -> str:
    return '"' + s.replace('"', '""') + '"'

def _qlit(s: str) -> str:
    return "'" + s.replace("'", "''") + "'"

def _view_name(path: Path) -> str:
    rel = path.relative_to(ROOT).as_posix().lower()
    name = re.sub(r"[^a-z0-9]+", "_", rel).strip("_")
    if not name or name[0].isdigit():
        name = "t_" + name
    return name[:120]

def _conn() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect(database=":memory:")
    files = sorted([p for p in ROOT.rglob("*") if p.is_file()])
    used: set[str] = set()
    for p in files:
        ext = p.suffix.lower()
        if ext not in {".parquet", ".csv", ".json", ".jsonl", ".ndjson"}:
            continue
        name = _view_name(p)
        base = name
        i = 2
        while name in used:
            name = f"{base}_{i}"
            i += 1
        used.add(name)
        src = _qlit(str(p))
        if ext == ".parquet":
            expr = f"read_parquet({src})"
        elif ext == ".csv":
            expr = f"read_csv_auto({src})"
        else:
            expr = f"read_json_auto({src})"
        con.execute(f"CREATE TABLE {_qident(name)} AS SELECT * FROM {expr}")
    con.execute("SET enable_external_access=false")
    con.execute("SET autoinstall_known_extensions=false")
    con.execute("SET autoload_known_extensions=false")
    con.execute("SET lock_configuration=true")
    return con

CON = _conn()

@mcp.tool()
def list_tables() -> list[dict[str, Any]]:
    rows = CON.execute(
        "select table_name from information_schema.tables "
        "where table_schema='main' order by table_name"
    ).fetchall()
    return [{"table": r[0]} for r in rows]

@mcp.tool()
def describe_table(table: str) -> list[dict[str, Any]]:
    if not re.fullmatch(r"[A-Za-z0-9_]+", table):
        raise ValueError("invalid table name")
    rows = CON.execute(f"DESCRIBE {_qident(table)}").fetchall()
    return [{"column": r[0], "type": r[1], "null": r[2]} for r in rows]

@mcp.tool()
def query(sql: str) -> dict[str, Any]:
    if not sql or len(sql) > 20000:
        raise ValueError("sql must be 1..20000 characters")
    if ";" in sql.strip().rstrip(";"):
        raise ValueError("multiple statements are forbidden")
    if not SAFE_PREFIX.search(sql) or FORBIDDEN.search(sql):
        raise ValueError("read-only analytical SQL only")
    wrapped = f"SELECT * FROM ({sql.rstrip(';')}) AS zeibael_q LIMIT {MAX_ROWS}"
    cur = CON.execute(wrapped)
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    return {
        "columns": cols,
        "rows": [list(r) for r in rows],
        "row_count": len(rows),
        "max_rows": MAX_ROWS,
        "truncated_possible": len(rows) >= MAX_ROWS,
        "data_root": str(ROOT),
    }

@mcp.tool()
def status() -> dict[str, Any]:
    return {
        "mode": "READ_ONLY_LOCAL_ANALYTICS",
        "data_root": str(ROOT),
        "external_access": False,
        "max_rows": MAX_ROWS,
        "canonical_state_authority": False,
        "live_order_authority": False,
        "supabase_mutation_authority": False,
    }

if __name__ == "__main__":
    mcp.run()
