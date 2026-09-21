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
INDECISION_PASSPHRASE='open sesame' indecision serve              # listens on 0.0.0.0:3000
INDECISION_PASSPHRASE='open sesame' PORT=8080 indecision serve    # any other port
```

`indecision serve` starts a plain HTTP server on all interfaces, on the port in `PORT` (default 3000), using the same Advocate, Judge and Log as the CLI. The page has one box for the Dilemma. Submitting it shows the Verdict first (pick, a probability per Option, confidence, and the close-call line when flagged), then every Case, expanded. A Refusal is shown as an outcome with its reason, and the Dilemma stays in the box so it can be reworded. An adapter or network failure shows as an error banner. The body is capped at 8 KiB.

While a run is in progress the page shows where the time is going: "The Advocate is arguing…", then "The Judge is weighing…", then the Verdict, without reloading. The page's script posts to `/decide`, which streams one JSON line per stage and then the outcome. The Cases are never shown before the Verdict. The streamed route sits behind the same passphrase and counts toward the same run cap as the form. Without JavaScript the form posts to `/` and gets the whole page back once the run is over.

`serve` is a reserved first word: `indecision serve` never starts a Dilemma. Quote it as part of a longer sentence (`indecision "serve or return?"`) and it is a Dilemma again. Nothing per-person is stored; the server appends to the same shared log file as the CLI.

### The passphrase

Both API keys live on the machine that runs `serve`, so the page is behind one shared passphrase, `INDECISION_PASSPHRASE`. `serve` exits with an error before binding the port when it is unset; the CLI never needs it. There are no accounts and nothing per-person: everyone who knows the passphrase is the same visitor.

A request without a valid cookie sees the passphrase page. Entering the right passphrase sets a cookie good for 30 days and lands on the Dilemma page; a wrong one shows the passphrase page again. There is no logout; to revoke every cookie before it expires, change the passphrase and restart. The cookie holds an expiry signed with a key stretched from the passphrase (scrypt), never the passphrase itself; the server refuses it after the 30 days too, not only the browser. It is not marked `Secure` because the transport is plain HTTP.

### The run cap

At most two runs may be in flight across the whole server; a third submission gets a "busy, try again" page and neither the Advocate nor the Judge is called. The cap is the `MAX_RUNS_IN_FLIGHT` constant in `src/serve.ts`, not a setting: it bounds what a burst of submissions can spend, and raising it should be a code change someone reads.

## Deploy on a Raspberry Pi

`serve` is meant to run on a Pi that is port-forwarded to the internet. The Pi holds the keys; the passphrase and the cap decide who can spend them and how fast.

**Plain HTTP sends everything in clear.** Until TLS is put in front of the server (a reverse proxy such as Caddy, or a tunnel), the passphrase, the cookie and every Dilemma cross the network unencrypted, and anyone on the path can read or replay them. Treat the passphrase as protection against strangers who stumble on the port, not against anyone watching the traffic.

### Environment

| Variable                | Required by | Meaning                                                          |
| ----------------------- | ----------- | ---------------------------------------------------------------- |
| `ZAI_API_KEY`           | CLI, serve  | The Advocate's key (Z.ai GLM).                                   |
| `TYPESAFE_API_KEY`      | CLI, serve  | The Judge's key (TypeSafe AI jev).                               |
| `INDECISION_PASSPHRASE` | serve       | The one shared passphrase. `serve` refuses to start without it.  |
| `PORT`                  | serve       | Port to listen on. Defaults to 3000.                             |

`ZAI_BASE_URL` and `ZAI_MODEL` are optional, as for the CLI. All of them may live in a `.env` file in the working directory instead of the environment.

### Install

```sh
git clone <this repo> ~/indecision && cd ~/indecision
pnpm install
pnpm build
pnpm link --global      # puts `indecision` on PATH
```

Run `indecision serve` once by hand with the variables set to confirm it listens, then put it under systemd.

### Run under systemd

Write a unit yourself; none is committed, because the user, paths and port are yours. Keep the secrets in an environment file that only that user can read, and point the unit at it:

```sh
sudo install -m 600 /dev/null /etc/indecision.env
sudoedit /etc/indecision.env      # ZAI_API_KEY=..., TYPESAFE_API_KEY=..., INDECISION_PASSPHRASE=..., PORT=3000
```

A minimal `/etc/systemd/system/indecision.service`, with `pi` and the paths replaced by yours:

```ini
[Unit]
Description=indecision serve
After=network-online.target
Wants=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/indecision
EnvironmentFile=/etc/indecision.env
ExecStart=/usr/bin/env indecision serve
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

If `indecision` is not on the service user's PATH, use the absolute path to `node` and to `dist/main.js` in `ExecStart` instead. Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now indecision
systemctl status indecision
journalctl -u indecision -f          # "listening on http://0.0.0.0:3000"
```

A missing `INDECISION_PASSPHRASE` shows up in the journal as a start-up error and the unit stays down; `Restart=on-failure` will retry, so fix the env file and `systemctl restart indecision`. Forward the port on your router only after the unit is up and the passphrase page answers on the LAN.

## Develop

```sh
pnpm test        # unit suite: the pipeline with scripted ports, the CLI shell, and the HTTP shell
pnpm typecheck
pnpm smoke       # runs the real Advocate and real Judge on a sample Dilemma; needs both keys
```

The pipeline (`src/decide.ts`) takes the Advocate, Judge and Log as injected ports, plus an optional stage hook it calls just before asking each role; the CLI passes none. Both shells (`src/cli.ts` and `src/serve.ts`) take an injected `decide` and are unit-tested without touching an adapter or binding a port. The real adapters live in `src/advocate`, `src/judge` and `src/log` and are covered only by the smoke script.
