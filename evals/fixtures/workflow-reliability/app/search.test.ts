import { expect, test } from "bun:test";
import { search } from "./search.js";
test("search has no matches for an unknown query", async () => {
  expect((await search("people", "volcanologists on Neptune", "smoke")).ids).toEqual([]);
});
