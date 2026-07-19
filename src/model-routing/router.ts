import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { ClassifierDecision, ClassifierInput, RouteTrigger } from "./classifier.js";
import {
  resolveRoute,
  resolveTierDefault,
  type ResolvedTarget,
  type RouteContext,
  type RouteResolutionCatalog,
} from "./resolve.js";
import type { RoutingTable } from "./table.js";
import { evaluateStepTriggers, type StepObservation, type TurnFacts } from "./step-triggers.js";

/** Classifier seam kept independent from any agent runtime. */
export type RouteClassifier = (
  input: ClassifierInput,
  signal?: AbortSignal,
) => Promise<ClassifierDecision>;

/** Runtime inputs available when the router prepares a parent-agent turn. */
export interface RouterPrepareInput {
  /** Bounded summary of the preceding user-visible turn. */
  prevTurnHint?: string;
  /** Cancels classification without changing router state. */
  signal?: AbortSignal;
}

/** An actual concrete-model or reasoning-effort change selected by the router. */
export interface RouterSwitch {
  /** Virtual tier whose policy selected the target. */
  tier: string;
  /** Final route used after virtual resolution and general fallthrough. */
  route: string;
  /** Previous concrete catalog name. */
  fromModel: string;
  /** New concrete catalog name. */
  toModel: string;
  /** Route-owned reasoning effort applied with the new model. */
  thinkingLevel: ThinkingLevel;
  /** Runtime milestone that requested classification. */
  trigger: RouteTrigger;
  /** Classifier explanation for the selected route. */
  rationale: string;
  /** True when image capability applied the selected route's fallback model. */
  visionFallback: boolean;
}

/** Advisor rate-floor decision measured only in completed parent assistant steps. */
export interface AdvisorGate {
  /** Whether an ordinary advisor call may run at the current step. */
  allowed: boolean;
  /** Additional completed parent assistant steps required before a call is allowed. */
  stepsUntilAllowed: number;
  /** True when another consult already owns the session's advisor slot. */
  inFlight?: boolean;
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
  /** Sticky facts learned from the current user turn's prompt and step outputs. */
  facts: TurnFacts;
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
  private stepTriggerClassificationPending = false;
  private compactionClassificationPending = false;
  private lastAdvisorStep?: number;
  private lastStepDelta?: string;
  private currentTurnHint?: string;
  private lastRationale?: string;
  private pinned = false;
  private advisorConsultInFlight = false;
  private facts: TurnFacts = { hasImages: false };
  /** Precomputed: the tier has exactly one possible destination, so classification is skipped. */
  private readonly singleDestination: boolean;

  constructor(options: ModelRouterOptions) {
    this.table = options.table;
    this.tier = options.tier;
    this.classify = options.classify;
    this.resolveCatalog = options.resolveCatalog;
    this.singleDestination = this.computeSingleDestination();
  }

  /**
   * True when every route in the tier resolves to one identical
   * `{model, effort}` pair, so classification cannot change anything —
   * every classifier call (turn start, cadence, step trigger, advisor
   * milestone) is skipped for the session. Applied per-route vision fallbacks
   * participate because they can add a distinct model/effort destination.
   */
  private computeSingleDestination(): boolean {
    const tier = this.table.tiers[this.tier];
    if (!tier) return false;
    const destinations = new Set<string>();
    for (const routeName of Object.keys(tier.routes)) {
      try {
        for (const hasImages of [false, true]) {
          const resolved = resolveRoute(
            this.table,
            this.tier,
            routeName,
            { hasImages },
            this.resolveCatalog,
          );
          destinations.add(`${resolved.modelName}\u0000${resolved.thinkingLevel}`);
        }
      } catch {
        // An unresolvable route means real routing decisions remain possible;
        // never optimize classification away on a table we cannot fully read.
        return false;
      }
      if (destinations.size > 1) return false;
    }
    return destinations.size === 1;
  }

  /** Resolve and retain the tier's general boot target before the first classifier call. */
  initialTarget(context: RouteContext): ResolvedTarget {
    const target = resolveTierDefault(this.table, this.tier, context, this.resolveCatalog);
    this.current = target;
    return target;
  }

  /**
   * Reset sticky routing facts from the new parent prompt at each user-turn
   * boundary. A pending step-trigger arm deliberately survives: a trigger
   * raised by the FINAL step of a turn has no intra-turn boundary left to
   * consume it, so it rides into this turn's first classification instead of
   * being silently dropped. Completed classifications clear every arm.
   */
  noteTurnStart(input: { promptHasImages: boolean }): void {
    this.facts = { hasImages: input.promptHasImages };
    this.currentTurnHint = undefined;
  }

