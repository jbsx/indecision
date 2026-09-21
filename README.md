# indecision

A personal CLI that replaces the coin flip. You type a Dilemma; an Advocate (Z.ai's GLM) extracts the Options you named and writes a symmetric for-and-against Case for each without concluding; a Judge (TypeSafe AI's jev) weighs the Cases and returns a Verdict: the pick, a probability for every Option, and a confidence. Randomness never enters the Verdict. See `CONTEXT.md` for the vocabulary and `docs/adr/0001` for why the roles are split.

## Setup

```sh
pnpm install
pnpm build
cp .env.example .env   # then fill in ZAI_API_KEY and TYPESAFE_API_KEY
```

Keys are read from the environment, with a `.env` file in the working directory as a fallback. The tool exits with an error before any network call if either key is missing.

The Advocate defaults to `glm-5.3` on Z.ai's GLM Coding Plan endpoint. Set `ZAI_BASE_URL=https://api.z.ai/api/paas/v4` for a pay-as-you-go key, and `ZAI_MODEL` to pick another GLM model.

## Use

```sh
node dist/main.js "Should I go to the gym or rest at home?"
echo "gym or rest?" | node dist/main.js
```

`pnpm link --global` puts the same entry point on your PATH as `indecision`.

The Verdict is printed first, then the Cases. A close call is flagged when the top two probabilities are within 0.1 of each other. Every successful run is appended as one JSON line to `indecision/log.jsonl` under your user data directory (`$XDG_DATA_HOME` on Linux, defaulting to `~/.local/share`).

## Use from a browser

```sh
indecision serve              # listens on 0.0.0.0:3000
PORT=8080 indecision serve    # any other port
```

`indecision serve` starts a plain HTTP server on all interfaces, on the port in `PORT` (default 3000), using the same Advocate, Judge and Log as the CLI. The page has one box for the Dilemma. Submitting it shows the Verdict first (pick, a probability per Option, confidence, and the close-call line when flagged), then every Case, expanded. A Refusal is shown as an outcome with its reason, and the Dilemma stays in the box so it can be reworded. An adapter or network failure shows as an error banner. The body is capped at 8 KiB.

While a run is in progress the page shows where the time is going: "The Advocate is arguing…", then "The Judge is weighing…", then the Verdict, without reloading. The page's script posts to `/decide`, which streams one JSON line per stage and then the outcome. The Cases are never shown before the Verdict. Without JavaScript the form posts to `/` and gets the whole page back once the run is over.

`serve` is a reserved first word: `indecision serve` never starts a Dilemma. Quote it as part of a longer sentence (`indecision "serve or return?"`) and it is a Dilemma again. Nothing per-person is stored; the server appends to the same shared log file as the CLI.

## Develop

```sh
pnpm test        # unit suite: the pipeline with scripted ports, the CLI shell, and the HTTP shell
pnpm typecheck
pnpm smoke       # runs the real Advocate and real Judge on a sample Dilemma; needs both keys
```

The pipeline (`src/decide.ts`) takes the Advocate, Judge and Log as injected ports, plus an optional stage hook it calls just before asking each role; the CLI passes none. Both shells (`src/cli.ts` and `src/serve.ts`) take an injected `decide` and are unit-tested without touching an adapter or binding a port. The real adapters live in `src/advocate`, `src/judge` and `src/log` and are covered only by the smoke script.
