import data from "./data.json" with { type: "json" };
import { interpret } from "./provider.js";

export async function search(category: "jobs" | "people", query: string, nonce: string) {
  const interpreted = await interpret(category, query, nonce);
  const records = category === "jobs" ? data.jobs : [];
  return {
    ids: records.filter((record) => interpreted.ids.includes(record.id)).map((record) => record.id),
    nonce: interpreted.nonce,
  };
}
