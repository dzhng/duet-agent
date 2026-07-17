import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ClassifierDecision, ClassifierInput } from "./classifier.js";
import { renderRerouteNudge } from "./prompts.js";
import {
  resolveRoute,
  resolveTierDefault,
  type ResolvedTarget,
  type RouteContext,
  type RouteResolutionCatalog,
} from "./resolve.js";
import type { RoutingTable } from "./table.js";

/** Classifier seam kept independent from any agent runtime. */
export type RouteClassifier = (
  input: ClassifierInput,
  signal?: AbortSignal,
) => Promise<ClassifierDecision>;

/** Facts available when the router prepares a parent-agent turn. */
export interface RouterPrepareInput extends RouteContext {
  /** Bounded summary of the preceding user-visible turn. */
  prevTurnHint?: string;
  /** Cancels classification without changing router state. */
  signal?: AbortSignal;
}

/** An actual concrete-model or reasoning-effort change selected by the router. */
export interface RouterSwitch {
  /** Virtual tier whose policy selected the target. */
  tier: string;
  /** Final route used after general and vision fallbacks. */
  route: string;
  /** Previous concrete catalog name. */
  fromModel: string;
  /** New concrete catalog name. */
  toModel: string;
  /** Route-owned reasoning effort applied with the new model. */
  thinkingLevel: ThinkingLevel;
  /** Runtime milestone that requested classification. */
  trigger: "turn_start" | "cadence" | "advisor";
  /** Classifier explanation for the selected route. */
  rationale: string;
}

/** Advisor rate-floor decision measured only in completed parent assistant steps. */
export interface AdvisorGate {
  /** Whether an ordinary advisor call may run at the current step. */
  allowed: boolean;
  /** Additional completed parent assistant steps required before a call is allowed. */
  stepsUntilAllowed: number;
}

/** Complete read-only routing snapshot consumed by later CLI and TUI surfaces. */
export interface RouterStatus {
  /** Virtual tier whose routing policy owns this session. */
  tier: string;
  /** Current concrete route, absent only before `initialTarget` is called. */
  route?: string;
  /** Current concrete catalog name, absent only before boot resolution. */
  modelName?: string;
  /** Current route-owned effort, absent only before boot resolution. */
  thinkingLevel?: ThinkingLevel;
  /** Most recent successful classifier explanation. */
  lastRationale?: string;
  /** Number of completed parent assistant messages observed by the router. */
  assistantSteps: number;
  /** Steps remaining before cadence classification; zero means classification is due. */
  stepsUntilClassification: number;
  /** True when virtual routing is suspended by a concrete model pin. */
  pinned: boolean;
  /** Whether this tier exposes the advisor tool. */
  advisorEnabled: boolean;
  /** Current step-based advisor floor. */
  advisorGate: AdvisorGate;
}

export interface ModelRouterOptions {
  /** Complete routing table loaded for this project. */
  table: RoutingTable;
  /** Virtual tier selected for this session. */
  tier: string;
  /** Injected route classifier; production binds it to the table classifier target. */
  classify: RouteClassifier;
  /** Injected concrete-model capability lookup used by route resolution. */
  resolveCatalog: RouteResolutionCatalog;
}

/**
 * Session-local routing state machine. It owns all cadence and interlock policy;
 * callers only report runtime facts and apply returned switches.
 */
export class ModelRouter {
  private readonly table: RoutingTable;
  private readonly tier: string;
  private readonly classify: RouteClassifier;
  private readonly resolveCatalog: RouteResolutionCatalog;
  private current?: ResolvedTarget;
  private assistantSteps = 0;
  private lastClassificationStep = 0;
  private firstClassificationPending = true;
  private advisorClassificationPending = false;
  private lastAdvisorStep?: number;
  private lastStepDelta?: string;
  private lastRationale?: string;
  private pinned = false;
  private rerouteNudge?: string;
  private nudgeExemptionAvailable = false;

  constructor(options: ModelRouterOptions) {
    this.table = options.table;
    this.tier = options.tier;
    this.classify = options.classify;
    this.resolveCatalog = options.resolveCatalog;
  }

  /** Resolve and retain the tier's general boot target before the first classifier call. */
  initialTarget(context: RouteContext): ResolvedTarget {
    const target = resolveTierDefault(this.table, this.tier, context, this.resolveCatalog);
    this.current = target;
    return target;
  }

  /** Record one completed parent assistant message and its lean classification delta. */
  noteAssistantStep(delta?: string): void {
    this.assistantSteps += 1;
    this.lastStepDelta = delta?.trim() || undefined;
  }

  /** Record a successful advisor call and request classification at the next prepare seam. */
  noteAdvisorConsult(): void {
    this.nudgeExemptionAvailable = false;
    this.lastAdvisorStep = this.assistantSteps;
    this.advisorClassificationPending = true;
  }

