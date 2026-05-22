# gemini-orphan-toolcall

Real session state captured from a `balanced:xai` session where the next
user turn ("Yes. I'm going to give the doc to a coding agent…") triggered
a Vertex 400 on `google/gemini-3.1-flash-lite-preview`:

> Please ensure that the number of function response parts is equal to the
> number of function call parts of the function call turn.

The Gemini lite-preview model is used for auxiliary calls (e.g. memory /
title generation), not the main turn — so the bug is in how that
side-channel reshapes the transcript before calling Vertex, not in the
primary balanced router.

Pairing in the raw `TurnState` is intact (25 toolCalls, 25 toolResults,
no orphans), so the corruption is introduced downstream of state, in the
wire-shaping path for that auxiliary call.

Source: session `ms782syvyx9q9vpfdwbcdg37s5872bk9`, gen
`gen_01KS6J16MPCTAVZVK6HSQQSKFD`.
