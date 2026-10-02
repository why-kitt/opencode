#!/usr/bin/env python3
import argparse
import hashlib
import json
import subprocess
import shutil
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--root", type=Path, required=True)
parser.add_argument("--tag", required=True)
parser.add_argument("--version", required=True)
parser.add_argument("--output", type=Path, default=Path("artifacts"))
args = parser.parse_args()
builder = Path(__file__).resolve().parents[1]
args.output.mkdir(parents=True, exist_ok=True)
name = f"opencode-{args.version}-windows-x64"
binary = args.root / "packages/opencode/dist/opencode-windows-x64/bin"
if not (binary / "opencode.exe").is_file():
    raise SystemExit(f"Missing Windows binary: {binary}")
commit = subprocess.check_output(["git", "-C", str(args.root), "rev-parse", "HEAD"], text=True).strip()
# Include new patch files without modifying the source checkout's index.
patches = sorted((builder / "patches").glob("*.json"))
created = [edit["file"] for patch in patches for edit in json.loads(patch.read_text(encoding="utf-8"))["edits"] if edit.get("create")]
tracked = set(subprocess.check_output(["git", "-C", str(args.root), "ls-files", "--", "packages"], text=True).splitlines())
diff = subprocess.check_output(["git", "-C", str(args.root), "diff", "HEAD", "--binary", "--", "packages"])
for file in created:
    if file in tracked:
        continue
    result = subprocess.run(["git", "-C", str(args.root), "diff", "--no-index", "--binary", "--", "/dev/null", file], capture_output=True)
    if result.returncode not in (0, 1):
        raise SystemExit(result.stderr.decode("utf-8"))
    diff += result.stdout
patch_file = args.output / f"{name}.patch"
patch_file.write_bytes(diff)
manifest = {
    "upstream": "anomalyco/opencode", "tag": args.tag, "commit": commit, "version": args.version,
    "bun": subprocess.check_output([shutil.which("bun") or "bun", "--version"], text=True).strip(),
    "patch_sha256": hashlib.sha256(diff).hexdigest(),
    "binary_sha256": hashlib.file_digest((binary / "opencode.exe").open("rb"), "sha256").hexdigest(),
}
with zipfile.ZipFile(args.output / f"{name}.zip", "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(binary.rglob("*")):
        if file.is_file():
            archive.write(file, file.relative_to(binary).as_posix())
    archive.write(builder / "RUNNING.md", "README.md")
    archive.write(builder / "reconnect.example.json", "reconnect.example.json")
    archive.writestr("build-info.json", json.dumps(manifest, indent=2) + "\n")
(args.output / f"{name}.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
files = sorted(args.output.glob(name + ".*"))
(args.output / "SHA256SUMS.txt").write_text("".join(
    f"{hashlib.file_digest(file.open('rb'), 'sha256').hexdigest()}  {file.name}\n" for file in files
), encoding="utf-8")
print(json.dumps(manifest, indent=2))
