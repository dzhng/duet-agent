# LongMemEval × duet-agent: Run Plan

## 1. What the benchmark expects from a system-under-test

LongMemEval (ICLR 2025, `xiaowu0162/longmemeval`) is a black-box QA benchmark
over long, timestamped chat histories. The contract is intentionally minimal:

- **Inputs (per instance, from `data/longmemeval_*.json`).** Each of the 500
  instances has:
  - `question_id`, `question_type` (`single-session-user`,
    `single-session-assistant`, `single-session-preference`,
    `temporal-reasoning`, `knowledge-update`, `multi-session`; `_abs` suffix =
    abstention).
  - `question`, `answer`, `question_date`.
  - `haystack_sessions`: ordered list of prior chat sessions, each a list of
    `{role: user|assistant, content}` turns. Evidence turns have
    `has_answer: true`; evidence sessions are listed in `answer_session_ids`.
  - `haystack_session_ids`, `haystack_dates` (timestamps per session).
  - Three sizes: `longmemeval_oracle.json` (evidence sessions only),
    `longmemeval_s.json` (~115k tokens / ~40 sessions, fits 128k models), and
    `longmemeval_m.json` (~500 sessions, too long for long-context).
- **Output format.** A JSONL or JSON file where each line is
  `{"question_id": "...", "hypothesis": "<model answer string>"}`. No
  structure beyond that is required.
- **Scoring.** `src/evaluation/evaluate_qa.py <judge_model> <hyp_file>
<ref_file>` runs an LLM judge (gpt-4o / gpt-4o-mini / llama-3.1-70b via
  local vLLM). It uses task-specific yes/no prompts (`evaluate_qa.py:25-50`)
  including special handling for `temporal-reasoning` (off-by-one tolerated),
  `knowledge-update` (must reflect the updated answer), `preference` (rubric
  match), and abstention (must refuse). The judge writes `autoeval_label` per
  row and prints averaged accuracy; `print_qa_metrics.py` re-aggregates from
  the log. **Retrieval** is also evaluated separately (turn/session recall
  via `has_answer` / `answer_session_ids`), and the 30 abstention items are
  skipped there.

So a system-under-test only has to:

1. Ingest `haystack_sessions` with their `haystack_dates`.
2. At test time, answer `question` (anchored at `question_date`) as a single
   free-text string.

## 2. Smallest viable run against duet-agent's observational memory

Duet's observational memory lives in `src/memory/observational.ts` plus the
`MemorySession` store under `src/memory/{store,session,storage}.ts`, with
CLI entrypoints `src/cli/memory.ts` and `src/cli/memory-reflect.ts`. The
observer/reflector reads chat history, writes `<observation-group>`-wrapped
rows tagged with `cwd`, `sessionId`, `observedDate`, and merges/bumps via
`updateObservationalMemory` / `reflectAllObservations`. Recall happens
through `src/memory/recall.ts` and is injected as `<system-reminder>`
context into the next turn.

The smallest end-to-end harness that exercises _the actual observational
pipeline_ (not the raw store) is a thin Node/Bun script that loops over
instances and, per instance, drives the same APIs the CLI uses:

1. **Per-instance isolation.** Create a fresh dataDir per question
   (`~/.duet-longmemeval/<question_id>/memory.db`) so observations from one
   item never leak into another. Override `cwd` so the project-anchor tag is
   stable (e.g. `cwd = "longmemeval/<question_id>"`).
2. **Ingest each session as one duet "turn".** For each `haystack_sessions[i]`
   with date `haystack_dates[i]`:
   - Build an `AgentMessage[]` from the turns.
   - Call `updateObservationalMemory({ session, messages, sessionId:
haystack_session_ids[i], cwd, observedDate: haystack_dates[i], ... })`
     so the observer extracts and stores observations with the correct
     timestamp (this is what makes temporal-reasoning answerable).
   - Periodically (e.g. every N sessions, or once at the end) call
     `reflectAllObservations({ session, now: question_date })` to mirror
     real-world cross-session reflection. Start with **no global reflect**
     for the first run — it's an extra moving part. Add it as an ablation.
3. **Answer the question.** Two viable readers, in order of fidelity:
   - **A. CLI path (preferred):** spawn `bun src/cli.ts run --no-system-prompt-files
--cwd <per-q dir> "<question>"` with the per-question dataDir bound
     via env (whichever env var `MemorySession` honors — check
     `src/memory/loader.ts`). The recall layer auto-injects observations as
     `<system-reminder>` context; the assistant produces a natural-language
     answer. This is closest to production behavior and exercises recall +
     reflection + prompt assembly.
   - **B. Direct path (faster, less faithful):** call `recall()` to get the
     observation block, build a one-shot prompt `system = <observations>`,
     `user = <question_date>\n<question>`, and call the model directly via
     the Vercel AI Gateway. Useful for sweeping cheaply once A works.
4. **Write hypothesis JSONL.** Append
   `{question_id, hypothesis}` to `hyp.jsonl` after each item.
5. **Score.** Run the unmodified `evaluate_qa.py` against `hyp.jsonl` and
   `longmemeval_oracle.json` (cheapest) first, then `longmemeval_s.json`.

Start scope: **`longmemeval_oracle.json` only**, 20-instance smoke (across
all 6 question types + abstention), reader A, no global reflect, judge =
`gpt-4o-mini`. That validates the harness end-to-end before paying for
500 × full-size runs.

## 3. Datasets / models / API keys required

- **Datasets.** Three JSONs from HuggingFace
  `xiaowu0162/longmemeval-cleaned`: `_oracle`, `_s_cleaned`, `_m_cleaned`.
  Use the cleaned variants (Sep 2025 update). Oracle is small and is the
  right smoke target.
