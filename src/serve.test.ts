import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Outcome } from "./domain.js";
import { handle, isServeCommand, readPort, type Reply } from "./serve.js";

const outcome: Outcome = {
  refused: false,
  options: [
    { label: "Go to the gym", case: { for: ["Sleep better"], against: ["Rain"] } },
    { label: "Rest at home", case: { for: ["Recovery day"], against: ["Guilt"] } },
  ],
  verdict: {
    pick: "Go to the gym",
    probabilities: { "Go to the gym": 0.8, "Rest at home": 0.2 },
    confidence: 0.9,
    closeCall: false,
  },
};

function get(url = "/", decide = async (_: string) => outcome): Promise<Reply> {
  return handle({ method: "GET", url, body: Readable.from([]) }, { decide });
}

function post(
  body: string,
  decide = async (_: string) => outcome,
  maxBodyBytes?: number,
): Promise<Reply> {
  const form = new URLSearchParams({ dilemma: body }).toString();
  return handle(
    { method: "POST", url: "/", body: Readable.from([form]) },
    maxBodyBytes === undefined ? { decide } : { decide, maxBodyBytes },
  );
}

describe("indecision serve", () => {
  it("serves a page with one box for the Dilemma", async () => {
    const reply = await get();

    expect(reply.status).toBe(200);
    expect(reply.html).toContain('<textarea name="dilemma"');
    expect(reply.html).toContain('<form method="post" action="/"');
  });

  it("decides the submitted Dilemma and renders the Verdict above the Cases, expanded", async () => {
    const seen: string[] = [];
    const reply = await post("gym or rest?", async (dilemma) => {
      seen.push(dilemma);
      return outcome;
    });

    expect(reply.status).toBe(200);
    expect(seen).toEqual(["gym or rest?"]);
    const verdictAt = reply.html.indexOf("Verdict");
    const pickAt = reply.html.indexOf("Go to the gym", verdictAt);
    const casesAt = reply.html.indexOf("Cases");
    const pointAt = reply.html.indexOf("Sleep better");
    expect(verdictAt).toBeGreaterThanOrEqual(0);
    expect(pickAt).toBeGreaterThan(verdictAt);
    expect(casesAt).toBeGreaterThan(pickAt);
    expect(pointAt).toBeGreaterThan(casesAt);
    expect(reply.html).toContain("80.0%");
    expect(reply.html).toContain("20.0%");
    expect(reply.html).toContain("0.90");
    expect(reply.html).not.toContain("Close call");
    expect(reply.html).toContain("<details open>");
    expect(reply.html).not.toContain("<details>");
    for (const point of ["Sleep better", "Rain", "Recovery day", "Guilt"]) {
      expect(reply.html).toContain(point);
    }
  });

  it("shows the close-call line when the Verdict is flagged", async () => {
    const reply = await post("gym or rest?", async () => ({
      ...outcome,
      verdict: {
        pick: "Rest at home",
        probabilities: { "Go to the gym": 0.46, "Rest at home": 0.54 },
        confidence: 0.55,
        closeCall: true,
      },
    }));

    expect(reply.status).toBe(200);
    expect(reply.html).toContain("Close call");
    expect(reply.html).toContain("46.0%");
    expect(reply.html).toContain("54.0%");
  });

  it("renders a Refusal as an outcome with its reason and keeps the Dilemma in the box", async () => {
    const reply = await post("I feel stuck & <lost>", async () => ({
      refused: true,
      reason: "No Options are named.",
    }));

    expect(reply.status).toBe(200);
    expect(reply.html).toContain("No Options are named.");
    expect(reply.html).toContain(">I feel stuck &amp; &lt;lost&gt;</textarea>");
    expect(reply.html).not.toContain("Verdict");
    expect(reply.html).not.toContain('class="error"');
  });

  it("renders a thrown error as an error banner and keeps the Dilemma in the box", async () => {
    const reply = await post("gym or rest?", async () => {
      throw new Error("jev unreachable");
    });

    expect(reply.status).toBe(500);
    expect(reply.html).toContain('class="error"');
    expect(reply.html).toContain("jev unreachable");
    expect(reply.html).toContain(">gym or rest?</textarea>");
    expect(reply.html).not.toContain("Verdict");
  });

  it("rejects a body over the cap with a clear message and never calls decide", async () => {
    const seen: string[] = [];
    const reply = await post(
      "x".repeat(200),
      async (dilemma) => {
        seen.push(dilemma);
        return outcome;
      },
      100,
    );

    expect(reply.status).toBe(413);
    expect(reply.html).toContain("too long");
    expect(seen).toEqual([]);
  });

  it("drains an over-cap body to its end so the 413 can still reach the client", async () => {
    const body = Readable.from(["a".repeat(60), "b".repeat(60), "c".repeat(60)]);

    const reply = await handle(
      { method: "POST", url: "/", body },
      { decide: async () => outcome, maxBodyBytes: 100 },
    );

    expect(reply.status).toBe(413);
    expect(body.readableEnded).toBe(true);
  });

  it("asks for a Dilemma when the box is empty instead of calling decide", async () => {
    const seen: string[] = [];
    const reply = await post("   ", async (dilemma) => {
      seen.push(dilemma);
      return outcome;
    });

    expect(reply.status).toBe(400);
    expect(reply.html).toContain("No Dilemma given");
    expect(seen).toEqual([]);
  });

  it("answers any other path with 404", async () => {
    const reply = await get("/favicon.ico");

    expect(reply.status).toBe(404);
  });
});

describe("serve as a reserved first word", () => {
  it("is the serve command only when it is the whole first argument", () => {
    expect(isServeCommand(["serve"])).toBe(true);
    expect(isServeCommand(["serve", "extra"])).toBe(true);
    expect(isServeCommand(["serve or rest?"])).toBe(false);
    expect(isServeCommand(["gym or rest?"])).toBe(false);
    expect(isServeCommand([])).toBe(false);
  });
});

describe("PORT", () => {
  it("defaults to 3000 and reads a valid PORT", () => {
    expect(readPort({})).toBe(3000);
    expect(readPort({ PORT: "8080" })).toBe(8080);
  });

  it("rejects a PORT that is not a port number", () => {
    expect(() => readPort({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => readPort({ PORT: "70000" })).toThrow(/PORT/);
  });
});
