#!/usr/bin/env python3
"""Validate every exact-match anchor before writing an OpenCode checkout."""
import argparse
import json
import os
from pathlib import Path

PATCHES = Path(__file__).resolve().parents[1] / "patches"


def apply(root: Path, patch_dir: Path = PATCHES, check: bool = False) -> None:
    root = root.resolve()
    if not (root / "packages/opencode/package.json").is_file():
        raise ValueError(f"Not an OpenCode checkout: {root}")
    patches = sorted(patch_dir.glob("*.json"))
    if not patches:
        raise ValueError(f"No patches found in {patch_dir}")
    texts: dict[Path, str] = {}
    original: dict[Path, bytes | None] = {}
    errors: list[str] = []
    count = 0
    for patch in patches:
        data = json.loads(patch.read_text(encoding="utf-8"))
        edits = data.get("edits")
        if not isinstance(edits, list) or not edits:
            raise ValueError(f"Empty or invalid patch: {patch.name}")
        for edit in edits:
            target = (root / edit["file"]).resolve()
            if not target.is_relative_to(root) or target == root:
                raise ValueError(f"Patch path escapes checkout: {edit['file']}")
            try:
                if edit.get("create"):
                    if target.exists() or target in texts:
                        raise ValueError("create target already exists")
                    original[target] = None
                    texts[target] = edit["replace"]
                else:
                    if target not in texts:
                        original[target] = target.read_bytes()
                        texts[target] = original[target].decode("utf-8").replace("\r\n", "\n")
                    find = edit["find"]
                    if not find:
                        raise ValueError("empty anchor")
                    expect = edit.get("expect", 1)
                    found = texts[target].count(find)
                    if found != expect:
                        raise ValueError(f"anchor mismatch: expected {expect}, found {found}")
                    texts[target] = texts[target].replace(find, edit["replace"], expect)
                count += 1
            except (ValueError, OSError) as error:
                errors.append(f"{patch.name}: {edit['file']}: {error}")
    if errors:
        raise ValueError("\n".join(errors))
    if check:
        print(f"check passed: {count} edits in {len(texts)} files; no files written")
        return
    for target, content in original.items():
        if (target.read_bytes() if target.exists() else None) != content:
            raise ValueError(f"Concurrent modification: {target}")
    for target, content in texts.items():
        raw = original[target]
        if raw is not None and b"\r\n" in raw:
            content = content.replace("\n", "\r\n")
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".opencode-patch.tmp")
        with temporary.open("xb") as stream:
            stream.write(content.encode("utf-8"))
        os.replace(temporary, target)
    print(f"applied {count} edits across {len(texts)} files")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        apply(args.root, check=args.check)
    except (ValueError, OSError) as error:
        parser.exit(1, f"error: {error}\n")
