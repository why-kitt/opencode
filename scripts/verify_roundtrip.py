#!/usr/bin/env python3
"""Apply captured patches to a pristine archive and compare every result to the reviewed tree."""
import argparse
import io
import json
import subprocess
import tarfile
import tempfile
from pathlib import Path
from apply_patches import apply, PATCHES

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--root", required=True, type=Path)
parser.add_argument("--base", default="v1.18.34")
parser.add_argument("--diff", type=Path, help="Validate a packaged .patch instead of the JSON anchors")
args = parser.parse_args()
with tempfile.TemporaryDirectory(prefix="opencode-patch-roundtrip-") as directory:
    data = subprocess.check_output(["git", "-C", str(args.root), "archive", "--format=tar", args.base, "packages"])
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        archive.extractall(directory, filter="data")
    root = Path(directory)
    if args.diff:
        subprocess.run(["git", "-C", str(root), "apply", "--check", str(args.diff.resolve())], check=True)
        subprocess.run(["git", "-C", str(root), "apply", str(args.diff.resolve())], check=True)
    else:
        apply(root, check=True)
        apply(root)
    files = {edit["file"] for patch in PATCHES.glob("*.json") for edit in json.loads(patch.read_text(encoding="utf-8"))["edits"]}
    for file in files:
        if (root / file).read_text(encoding="utf-8") != (args.root / file).read_text(encoding="utf-8"):
            raise SystemExit(f"Round-trip mismatch: {file}")
    print(f"round-trip passed: all {len(files)} files exactly match the reviewed source")
