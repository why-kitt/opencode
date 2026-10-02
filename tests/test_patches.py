import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("apply_patches", Path(__file__).resolve().parents[1] / "scripts/apply_patches.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="opencode-patch-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "source"
        (self.root / "packages/opencode").mkdir(parents=True)
        (self.root / "packages/opencode/package.json").write_text("{}")
        self.patches = Path(self.temporary.name) / "patches"
        self.patches.mkdir()
        self.file = self.root / "source.ts"
        self.file.write_bytes(b"first\r\nsecond\r\n")

    def write(self, edits):
        (self.patches / "test.json").write_text(json.dumps({"edits": edits}), encoding="utf-8")

    def test_dry_run_and_crlf(self):
        self.write([{"file": "source.ts", "find": "first\n", "replace": "updated\n", "expect": 1}])
        module.apply(self.root, self.patches, check=True)
        self.assertEqual(self.file.read_bytes(), b"first\r\nsecond\r\n")
        module.apply(self.root, self.patches)
        self.assertEqual(self.file.read_bytes(), b"updated\r\nsecond\r\n")

    def test_late_mismatch_writes_nothing(self):
        self.write([
            {"file": "source.ts", "find": "first", "replace": "updated"},
            {"file": "new.ts", "create": True, "replace": "new content\n"},
            {"file": "source.ts", "find": "missing", "replace": "broken"},
        ])
        with self.assertRaisesRegex(ValueError, "anchor mismatch"):
            module.apply(self.root, self.patches)
        self.assertEqual(self.file.read_bytes(), b"first\r\nsecond\r\n")
        self.assertFalse((self.root / "new.ts").exists())

    def test_duplicate_anchor_is_rejected(self):
        self.file.write_text("same same")
        self.write([{"file": "source.ts", "find": "same", "replace": "new", "expect": 1}])
        with self.assertRaisesRegex(ValueError, "expected 1, found 2"):
            module.apply(self.root, self.patches)

    def test_create_and_double_apply(self):
        self.write([{"file": "new.ts", "create": True, "replace": "created\n"}])
        module.apply(self.root, self.patches)
        self.assertEqual((self.root / "new.ts").read_text(), "created\n")
        with self.assertRaisesRegex(ValueError, "already exists"):
            module.apply(self.root, self.patches)

    def test_path_escape_is_rejected(self):
        self.write([{"file": "../escape.ts", "create": True, "replace": "escaped"}])
        with self.assertRaisesRegex(ValueError, "escapes checkout"):
            module.apply(self.root, self.patches)
        self.assertFalse((self.root.parent / "escape.ts").exists())


if __name__ == "__main__":
    unittest.main()
