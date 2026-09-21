---
status: accepted
---

# Jev decides; the language model only argues

The tool exists to give a decision the user can trust more than a coin flip. A generative LLM could both argue and pick, which would be cheaper and single-vendor, but an LLM's pick is a persuasive essay and the user would be back to deciding whether to believe it. We split the roles instead: a generative model (Anthropic) is the Advocate and writes a symmetric for-and-against Case per Option without ever concluding, and jev (TypeSafe AI's calibrated decision model) is the Judge and returns the Verdict. The Cases go into jev's `state` as evidence; jev's `criteria` carries only the bare Option labels so the rubric cannot smuggle in a preference.

## Considered options

- **LLM decides directly**: rejected; the pick would be an opinion, not a calibrated judgment, and it removes the reason for the tool to exist.
- **Weighted or uniform random pick over jev's probabilities**: rejected; the user explicitly wants to remove the "the universe decided" feeling. Randomness never enters the Verdict, even on a close call.
- **Cases in jev's `criteria` instead of `state`**: rejected; arguments are evidence and belong in `state`. Criteria must stay neutral.

## Consequences

- Two vendors and two API keys are required. There is no LLM-only fallback; without a jev key the tool does not run.
- The Advocate prompt must enforce symmetry (same number of points for and against every Option) and forbid conclusions, because any preference stated in `state` pulls the Judge.
- A close call is reported honestly with its probabilities. A follow-up may let the Advocate sharpen the Cases and re-ask the Judge, but that is a second round of the same pipeline, not a different decision mechanism.
