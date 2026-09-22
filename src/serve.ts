import { createServer, type Server } from "node:http";
import type { Readable } from "node:stream";
import type { Stage } from "./decide.js";
import type { Dilemma, Option, Outcome, Verdict } from "./domain.js";
import { errorMessage, percent } from "./format.js";

/** The parts of an HTTP request the shell looks at. `body` is the raw stream. */
export interface Request {
  readonly method: string;
  readonly url: string;
  readonly body: Readable;
}

/** A whole HTML page with a status. */
export interface Page {
  readonly status: number;
  readonly html: string;
}

/**
 * One step of a run as the page's script sees it: which role is at work, or the finished
 * outcome (Verdict above Cases, or a Refusal) or the error banner, both as HTML fragments rendered
 * exactly as the whole page would render them.
 */
export type RunEvent =
  | { readonly stage: Stage; readonly text: string }
  | { readonly outcome: string }
  | { readonly error: string };

/** A run's progress, handed to `send` one event at a time as it happens. Resolves once the run is over. */
export interface Stream {
  readonly status: number;
  readonly run: (send: (event: RunEvent) => void) => Promise<void>;
}

/** What a request gets back. The form's own POST gets a Page; the page's script gets a Stream. */
export type Reply = Page | Stream;

export type Handler = (request: Request) => Promise<Reply>;

export interface ServeDeps {
  /** The pipeline, told where the time is going through `onStage` just before each role is asked. */
  readonly decide: (dilemma: Dilemma, onStage?: (stage: Stage) => void) => Promise<Outcome>;
  /** Cap on the request body. A Dilemma is a few sentences; anything larger is a mistake. */
  readonly maxBodyBytes?: number;
}

export const DEFAULT_MAX_BODY_BYTES = 8 * 1024;
export const DEFAULT_PORT = 3000;

/** Where the page's script sends the Dilemma. The form itself still posts to /. */
const STREAM_PATH = "/decide";

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

/** All interfaces, so the page is reachable from another device on the network. */
export const HOST = "0.0.0.0";
const HTML_TYPE = "text/html; charset=utf-8";
/** One JSON object per line, written as each event happens. */
const NDJSON_TYPE = "application/x-ndjson; charset=utf-8";

const STAGE_TEXT: Readonly<Record<Stage, string>> = {
  advocate: "The Advocate is arguing…",
  judge: "The Judge is weighing…",
};

const NOT_A_FORM_POST = "Submit the Dilemma with the form.";

/** Why a submission is turned away before anything is decided, with the status that says so. */
interface Rejection {
  readonly status: number;
  readonly reason: string;
}

/** A thrown failure (adapter, network), worded for the person. Nothing was decided. */
function somethingWentWrong(error: unknown): string {
  return `Something went wrong: ${errorMessage(error)}`;
}

export interface ServeOptions extends ServeDeps {
  readonly port: number;
}

