from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
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
sys.modules["official_image"] = official_image
run_with_metrics = load("run_with_metrics", "run_with_metrics.py")
score_predictions = load("score_predictions", "score_predictions.py")


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


class ScorePredictionsTest(unittest.TestCase):
    def test_relative_output_root_still_passes_a_readable_prediction_path(self) -> None:
        row = {
            "instance_id": "org__repo-1",
            "model_name_or_path": "model",
            "model_patch": "diff --git a/a b/a\n",
        }

        with tempfile.TemporaryDirectory() as directory:
            previous_cwd = Path.cwd()
            os.chdir(directory)
            try:
                def run(command, *, cwd, check):
                    prediction_arg = Path(command[command.index("--predictions_path") + 1])
                    readable_path = prediction_arg if prediction_arg.is_absolute() else Path(cwd) / prediction_arg
                    self.assertEqual(json.loads(readable_path.read_text()), row)
                    run_id = command[command.index("--run_id") + 1]
                    (Path(cwd) / f"result.{run_id}.json").write_text(
                        json.dumps({"resolved_ids": [row["instance_id"]]})
                    )

                with (
                    patch.object(score_predictions, "resolve_image", return_value="image"),
                    patch.object(score_predictions, "pull_image"),
                    patch.object(score_predictions, "remove_if_present"),
                    patch.object(score_predictions.subprocess, "run", side_effect=run),
                ):
                    result = score_predictions.score_one(row, Path("scores"))
            finally:
                os.chdir(previous_cwd)

        self.assertEqual(
            result,
            {"instanceId": "org__repo-1", "model": "model", "status": "resolved"},
        )

    def test_scores_every_arm_before_removing_one_instance_image(self) -> None:
        rows = [
            {
                "instance_id": "org__repo-1",
                "model_name_or_path": model,
                "model_patch": "diff",
            }
            for model in ("model-a", "model-b")
        ]
        expected = [
            {"instanceId": "org__repo-1", "model": row["model_name_or_path"], "status": "resolved"}
            for row in rows
        ]

        with (
            patch.object(score_predictions, "resolve_image", return_value="official/image") as resolve,
            patch.object(score_predictions, "pull_image") as pull,
            patch.object(score_predictions, "remove_if_present") as remove,
            patch.object(score_predictions, "score_one", side_effect=expected) as score,
        ):
            results = score_predictions.score_instance(rows, Path("scores"))

        self.assertEqual(results, expected)
        resolve.assert_called_once_with("org__repo-1")
        pull.assert_called_once_with("official/image")
        remove.assert_called_once_with("official/image")
        self.assertEqual([call.args[0] for call in score.call_args_list], rows)


if __name__ == "__main__":
    unittest.main()
