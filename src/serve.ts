import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Readable } from "node:stream";
import type { Dilemma, Option, Outcome, Verdict } from "./domain.js";
import { errorMessage, percent } from "./format.js";

/** The parts of an HTTP request the shell looks at. `cookie` is the raw Cookie header; `body` the raw stream. */
export interface Request {
  readonly method: string;
  readonly url: string;
  readonly cookie?: string | undefined;
  readonly body: Readable;
}

/** An HTML page with a status, plus any headers beyond the content type. The server speaks nothing else. */
export interface Reply {
  readonly status: number;
  readonly html: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type Handler = (request: Request) => Promise<Reply>;

export interface ServeDeps {
  readonly decide: (dilemma: Dilemma) => Promise<Outcome>;
  /** The one shared passphrase. Whoever knows it may spend the API keys; nobody else may. */
  readonly passphrase: string;
  /** Cap on the request body. A Dilemma is a few sentences; anything larger is a mistake. */
  readonly maxBodyBytes?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024;
export const DEFAULT_PORT = 3000;

/**
 * How many runs may be in flight across the whole server. Every run spends both API keys, and the
 * page is on the open internet, so the cap bounds what a burst of submissions can cost. Deliberately
 * a constant and not config: raising it should be a code change someone reads.
 */
export const MAX_RUNS_IN_FLIGHT = 2;

const COOKIE_NAME = "indecision";
/** How long a correct passphrase stays good for, in seconds: 30 days. */
const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const UNLOCK_PATH = "/unlock";

/** `indecision serve` starts the server. Only the whole first word is reserved: "serve or rest?" is a Dilemma. */
export function isServeCommand(argv: readonly string[]): boolean {
  return argv[0] === "serve";
}

/** The port to listen on, from `PORT`, defaulting to 3000. */
export function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env["PORT"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a whole number between 0 and 65535, got "${raw}".`);
  }
  return port;
}

/**
 * The shared passphrase from `INDECISION_PASSPHRASE`. `serve` refuses to start without it, since
 * the page would otherwise let anyone on the internet spend the API keys. The CLI never needs it.
 */
export function readPassphrase(env: NodeJS.ProcessEnv): string {
  const passphrase = env["INDECISION_PASSPHRASE"]?.trim() ?? "";
  if (passphrase === "") {
    throw new Error(
      "INDECISION_PASSPHRASE is not set. `serve` refuses to start without a passphrase; set it in the environment or in a .env file in the working directory.",
    );
  }
  return passphrase;
}

/** All interfaces, so the page is reachable from another device on the network. */
export const HOST = "0.0.0.0";
const CONTENT_TYPE = "text/html; charset=utf-8";

export interface ServeOptions extends ServeDeps {
  readonly port: number;
}

/** Binds the handler to a plain HTTP server on every interface and resolves once it is listening. */
export function startServer({ port, ...deps }: ServeOptions): Promise<Server> {
  const handle = createHandler(deps);
  const server = createServer(async (req, res) => {
    let page: Reply;
    try {
      page = await handle({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        cookie: req.headers.cookie,
        body: req,
      });
    } catch (error) {
      // A client that hangs up mid-request, or a request we can't parse. Never let it take the server down.
      page = failure(500, `Something went wrong: ${errorMessage(error)}`);
    }
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(page.status, { "Content-Type": CONTENT_TYPE, ...page.headers });
    res.end(req.method === "HEAD" ? undefined : page.html);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, HOST, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/**
 * Thin shell over `decide`: one page with a box for the Dilemma, the Outcome rendered below it,
 * behind a passphrase page that everyone shares. One handler serves every request.
 */
export function createHandler(deps: ServeDeps): Handler {
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const token = sessionToken(deps.passphrase);
  let runsInFlight = 0;

  return async (request) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === UNLOCK_PATH) {
      if (request.method !== "POST") return failure(405, "Enter the passphrase with the form.");
      const form = await readBody(request.body, maxBodyBytes);
      const offered = form === undefined ? "" : (new URLSearchParams(form).get("passphrase") ?? "");
      if (!sameSecret(sessionToken(offered), token)) return passphrasePage("Wrong passphrase.");
      return { status: 303, html: "", headers: { Location: "/", "Set-Cookie": sessionCookie(token) } };
    }
    if (path !== "/") return failure(404, "There is nothing at that address; the page is at /.");

    if (!sameSecret(readCookie(request.cookie, COOKIE_NAME), token)) return passphrasePage();
    if (request.method === "GET" || request.method === "HEAD") return reply({ dilemma: "" });
    if (request.method !== "POST") return failure(405, "Submit the Dilemma with the form.");

    const form = await readBody(request.body, maxBodyBytes);
    if (form === undefined) {
      return failure(413, "That Dilemma is too long. Keep it to a few sentences.");
    }
    const dilemma = new URLSearchParams(form).get("dilemma")?.trim() ?? "";
    if (dilemma === "") return failure(400, "No Dilemma given. Type one in the box.");

    if (runsInFlight >= MAX_RUNS_IN_FLIGHT) {
      return failure(503, "The server is busy deciding for someone else; try again in a moment.", dilemma);
    }
    runsInFlight += 1;
    try {
      return reply({ dilemma, outcome: await deps.decide(dilemma) });
    } catch (error) {
      return failure(500, `Something went wrong: ${errorMessage(error)}`, dilemma);
    } finally {
      runsInFlight -= 1;
    }
  };
}

/**
 * What the cookie carries: a keyed hash of the passphrase, never the passphrase itself. It is the
 * same across restarts, so a cookie outlives the process, and a leaked cookie does not reveal the
 * passphrase. The transport is plain HTTP, so a passive observer gets the cookie anyway.
 */
function sessionToken(passphrase: string): string {
  return createHmac("sha256", passphrase).update("indecision session").digest("hex");
}

/** Constant-time comparison; both sides are hex digests of equal length unless one is missing. */
function sameSecret(offered: string | undefined, expected: string): boolean {
  if (offered === undefined || offered.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(offered), Buffer.from(expected));
}

/** Not `Secure`: the transport is plain HTTP for now, and a Secure cookie would never be sent. */
function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`;
}

function readCookie(header: string | undefined, name: string): string | undefined {
  for (const pair of header?.split(";") ?? []) {
    const at = pair.indexOf("=");
    if (at === -1) continue;
    if (pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * Reads the whole body, or returns undefined when it exceeds the cap. The rest of an over-cap body
 * is drained rather than cut off, so the 413 page still reaches the client instead of a reset.
 */
async function readBody(body: Readable, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLong = false;
  for await (const chunk of body) {
    if (tooLong) continue;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > maxBytes) {
      tooLong = true;
      chunks.length = 0;
    } else {
      chunks.push(buffer);
    }
  }
  return tooLong ? undefined : Buffer.concat(chunks).toString("utf8");
}

interface PageState {
  readonly dilemma: Dilemma;
  readonly outcome?: Outcome;
  /** A thrown failure (adapter, network). Not an Outcome: nothing was decided. */
  readonly error?: string;
}

function reply(state: PageState, status = 200): Reply {
  return { status, html: renderPage(state) };
}

/** The same page with a banner instead of an Outcome; the Dilemma stays in the box when there is one. */
function failure(status: number, message: string, dilemma: Dilemma = ""): Reply {
  return reply({ dilemma, error: message }, status);
}

/** The page anyone without a valid cookie sees. 401: the request is understood, the visitor is not. */
function passphrasePage(error?: string): Reply {
  const banner = error === undefined ? "" : renderError(error);
  return {
    status: 401,
    html: frame(`${banner}<form method="post" action="${UNLOCK_PATH}">
<label for="passphrase">Passphrase</label>
<input type="password" name="passphrase" id="passphrase" autofocus required>
<button type="submit">Enter</button>
</form>
`),
  };
}

function renderPage(state: PageState): string {
  const banner = state.error === undefined ? "" : renderError(state.error);
  const renderedOutcome = state.outcome === undefined ? "" : renderOutcome(state.outcome);
  return frame(`${banner}<form method="post" action="/">
<label for="dilemma">What are you stuck on?</label>
<textarea name="dilemma" id="dilemma" rows="5" required>${escape(state.dilemma)}</textarea>
<button type="submit">Decide</button>
<p class="waiting" hidden aria-live="polite">Deciding…</p>
</form>
${renderedOutcome}`);
}

/** The document around either page's main content. */
function frame(main: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>indecision</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>indecision</h1>
${main}</main>
<script>
document.querySelector("form").addEventListener("submit", function (event) {
  event.target.querySelector("button").disabled = true;
  var waiting = event.target.querySelector(".waiting");
  if (waiting) waiting.hidden = false;
});
</script>
</body>
</html>
`;
}

const STYLE = `
body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #fafafa; color: #222; }
main { max-width: 40rem; margin: 0 auto; padding: 1rem; }
label { display: block; font-weight: 600; margin-bottom: .25rem; }
textarea, input[type="password"] { width: 100%; box-sizing: border-box; font: inherit; padding: .5rem; }
button { font: inherit; padding: .5rem 1.25rem; margin-top: .5rem; }
.error { background: #fde8e8; border: 1px solid #d33; padding: .75rem; }
.refusal { background: #fff6e0; border: 1px solid #d9a400; padding: .75rem 1rem; }
.verdict .pick { font-size: 1.5rem; font-weight: 700; margin: 0; }
.close-call { color: #a15c00; }
table td { padding: .1rem .75rem .1rem 0; }
details { border: 1px solid #ddd; padding: .5rem 1rem; margin-bottom: .75rem; background: #fff; }
summary { font-weight: 600; cursor: pointer; }
h4 { margin: .5rem 0 0; }
ul { margin: .25rem 0; }
`;

function renderError(message: string): string {
  return `<p class="error" role="alert">${escape(message)}</p>
`;
}

/** A Refusal is a normal outcome: the Dilemma named no Options, so reword it and try again. */
function renderOutcome(outcome: Outcome): string {
  if (outcome.refused) {
    return `<section class="refusal">
<h2>Can't decide this one</h2>
<p>${escape(outcome.reason)}</p>
<p>Reword the Dilemma above so it names the Options, then try again.</p>
</section>
`;
  }
  return renderVerdict(outcome.verdict) + renderCases(outcome.options);
}

function renderVerdict(verdict: Verdict): string {
  const rows = Object.entries(verdict.probabilities)
    .map(([label, p]) => `<tr><td>${escape(label)}</td><td>${percent(p)}</td></tr>`)
    .join("\n");
  return `<section class="verdict">
<h2>Verdict</h2>
<p class="pick">${escape(verdict.pick)}</p>
<table>
${rows}
</table>
<p>Confidence: ${verdict.confidence.toFixed(2)}</p>
${verdict.closeCall ? "<p class=\"close-call\">Close call: the Cases were nearly balanced.</p>\n" : ""}</section>
`;
}

function renderCases(options: readonly Option[]): string {
  const blocks = options.map(
    (option) => `<details open>
<summary>${escape(option.label)}</summary>
<h4>For</h4>
<ul>
${points(option.case.for)}
</ul>
<h4>Against</h4>
<ul>
${points(option.case.against)}
</ul>
</details>`,
  );
  return `<section class="cases">
<h2>Cases</h2>
${blocks.join("\n")}
</section>
`;
}

function points(items: readonly string[]): string {
  return items.map((point) => `<li>${escape(point)}</li>`).join("\n");
}

/** Everything the page shows was written by the person, the Advocate or the Judge; none of it is markup. */
function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