  /** Suspend virtual routing while a concrete model is pinned. */
  pin(): void {
    this.pinned = true;
  }

  /** Resume virtual routing without discarding milestones accumulated while pinned. */
  unpin(): void {
    this.pinned = false;
  }

  /** True when first-turn, advisor, or completed-step cadence policy requests classification. */
  shouldClassify(): boolean {
    if (this.pinned) return false;
    return (
      this.firstClassificationPending ||
      this.advisorClassificationPending ||
      this.assistantSteps - this.lastClassificationStep >= this.table.classifier.everySteps
    );
  }

  /**
   * Classify and resolve a due route. Provider failure, abort, or invalid
   * resolution is deliberately a no-op so the active model and milestones stay intact.
   */
  async prepareTurn(input: RouterPrepareInput): Promise<RouterSwitch | undefined> {
    if (!this.shouldClassify() || input.signal?.aborted) return undefined;

    const trigger = this.classificationTrigger();
    const previous = this.current;
    try {
      const decision = await this.classify(
        {
          tierName: this.tier,
          tier: this.table.tiers[this.tier]!,
          guidance: this.table.classifier.guidance,
          currentTarget: previous?.modelName,
          prevTurnHint: input.prevTurnHint,
          lastStepDelta: this.lastStepDelta,
          hasImages: input.hasImages,
          trigger,
        },
        input.signal,
      );
      if (input.signal?.aborted) return undefined;

      const next = resolveRoute(this.table, this.tier, decision.route, input, this.resolveCatalog);
      const baseline = previous ?? this.initialTarget(input);
      this.current = next;
      this.lastRationale = decision.rationale;
      this.lastClassificationStep = this.assistantSteps;
      this.firstClassificationPending = false;
      this.advisorClassificationPending = false;

      if (baseline.modelName === next.modelName && baseline.thinkingLevel === next.thinkingLevel) {
        return undefined;
      }

      const switched: RouterSwitch = {
        tier: this.tier,
        route: next.route,
        fromModel: baseline.modelName,
        toModel: next.modelName,
        thinkingLevel: next.thinkingLevel,
        trigger,
        rationale: decision.rationale,
      };
      this.rerouteNudge = undefined;
      this.nudgeExemptionAvailable = false;
      if (switched.trigger !== "advisor") {
        this.rerouteNudge = renderRerouteNudge(switched);
      }
      return switched;
    } catch {
      return undefined;
    }
  }

  /** Current advisor floor; the first successful consult is always allowed. */
  advisorGate(): AdvisorGate {
    if (this.lastAdvisorStep === undefined) return { allowed: true, stepsUntilAllowed: 0 };
    const minStepsBetween = this.table.tiers[this.tier]!.advisor.minStepsBetween;
    const elapsed = this.assistantSteps - this.lastAdvisorStep;
    const stepsUntilAllowed = Math.max(0, minStepsBetween - elapsed);
    return { allowed: stepsUntilAllowed === 0, stepsUntilAllowed };
  }

  /**
   * Authorize one advisor attempt. A delivered reroute nudge overrides the
   * ordinary step floor once; checking the gate burns that privilege even if
   * transcript assembly or the advisor call later fails.
   */
  consumeAdvisorGate(): AdvisorGate {
    if (!this.nudgeExemptionAvailable) return this.advisorGate();
    this.nudgeExemptionAvailable = false;
    return { allowed: true, stepsUntilAllowed: 0 };
  }

  /** Take the latest switch nudge and arm its one-shot advisor-floor exemption. */
  takeRerouteNudge(): string | undefined {
    const nudge = this.rerouteNudge;
    this.rerouteNudge = undefined;
    if (nudge) this.nudgeExemptionAvailable = true;
    return nudge;
  }

  /** Return a detached snapshot; callers never infer routing policy from runner state. */
  status(): RouterStatus {
    const cadenceRemaining = Math.max(
      0,
      this.table.classifier.everySteps - (this.assistantSteps - this.lastClassificationStep),
    );
    return {
      tier: this.tier,
      ...(this.current
        ? {
            route: this.current.route,
            modelName: this.current.modelName,
            thinkingLevel: this.current.thinkingLevel,
          }
        : {}),
      ...(this.lastRationale ? { lastRationale: this.lastRationale } : {}),
      assistantSteps: this.assistantSteps,
      stepsUntilClassification: this.shouldClassify() ? 0 : cadenceRemaining,
      pinned: this.pinned,
      advisorEnabled: this.table.tiers[this.tier]!.advisor.enabled,
      advisorGate: this.advisorGate(),
    };
  }

  private classificationTrigger(): RouterSwitch["trigger"] {
    if (this.firstClassificationPending) return "turn_start";
    if (this.advisorClassificationPending) return "advisor";
    return "cadence";
  }
}
