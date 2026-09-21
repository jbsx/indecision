import { createServer, type Server } from "node:http";
import type { Readable } from "node:stream";
import type { Dilemma, Option, Outcome, Verdict } from "./domain.js";

/** The parts of an HTTP request the shell looks at. `body` is the raw request stream. */
export interface Request {
  readonly method: string;
  readonly url: string;
  readonly body: Readable;
}

/** An HTML-only response. The server speaks nothing else. */
export interface Reply {
  readonly status: number;
  readonly contentType: "text/html; charset=utf-8";
  readonly html: string;
}

export interface ServeDeps {
  readonly decide: (dilemma: Dilemma) => Promise<Outcome>;
  /** Cap on the request body. A Dilemma is a few sentences; anything larger is a mistake. */
  readonly maxBodyBytes?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024;
export const DEFAULT_PORT = 3000;

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

export interface ServeOptions extends ServeDeps {
  readonly port: number;
  /** All interfaces by default, so the page is reachable from another device on the network. */
  readonly host?: string;
}

/** Binds the handler to a plain HTTP server and resolves once it is listening. */
export function startServer(options: ServeOptions): Promise<Server> {
  const { port, host = "0.0.0.0", ...deps } = options;
  const server = createServer(async (req, res) => {
    const reply = await handle({ method: req.method ?? "GET", url: req.url ?? "/", body: req }, deps);
    res.writeHead(reply.status, { "Content-Type": reply.contentType });
    res.end(req.method === "HEAD" ? undefined : reply.html);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

/** Thin shell over `decide`: one page with a box for the Dilemma, the Outcome rendered below it. */
export async function handle(request: Request, deps: ServeDeps): Promise<Reply> {
  if (new URL(request.url, "http://localhost").pathname !== "/") {
    return page({ dilemma: "", error: "There is nothing at that address; the page is at /." }, 404);
  }
  if (request.method === "GET" || request.method === "HEAD") return page({ dilemma: "" });
  if (request.method !== "POST") {
    return page({ dilemma: "", error: "Submit the Dilemma with the form." }, 405);
  }

  const form = await readBody(request.body, deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  if (form === undefined) {
    return page({ dilemma: "", error: "That Dilemma is too long. Keep it to a few sentences." }, 413);
  }
  const dilemma = new URLSearchParams(form).get("dilemma")?.trim() ?? "";
  if (dilemma === "") return page({ dilemma, error: "No Dilemma given. Type one in the box." }, 400);

  try {
    return page({ dilemma, outcome: await deps.decide(dilemma) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return page({ dilemma, error: `Something went wrong: ${message}` }, 500);
  }
}

/** Reads the whole body, or returns undefined as soon as it exceeds the cap. */
async function readBody(body: Readable, maxBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > maxBytes) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface PageState {
  readonly dilemma: Dilemma;
  readonly outcome?: Outcome;
  /** A thrown failure (adapter, network). Not an Outcome: nothing was decided. */
  readonly error?: string;
}

function page(state: PageState, status = 200): Reply {
  return { status, contentType: "text/html; charset=utf-8", html: renderPage(state) };
}

function renderPage(state: PageState): string {
  const banner = state.error === undefined ? "" : renderError(state.error);
  const result = state.outcome === undefined ? "" : renderOutcome(state.outcome);
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
${banner}<form method="post" action="/">
<label for="dilemma">What are you stuck on?</label>
<textarea name="dilemma" id="dilemma" rows="5" required>${escape(state.dilemma)}</textarea>
<button type="submit">Decide</button>
<p class="waiting" hidden aria-live="polite">Deciding…</p>
</form>
${result}</main>
<script>
document.querySelector("form").addEventListener("submit", function (event) {
  event.target.querySelector("button").disabled = true;
  event.target.querySelector(".waiting").hidden = false;
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
textarea { width: 100%; box-sizing: border-box; font: inherit; padding: .5rem; }
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

/** One decimal, so a close call's gap stays visible instead of rounding to the same figure. */
function percent(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

/** Everything the page shows comes from a person or a model; none of it is markup. */
function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
