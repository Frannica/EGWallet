#!/usr/bin/env python3
"""Fail if a release Hermes bundle is missing card-only PaymentSheet symbols."""
from __future__ import annotations

import glob
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REQUIRED = (
    b"buildCardOnlyPaymentSheetParams",
    b"CARD_ONLY_PAYMENT_SHEET_OPTIONS",
)


def bundle_bytes(path: Path) -> bytes:
    if path.suffix == ".aab":
        with zipfile.ZipFile(path) as zf:
            return zf.read("base/assets/index.android.bundle")
    return path.read_bytes()


def main() -> int:
    targets = [ROOT / "_v84.aab"]
    targets.extend(Path(p) for p in glob.glob(str(ROOT / "_export_probe2/**/*.hbc"), recursive=True))
    if len(sys.argv) > 1:
        targets = [Path(p) for p in sys.argv[1:]]

    ok = False
    for target in targets:
        if not target.exists():
            continue
        data = bundle_bytes(target)
        missing = [s.decode() for s in REQUIRED if data.find(s) == -1]
        print(f"{target.name}: size={len(data)} missing={missing or 'none'}")
        if not missing:
            ok = True
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
