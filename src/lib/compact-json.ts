/**
 * Width-aware JSON formatter for tool call arguments.
 *
 * `JSON.stringify(value, null, 2)` always pushes opening/closing braces and
 * each key onto its own line, which makes short tool inputs like
 * `{"path": "src/cli.ts"}` render as four lines. This formatter keeps small
 * objects and arrays inline and only breaks across lines when the inline form
 * would exceed `maxWidth` columns at the current indentation depth.
 */
export function formatCompactJson(value: unknown, maxWidth = 100, indent = 2): string {
  return format(value, 0, maxWidth, indent);
}

function format(value: unknown, depth: number, maxWidth: number, indent: number): string {
  const inline = JSON.stringify(value);
  if (inline === undefined) return "undefined";

  // Leaves and short composites render inline.
  if (typeof value !== "object" || value === null) return inline;
  if (depth * indent + inline.length <= maxWidth) return inline;

  const pad = " ".repeat((depth + 1) * indent);
  const closePad = " ".repeat(depth * indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((item) => `${pad}${format(item, depth + 1, maxWidth, indent)}`);
    return `[\n${items.join(",\n")}\n${closePad}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return "{}";
  const items = entries.map(
    ([key, item]) => `${pad}${JSON.stringify(key)}: ${format(item, depth + 1, maxWidth, indent)}`,
  );
  return `{\n${items.join(",\n")}\n${closePad}}`;
}