/** Binds the handler to a plain HTTP server on every interface and resolves once it is listening. */
export function startServer({ port, ...deps }: ServeOptions): Promise<Server> {
  const handle = createHandler(deps);
  const server = createServer(async (req, res) => {
    let reply: Reply;
    try {
      reply = await handle({
        method: req.method ?? "GET",
        url: req.url ?? "/",
        body: req,
      });
    } catch (error) {
      // A client that hangs up mid-request, or a request we can't parse. Never let it take the server down.
      reply = failure(500, somethingWentWrong(error));
    }
    if ("html" in reply) {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(reply.status, { "Content-Type": HTML_TYPE });
      res.end(req.method === "HEAD" ? undefined : reply.html);
      return;
    }
    if (res.destroyed) return;
    res.writeHead(reply.status, {
      "Content-Type": NDJSON_TYPE,
      "Cache-Control": "no-store",
    });
    res.flushHeaders();
    await reply.run((event) => {
      if (!res.destroyed) res.write(JSON.stringify(event) + "\n");
    });
    if (!res.destroyed) res.end();
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
 * Thin shell over `decide`: one page with a box for the Dilemma, the Outcome rendered below it.
 * One handler serves every request. The page's script posts to the streamed route instead of the
 * form's own, and gets the stages as they happen.
 */
export function createHandler(deps: ServeDeps): Handler {
  const maxBodyBytes = deps.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return async (request) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path !== "/" && path !== STREAM_PATH) {
      return failure(404, "There is nothing at that address; the page is at /.");
    }

    if (path === STREAM_PATH) {
      if (request.method !== "POST") return failure(405, NOT_A_FORM_POST);
      const submitted = await readDilemma(request.body, maxBodyBytes);
      if ("reason" in submitted) return turnedAway(submitted);
      return {
        status: 200,
        run: async (send) => {
          try {
            const outcome = await deps.decide(submitted.dilemma, (stage) =>
              send({ stage, text: STAGE_TEXT[stage] }),
            );
            send({ outcome: renderOutcome(outcome) });
          } catch (error) {
            send({ error: renderError(somethingWentWrong(error)) });
          }
        },
      };
    }

    if (request.method === "GET" || request.method === "HEAD") return page({ dilemma: "" });
    if (request.method !== "POST") return failure(405, NOT_A_FORM_POST);

    const submitted = await readDilemma(request.body, maxBodyBytes);
    if ("reason" in submitted) return failure(submitted.status, submitted.reason);
    const { dilemma } = submitted;

    try {
      return page({ dilemma, outcome: await deps.decide(dilemma) });
    } catch (error) {
      return failure(500, somethingWentWrong(error), dilemma);
    }
  };
}

/** The Dilemma from the form body, or the Rejection. */
async function readDilemma(
  body: Readable,
  maxBodyBytes: number,
): Promise<{ dilemma: Dilemma } | Rejection> {
  const form = await readBody(body, maxBodyBytes);
  if (form === undefined) {
    return { status: 413, reason: "That Dilemma is too long. Keep it to a few sentences." };
  }
  const dilemma = new URLSearchParams(form).get("dilemma")?.trim() ?? "";
  if (dilemma === "") return { status: 400, reason: "No Dilemma given. Type one in the box." };
  return { dilemma };
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

function page(state: PageState, status = 200): Page {
  return { status, html: renderPage(state) };
}

/** The same page with a banner instead of an Outcome; the Dilemma stays in the box when there is one. */
function failure(status: number, message: string, dilemma: Dilemma = ""): Page {
  return page({ dilemma, error: message }, status);
}

/** A Stream that carries only why the submission was turned away, for the page's script to show as the banner. */
function turnedAway(rejection: Rejection): Stream {
  const banner = renderError(rejection.reason);
  return { status: rejection.status, run: async (send) => send({ error: banner }) };
}

function renderPage(state: PageState): string {
  const banner = state.error === undefined ? "" : renderError(state.error);
  const renderedOutcome = state.outcome === undefined ? "" : renderOutcome(state.outcome);
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
<div id="banner">${banner}</div>
<form method="post" action="/">
<label for="dilemma">What are you stuck on?</label>
<textarea name="dilemma" id="dilemma" rows="5" required>${escape(state.dilemma)}</textarea>
<button type="submit">Decide</button>
<p class="waiting" hidden aria-live="polite">Deciding…</p>
</form>
<div id="outcome">${renderedOutcome}</div>
</main>
<script>${SCRIPT}</script>
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

/**
 * On the Dilemma page, submits to the streamed route and shows each stage as it arrives, then the
 * outcome or the banner, without reloading. Without fetch, or when the server answers with a page
 * instead of a Stream, the form posts itself.
 */
const SCRIPT = `
(function () {
  var form = document.querySelector("form");
  var button = form.querySelector("button");
  var waiting = form.querySelector(".waiting");
  var banner = document.getElementById("banner");
  var outcome = document.getElementById("outcome");
  var streams = Boolean(waiting && window.fetch && window.ReadableStream && window.TextDecoder);

  form.addEventListener("submit", function (event) {
    button.disabled = true;
    if (!streams) {
      if (waiting) waiting.hidden = false;
      return;
    }
    event.preventDefault();
    banner.innerHTML = "";
    outcome.innerHTML = "";
    waiting.textContent = "Deciding…";
    waiting.hidden = false;
    fetch("${STREAM_PATH}", { method: "POST", body: new URLSearchParams(new FormData(form)) })
      .then(function (response) {
        var type = response.headers.get("Content-Type") || "";
        if (type.indexOf("${NDJSON_TYPE.split(";")[0]}") !== 0) return form.submit();
        return readLines(response.body, apply);
      })
      .catch(function (error) { banner.innerHTML = ""; banner.appendChild(errorBanner(error)); })
      .then(function () { waiting.hidden = true; button.disabled = false; });
  });

  function apply(event) {
    if ("stage" in event) waiting.textContent = event.text;
    else if ("outcome" in event) outcome.innerHTML = event.outcome;
    else if ("error" in event) banner.innerHTML = event.error;
  }

  function readLines(body, onLine) {
    var reader = body.getReader();
    var decoder = new TextDecoder();
    var buffered = "";
    return reader.read().then(function step(chunk) {
      buffered += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      var lines = buffered.split("\\n");
      buffered = lines.pop();
      lines.forEach(function (line) { if (line) onLine(JSON.parse(line)); });
      return chunk.done ? undefined : reader.read().then(step);
    });
  }

  function errorBanner(error) {
    var p = document.createElement("p");
    p.className = "error";
    p.setAttribute("role", "alert");
    p.textContent = "Something went wrong: " + ((error && error.message) || error);
    return p;
  }
})();
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
