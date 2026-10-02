#!/usr/bin/env python3
"""Regenerate unique source anchors from a reviewed checkout's package changes."""
import argparse
import difflib
import json
import subprocess
from pathlib import Path


def git(root: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(root), *args]).decode("utf-8").replace("\r\n", "\n")


def capture(root: Path, base: str, output: Path) -> None:
    changed = git(root, "diff", "--name-only", base, "--", "packages").splitlines()
    added = git(root, "ls-files", "--others", "--exclude-standard", "--", "packages").splitlines()
    added += git(root, "diff", "--name-only", "--diff-filter=A", base, "--", "packages").splitlines()
    edits = []
    for file in sorted(set(changed + added)):
        new = (root / file).read_text(encoding="utf-8")
        if file in added:
            edits.append({"file": file, "create": True, "replace": new})
            continue
        old = git(root, "show", f"{base}:{file}")
        before, after = old.splitlines(keepends=True), new.splitlines(keepends=True)
        grouped = list(difflib.SequenceMatcher(None, before, after, autojunk=False).get_grouped_opcodes(5))
        file_edits = []
        for group in grouped:
            find = "".join(before[group[0][1]:group[-1][2]])
            replacement = "".join(after[group[0][3]:group[-1][4]])
            if not find or old.count(find) != 1:
                file_edits = [{"file": file, "find": old, "replace": new, "expect": 1}]
                break
            file_edits.append({"file": file, "find": find, "replace": replacement, "expect": 1})
        edits.extend(file_edits)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "name": "windows-reconnect", "base": base,
        "base_commit": git(root, "rev-parse", f"{base}^{{commit}}").strip(),
        "description": "Local process retry controls, hidden clipboard commands, and patched update protection.",
        "edits": edits,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"captured {len(edits)} edits into {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--base", default="v1.18.34")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "patches/windows-reconnect.json")
    args = parser.parse_args()
    capture(args.root.resolve(), args.base, args.output)
