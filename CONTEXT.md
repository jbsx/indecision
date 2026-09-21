# Indecision

A personal tool that replaces the coin flip. You describe a choice you're stuck on; a language model argues each side; a calibrated decision model (jev) picks. The pick is meant to be trusted, not surrendered to.

## Language

**Dilemma**:
The raw natural-language utterance describing a choice the user is stuck on, exactly as they wrote it.
_Avoid_: situation, prompt, question, input

**Option**:
One candidate the user could choose. An Option is only ever stated by the user, never invented, with one exception: a Dilemma that names a single Option implies its refusal ("don't") as the second.
_Avoid_: choice, candidate, alternative, case

**Case**:
The argument for and against one Option. Written by an advocate that must argue every Option with equal effort and must not conclude.
_Avoid_: reasoning, analysis, pros and cons, recommendation

**Advocate**:
The role that writes the Cases. It extracts the Options from a Dilemma and argues them; it never decides.
_Avoid_: LLM, translator, assistant

**Judge**:
The role that weighs the Cases and picks an Option. Played by jev and nothing else.
_Avoid_: model, oracle, AI

**Verdict**:
The Judge's pick, together with a probability for every Option and a confidence in the pick. A close Verdict is still a Verdict.
_Avoid_: decision, result, answer, flip

**Close call**:
A Verdict whose probabilities are nearly even. Reported as such; never resolved by randomness.
_Avoid_: toss-up, tie, coin flip
