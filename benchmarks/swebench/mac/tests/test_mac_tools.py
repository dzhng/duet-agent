from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


MAC_DIR = Path(__file__).resolve().parents[1]


def load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, MAC_DIR / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


official_image = load("official_image", "official_image.py")
run_with_metrics = load("run_with_metrics", "run_with_metrics.py")


class OfficialImageTest(unittest.TestCase):
    def test_image_key_comes_from_pinned_harness_spec(self) -> None:
        row = {"instance_id": "org__repo-1"}
        harness_spec = type("HarnessSpec", (), {"instance_image_key": "official/key:tag"})()
        with (
            patch.object(official_image, "load_swebench_dataset", return_value=[row]) as load_dataset,
            patch.object(official_image, "make_test_spec", return_value=harness_spec) as make_spec,
        ):
            self.assertEqual(official_image.resolve_image("org__repo-1"), "official/key:tag")
        load_dataset.assert_called_once_with(
            "SWE-bench/SWE-bench_Multilingual", "test", ["org__repo-1"]
        )
        make_spec.assert_called_once_with(row, namespace="swebench", arch="x86_64")

    def test_unknown_instance_is_rejected(self) -> None:
        with patch.object(official_image, "load_swebench_dataset", return_value=[]):
            with self.assertRaisesRegex(ValueError, "expected one dataset row"):
                official_image.resolve_image("missing")


class MetricsTest(unittest.TestCase):
    def test_binary_and_decimal_docker_sizes(self) -> None:
        self.assertEqual(run_with_metrics.parse_size("1.5GiB"), 1_610_612_736)
        self.assertEqual(run_with_metrics.parse_size("25.2MB"), 25_200_000)
        self.assertEqual(run_with_metrics.parse_size("512B"), 512)


if __name__ == "__main__":
    unittest.main()
