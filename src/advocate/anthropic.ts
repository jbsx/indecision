import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { Dilemma, Option, Refusal } from "../domain.js";
import type { Advocate } from "../ports.js";

export const ADVOCATE_MODEL = "claude-sonnet-5";

/** Points on each side of every Case. Fixed so no Option gets more argumentative effort. */
const POINTS_PER_SIDE = 3;

/** The Advocate returned something the tool can't interpret as Options with symmetric Cases. */
export class AdvocateError extends Error {}

const SYSTEM_PROMPT = `You are the Advocate in a decision tool. A person will give you a Dilemma: a free-text description of a choice they are stuck on. Your only job is to identify the Options they named and argue each one. You never decide.

Rules:
1. Extract only the Options the person actually stated. Never invent an alternative they did not mention. Keep each label short and in the person's own terms.
2. If the Dilemma names exactly one Option (for example "should I go to the gym"), add its refusal as the second Option, labelled "Don't ..." in the same terms.
3. If the Dilemma names no discernible Option at all, set "refusal" to a one-line reason and return an empty "options" list.
4. For every Option, write exactly ${POINTS_PER_SIDE} points for it and exactly ${POINTS_PER_SIDE} points against it. Every Option gets the same effort, depth and tone.
5. Never state a preference, a ranking, a recommendation, a summary that leans one way, or a conclusion. Not in the labels, not in the points, not anywhere. Each point is a single concrete sentence.`;

const CaseSchema = z.object({
  label: z.string(),
  for: z.array(z.string()),
  against: z.array(z.string()),
});

const ArguedSchema = z.object({
  refusal: z
    .string()
    .nullable()
    .describe("One-line reason when the Dilemma names no Options; otherwise null."),
  options: z.array(CaseSchema),
});

/** The Advocate, played by Anthropic's current Sonnet with structured output. */
export function anthropicAdvocate(apiKey: string): Advocate {
  const client = new Anthropic({ apiKey });
  return {
    async argue(dilemma: Dilemma) {
      const message = await client.messages.parse({
        model: ADVOCATE_MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: dilemma }],
        output_config: { format: zodOutputFormat(ArguedSchema) },
      });

      if (message.stop_reason !== "end_turn") {
        throw new AdvocateError(`The Advocate stopped early (${message.stop_reason}).`);
      }
      const argued = message.parsed_output;
      if (argued === null) {
        throw new AdvocateError("The Advocate's response did not match the expected shape.");
      }
      return interpret(argued);
    },
  };
}

function interpret(
  argued: z.infer<typeof ArguedSchema>,
): Refusal | { refused: false; options: readonly Option[] } {
  if (argued.refusal !== null && argued.refusal.trim() !== "") {
    return { refused: true, reason: argued.refusal.trim() };
  }
  if (argued.options.length === 0) {
    throw new AdvocateError("The Advocate returned no Options and no reason for refusing.");
  }

  const options: Option[] = [];
  for (const { label, for: forPoints, against } of argued.options) {
    if (label.trim() === "") throw new AdvocateError("The Advocate returned an unlabelled Option.");
    if (forPoints.length !== against.length || forPoints.length === 0) {
      throw new AdvocateError(
        `The Case for "${label}" is not symmetric (${forPoints.length} for, ${against.length} against).`,
      );
    }
    options.push({ label: label.trim(), case: { for: forPoints, against } });
  }
  if (new Set(options.map((o) => o.label)).size !== options.length) {
    throw new AdvocateError("The Advocate returned two Options with the same label.");
  }
  return { refused: false, options };
}
