import { describe, expect, test } from "bun:test";

import { DEEPSWE_TEMPLATE_APT_PACKAGES } from "../e2b/template.js";

describe("DeepSWE E2B template", () => {
  test("installs Bun's archive extractor before running its installer", () => {
    expect(DEEPSWE_TEMPLATE_APT_PACKAGES).toContain("unzip");
  });
});
