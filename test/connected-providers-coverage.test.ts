import { describe, expect, test } from "bun:test";
import {
  FAMILY_LATEST,
  SHORTHANDS_BY_FAMILY,
  transportModelId,
  type FamilyName,
  type TransportName,
} from "../src/model-resolution/catalog.js";
import coverageFixture from "./fixtures/connected-providers-coverage.json" with { type: "json" };

const CONNECTED_TRANSPORTS = [
  "openai-codex",
  "github-copilot",
] as const satisfies readonly TransportName[];

type Coverage = Record<
  FamilyName,
  Record<string, Record<(typeof CONNECTED_TRANSPORTS)[number], string | null>>
>;

describe("connected-provider catalog coverage", () => {
  test("matches the checked-in golden matrix for every catalog model", () => {
    const fixture = coverageFixture as Coverage;
    // Enumerate the catalog, not the fixture: keying off the fixture's own
    // shorthands lets a newly added model pass with zero coverage.
    const actual = Object.fromEntries(
      Object.entries(SHORTHANDS_BY_FAMILY).map(([family, shorthands]) => [
        family,
        Object.fromEntries(
          shorthands.map((shorthand) => [
            shorthand,
            Object.fromEntries(
              CONNECTED_TRANSPORTS.map((transport) => [
                transport,
                transportModelId(transport, shorthand) ?? null,
              ]),
            ),
          ]),
        ),
      ]),
    );

    expect(Object.keys(fixture).sort()).toEqual(Object.keys(FAMILY_LATEST).sort());
    expect(actual).toEqual(fixture);
  });
});
