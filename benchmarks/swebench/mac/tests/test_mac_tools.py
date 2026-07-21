from __future__ import annotations

import importlib.util
import json
import os
import subprocess
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
    def test_rejects_duplicate_official_run_identities(self) -> None:
        row = {
            "instance_id": "org__repo-1",
            "model_name_or_path": "duet-glm-pure",
            "model_patch": "diff",
        }

        with self.assertRaisesRegex(ValueError, "duplicate official scorer identity"):
            score_predictions.score_instance([row, row.copy()], Path("scores"))

    def test_scores_all_arms_before_releasing_the_shared_image(self) -> None:
        rows = [
            {
                "instance_id": "org__repo-1",
                "model_name_or_path": model,
                "model_patch": "diff",
            }
            for model in ("model-a", "model-b")
        ]
        image_present = False

        def pull(_image: str) -> dict[str, object]:
            nonlocal image_present
            image_present = True
            return {
                "image": _image,
                "imageId": f"sha256:{'a' * 64}",
                "platform": "linux/amd64",
                "sizeBytes": 1,
            }

        def remove(_image: str) -> None:
            nonlocal image_present
            image_present = False

        def run(command, *, cwd, check):
            nonlocal image_present
            if not image_present:
                raise subprocess.CalledProcessError(1, command)
            run_id = command[command.index("--run_id") + 1]
            instance_id = command[command.index("--instance_ids") + 1]
            (Path(cwd) / f"result.{run_id}.json").write_text(
                json.dumps({"resolved_ids": [instance_id]})
            )
            if command[command.index("--clean") + 1] == "true":
                image_present = False

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(score_predictions, "resolve_image", return_value="official/image"),
            patch.object(score_predictions, "pull_image", side_effect=pull),
            patch.object(score_predictions, "remove_if_present", side_effect=remove),
            patch.object(score_predictions.subprocess, "run", side_effect=run),
        ):
            results = score_predictions.score_instance(rows, Path(directory))

        self.assertEqual(
            results,
            [
                {"instanceId": "org__repo-1", "model": "model-a", "status": "resolved"},
                {"instanceId": "org__repo-1", "model": "model-b", "status": "resolved"},
            ],
        )

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

        with tempfile.TemporaryDirectory() as directory:
            with (
                patch.object(
                    score_predictions, "resolve_image", return_value="official/image"
                ) as resolve,
                patch.object(
                    score_predictions,
                    "pull_image",
                    return_value={
                        "image": "official/image",
                        "imageId": f"sha256:{'a' * 64}",
                        "platform": "linux/amd64",
                        "sizeBytes": 1,
                    },
                ) as pull,
                patch.object(score_predictions, "remove_if_present") as remove,
                patch.object(score_predictions, "score_one", side_effect=expected) as score,
            ):
                results = score_predictions.score_instance(rows, Path(directory))

        self.assertEqual(results, expected)
        resolve.assert_called_once_with("org__repo-1")
        pull.assert_called_once_with("official/image")
        remove.assert_called_once_with(f"sha256:{'a' * 64}")
        self.assertEqual([call.args[0] for call in score.call_args_list], rows)

    def test_records_the_exact_pulled_image_used_by_the_scorer(self) -> None:
        row = {
            "instance_id": "org__repo-1",
            "model_name_or_path": "model",
            "model_patch": "diff",
        }
        image_record = {
            "image": "official/image:latest",
            "imageId": f"sha256:{'a' * 64}",
            "platform": "linux/amd64",
            "sizeBytes": 123,
        }

        with (
            tempfile.TemporaryDirectory() as directory,
            patch.object(score_predictions, "resolve_image", return_value=image_record["image"]),
            patch.object(score_predictions, "pull_image", return_value=image_record),
            patch.object(score_predictions, "remove_if_present"),
            patch.object(
                score_predictions,
                "score_one",
                return_value={
                    "instanceId": row["instance_id"],
                    "model": row["model_name_or_path"],
                    "status": "resolved",
                },
            ),
        ):
            score_predictions.score_instance([row], Path(directory))
            stored = json.loads(
                (Path(directory) / "images" / f"{row['instance_id']}.json").read_text()
            )

        self.assertEqual(stored, image_record)

    def test_refuses_to_overwrite_scorer_image_identity(self) -> None:
        first = {
            "image": "official/image:latest",
            "imageId": f"sha256:{'a' * 64}",
            "platform": "linux/amd64",
            "sizeBytes": 123,
        }
        changed = {**first, "imageId": f"sha256:{'b' * 64}"}

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            score_predictions.write_image_record("org__repo-1", first, root)
            with self.assertRaisesRegex(ValueError, "official image changed"):
                score_predictions.write_image_record("org__repo-1", changed, root)
            stored = json.loads((root / "images" / "org__repo-1.json").read_text())

        self.assertEqual(stored, first)


if __name__ == "__main__":
    unittest.main()
