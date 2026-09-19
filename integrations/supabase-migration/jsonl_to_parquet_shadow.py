#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import duckdb

def sha256_file(path: Path) -> str:
    h=hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""):
            h.update(chunk)
    return h.hexdigest()

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--input-jsonl",required=True)
    ap.add_argument("--output-parquet",required=True)
    ap.add_argument("--manifest",required=True)
    args=ap.parse_args()

    src=Path(args.input_jsonl).resolve()
    dst=Path(args.output_parquet).resolve()
    manifest=Path(args.manifest).resolve()
    if not src.is_file():
        raise SystemExit("input JSONL missing")
    dst.parent.mkdir(parents=True,exist_ok=True)
    manifest.parent.mkdir(parents=True,exist_ok=True)

    con=duckdb.connect(database=":memory:")
    qsrc=str(src).replace("'","''")
    qdst=str(dst).replace("'","''")
    con.execute(f"COPY (SELECT * FROM read_json_auto('{qsrc}', format='newline_delimited')) TO '{qdst}' (FORMAT PARQUET, COMPRESSION ZSTD)")
    rows=con.execute(f"SELECT count(*) FROM read_parquet('{qdst}')").fetchone()[0]
    cols=[r[0] for r in con.execute(f"DESCRIBE SELECT * FROM read_parquet('{qdst}')").fetchall()]
    data={
        "schema":"zeibael.archive_shadow_manifest.v1",
        "source_file":src.name,
        "source_sha256":sha256_file(src),
        "parquet_file":dst.name,
        "parquet_sha256":sha256_file(dst),
        "row_count":rows,
        "columns":cols,
        "canonical_mutation":False,
    }
    manifest.write_text(json.dumps(data,indent=2,sort_keys=True)+"\n")
    print(json.dumps(data,sort_keys=True))

if __name__=="__main__":
    main()
