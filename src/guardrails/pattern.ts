import type {
  Guardrail,
  GuardrailContext,
  GuardrailResult,
  PatternGuardrailRuleConfig,
} from "../core/types.js";

/**
 * Pattern-based guardrail: fast, deterministic checks using regex.
 * Use for known dangerous patterns (rm -rf /, DROP TABLE, etc).
 */
export class PatternGuardrail implements Guardrail {
  name = "pattern";
  description = "Regex-based action pattern matching";

  constructor(private readonly rules: PatternGuardrailRuleConfig[] = DEFAULT_RULES) {}

  async evaluate(context: GuardrailContext): Promise<GuardrailResult> {
    for (const rule of this.rules) {
      if (rule.pattern.test(context.content)) {
        if (rule.action === "block") {
          return { allowed: false, reason: rule.reason };
        }
        // "warn" still allows but flags it
        return {
          allowed: true,
          reason: `Warning: ${rule.reason}`,
        };
      }
    }
    return { allowed: true };
  }
}

const DEFAULT_RULES: PatternGuardrailRuleConfig[] = [
  {
    pattern: /rm\s+(-rf?|--recursive)\s+\/(?!\w)/,
    action: "block",
    reason: "Destructive: recursive delete at root",
  },
  {
    pattern: /DROP\s+(TABLE|DATABASE)/i,
    action: "block",
    reason: "Destructive: SQL DROP statement",
  },
  {
    pattern: /:(){ :\|:& };:/,
    action: "block",
    reason: "Fork bomb detected",
  },
  {
    pattern: />\s*\/dev\/sd[a-z]/,
    action: "block",
    reason: "Direct write to block device",
  },
  {
    pattern: /mkfs\./,
    action: "block",
    reason: "Filesystem format command",
  },
  {
    pattern: /curl\s.*\|\s*(bash|sh|zsh)/,
    action: "warn",
    reason: "Piping curl to shell — verify the source",
  },
  {
    pattern: /chmod\s+777/,
    action: "warn",
    reason: "Setting world-writable permissions",
  },
  {
    pattern: /--force|--hard|--no-verify/,
    action: "warn",
    reason: "Bypassing safety check",
  },
];