  /** Record one completed parent assistant step and evaluate its runtime-neutral output summary. */
  noteAssistantStep(observation: StepObservation = { blockTypes: [], text: "" }): void {
    this.assistantSteps += 1;
    this.lastStepDelta = observation.text.trim() || undefined;
    const effects = evaluateStepTriggers(observation, this.table.classifier.stepTriggers);
    for (const effect of effects) {
      this.facts = { ...this.facts, ...effect.facts };
      if (effect.classify) this.stepTriggerClassificationPending = true;
    }
  }

  /** Arm one cap-exempt classification after an independent wire-prefix compaction. */
  noteCompaction(): void {
    this.compactionClassificationPending = true;
  }

  /** Suspend virtual routing while a concrete model is pinned. */
  pin(): void {
    this.pinned = true;
  }

  /** Resume virtual routing without discarding milestones accumulated while pinned. */
  unpin(): void {
    this.pinned = false;
  }

  /** True when a one-shot milestone or completed-step cadence requests classification. */
  shouldClassify(): boolean {
    if (this.pinned || this.singleDestination) return false;
    return (
      this.firstClassificationPending ||
      this.advisorClassificationPending ||
      this.stepTriggerClassificationPending ||
      this.compactionClassificationPending ||
      this.assistantSteps - this.lastClassificationStep >= this.table.classifier.everySteps
    );
  }

  /**
   * Classify and resolve a due route. Provider failure, abort, or invalid
   * resolution is deliberately a no-op so the active model and milestones stay intact.
   */
  async prepareTurn(input: RouterPrepareInput): Promise<RouterSwitch | undefined> {
    if (input.prevTurnHint?.trim()) this.currentTurnHint = input.prevTurnHint;
    if (!this.shouldClassify() || input.signal?.aborted) return undefined;

    const trigger = this.classificationTrigger();
    const previous = this.current;
    try {
      const decision = await this.classify(
        {
          tierName: this.tier,
          tier: this.table.tiers[this.tier]!,
          guidance: this.table.classifier.guidance,
          currentTarget: previous
            ? `${previous.modelName} because route ${previous.route}`
            : undefined,
          prevTurnHint: this.currentTurnHint,
          lastStepDelta: this.lastStepDelta,
          hasImages: this.facts.hasImages,
          trigger,
        },
        input.signal,
      );
      if (input.signal?.aborted) return undefined;

      const context = { hasImages: this.facts.hasImages };
      const next = resolveRoute(
        this.table,
        this.tier,
        decision.route,
        context,
        this.resolveCatalog,
      );
      const baseline = previous ?? this.initialTarget(context);
      this.current = next;
      this.lastRationale = decision.rationale;
      this.lastClassificationStep = this.assistantSteps;
      this.firstClassificationPending = false;
      this.advisorClassificationPending = false;
      this.stepTriggerClassificationPending = false;
      this.compactionClassificationPending = false;

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
        visionFallback: next.visionFallback,
      };
      // A replacement model starts with a fresh advisor floor. Its first
      // consult is authorized by the ordinary gate; a successful consult then
      // starts the normal step-based cooldown again.
      this.lastAdvisorStep = undefined;
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

  /** Atomically authorize one advisor attempt and reserve the session's consult slot. */
  beginAdvisorConsult(): AdvisorGate {
    if (this.advisorConsultInFlight) {
      return { allowed: false, stepsUntilAllowed: 0, inFlight: true };
    }
    const gate = this.advisorGate();
    if (gate.allowed) this.advisorConsultInFlight = true;
    return gate;
  }

  /** Release the consult slot; only success stamps the floor and requests reclassification. */
  endAdvisorConsult(success: boolean): void {
    if (!this.advisorConsultInFlight) return;
    this.advisorConsultInFlight = false;
    if (!success) return;
    this.lastAdvisorStep = this.assistantSteps;
    this.advisorClassificationPending = true;
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
      facts: { ...this.facts },
    };
  }

  private classificationTrigger(): RouterSwitch["trigger"] {
    if (this.firstClassificationPending) return "turn_start";
    if (this.advisorClassificationPending) return "advisor";
    if (this.stepTriggerClassificationPending) return "step_trigger";
    if (this.compactionClassificationPending) return "compaction";
    return "cadence";
  }
}