- **Reader model (duet under test).** Whatever duet defaults to via the
  Vercel AI Gateway (currently Anthropic Sonnet family). For a fair
  long-context comparison vs paper baselines, also expose `gpt-4o` and
  `gemini-2.5-pro` via the gateway.
- **Judge model.** `gpt-4o` (paper default) or `gpt-4o-mini` (cheaper,
  good enough for smoke). The scorer requires raw OpenAI, not the gateway.
- **Embeddings.** Duet's observational memory uses its own embedding
  worker; no extra HF model is required unless we also run the paper's
  retrieval baselines.
- **API keys.**
  - `OPENAI_API_KEY` (and optionally `OPENAI_ORGANIZATION`) — required by
    `evaluate_qa.py`.
  - Whatever duet already uses for the AI Gateway (the existing
    `DUET_API_KEY` / gateway envs in this repo).
- **Python env.** `conda create -n longmemeval-lite python=3.9 && pip
install -r requirements-lite.txt` is enough for scoring; we do **not**
  need the full env unless we reproduce paper retrievers.

## 4. Obvious blockers / risks

- **Per-instance store isolation.** `MemorySession` is process-global by
  dataDir; we need to confirm a clean way to point it at a per-question
  dataDir for each item (likely `DUET_DATA_DIR` or equivalent env, or a
  programmatic constructor) without leaking between items. If not exposed,
  add a small `--memory-dir` flag.
- **observedDate honoring.** Confirm `updateObservationalMemory` actually
  stamps `observedDate` from input (vs `Date.now()`). Required for
  `temporal-reasoning` cases. If it currently uses `now`, we need to thread
  an explicit timestamp through the observer.
- **`question_date` for recall.** Recall freshness and decay must use the
  question's date, not wall-clock now, or temporal reasoning collapses.
- **Cost.** 500 instances × ~40 sessions × observer LLM call = nontrivial
  gateway spend on `longmemeval_s`. Budget the smoke first; only scale
  after the harness is green.
- **`longmemeval_m`.** ~500 sessions per instance means O(20k) observer
  calls total. Defer until S works.
- **Abstention.** Duet's assistant tends to answer rather than refuse;
  expect low scores on `_abs` items unless we add an explicit "say you
  don't know if memory lacks evidence" instruction in the reader prompt.
- **JSON length / `enforce_json_length`.** Not relevant for evaluating
  pre-released splits, only for custom history compilation.
- **Eval judge nondeterminism.** `evaluate_qa.py` calls a graded LLM; rerun
  on the same hyp file can drift by ±1-2 pp. Run scoring twice on smoke.

## Exact shell commands

```bash
# --- 0. Clone + pull benchmark (already done) ---
[ -d /Users/david/dev/longmemeval ] || git clone https://github.com/xiaowu0162/longmemeval /Users/david/dev/longmemeval
cd /Users/david/dev/longmemeval && git pull

# --- 1. Download cleaned dataset (oracle + S + M) ---
cd /Users/david/dev/longmemeval
mkdir -p data && cd data
curl -L -O https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json
curl -L -O https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
curl -L -O https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_m_cleaned.json
cd ..

# --- 2. Set up the lite scorer env (one time) ---
conda create -y -n longmemeval-lite python=3.9
conda activate longmemeval-lite
pip install -r requirements-lite.txt

# --- 3. Sanity-check the scorer against a trivially-wrong hyp file ---
#     (just to prove the judge pipeline runs end-to-end before we spend on duet)
python - <<'PY' > /tmp/hyp_dummy.jsonl
import json
for line in open('data/longmemeval_oracle.json'):
    pass
data = json.load(open('data/longmemeval_oracle.json'))
import sys
with open('/tmp/hyp_dummy.jsonl','w') as f:
    for q in data[:10]:
        f.write(json.dumps({"question_id": q["question_id"], "hypothesis": "I don't know."}) + "\n")
PY
export OPENAI_API_KEY=...   # required
cd src/evaluation
python3 evaluate_qa.py gpt-4o-mini /tmp/hyp_dummy.jsonl ../../data/longmemeval_oracle.json
python3 print_qa_metrics.py gpt-4o-mini /tmp/hyp_dummy.jsonl.eval-results-gpt-4o-mini ../../data/longmemeval_oracle.json
cd ../..

# --- 4. (Next step, NOT now) build the duet harness ---
# scripts/longmemeval/run.ts will:
#   - load data/longmemeval_oracle.json
#   - per instance, point MemorySession at a per-question dataDir
#   - ingest each haystack session via updateObservationalMemory()
#     with observedDate = haystack_dates[i]
#   - answer question via `bun src/cli.ts run` or direct gateway call
#   - append {question_id, hypothesis} to runs/longmemeval/hyp.jsonl
# Smoke first: --limit 20 --split oracle --judge gpt-4o-mini.

# --- 5. Score the smoke run ---
# (after step 4 produces runs/longmemeval/hyp.jsonl)
cd /Users/david/dev/longmemeval/src/evaluation
python3 evaluate_qa.py gpt-4o-mini \
  /Users/david/dev/duet-agent/runs/longmemeval/hyp.jsonl \
  ../../data/longmemeval_oracle.json
```

## Suggested next step

Before scaling: confirm the two API contracts in
`src/memory/observational.ts` that the harness depends on —
(a) `updateObservationalMemory` accepts and persists an explicit
`observedDate`, and (b) `MemorySession`/recall can be pointed at a custom
dataDir per process. If either is missing, add it as a small, isolated
change before writing the harness.
