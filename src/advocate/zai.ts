import OpenAI from "openai";
import { z } from "zod";
import type { Dilemma, Option, Refusal } from "../domain.js";
import type { Advocate } from "../ports.js";

export interface ZaiSettings {
  readonly apiKey: string;
  /** OpenAI-compatible base URL; differs between Z.ai's pay-as-you-go and Coding Plan keys. */
  readonly baseURL: string;
  readonly model: string;
}

/** Points on each side of every Case. Fixed so no Option gets more argumentative effort. */
const POINTS_PER_SIDE = 3;

/** The Advocate returned something the tool can't interpret as Options with symmetric Cases. */
export class AdvocateError extends Error {}

const SYSTEM_PROMPT = `You are the Advocate in a decision tool. A person will give you a Dilemma: a free-text description of a choice they are stuck on. Your only job is to identify the Options they named and argue each one. You never decide.

Rules:
1. Read the Options out of the Dilemma, stated or implied. People rarely spell out a choice; they vent, hint, trail off or mention a pressure. Read between the lines and name the choice they are actually facing. Keep each label short and in the person's own terms.
   - A single Option ("should I go to the gym", "my boss wants me in on Saturday") implies its refusal as the second Option, labelled "Don't ..." in the same terms.
   - A complaint or a pressure ("I hate my job") implies acting on it or not, in its most obvious reading ("Quit" / "Stay").
   - A named Option plus a vague gesture ("pizza or... I dunno, something") implies the unnamed alternative ("Something other than pizza").
2. Do not propose alternatives. You may name a choice the person is plainly facing; you may not suggest one they gave no sign of considering. If the only Options you can think of would be your own ideas, the input is not a Dilemma.
3. Refuse only when the input is not a Dilemma at all: it is empty, a greeting, a factual question, gibberish, or an open question with no implied choice ("what should I eat tonight?"). Then set "refusal" to a one-line reason and return an empty "options" list. Unstated Options are never a reason to refuse.
4. For every Option, write exactly ${POINTS_PER_SIDE} points for it and exactly ${POINTS_PER_SIDE} points against it. Every Option gets the same effort, depth and tone.
5. Never state a preference, a ranking, a recommendation, a summary that leans one way, or a conclusion. Not in the labels, not in the points, not anywhere. Each point is a single concrete sentence.

Respond with a single JSON object and nothing else, in exactly this shape:
{
  "refusal": null or "one-line reason when the input is not a Dilemma",
  "options": [
    { "label": "Option label", "for": ["point", "point", "point"], "against": ["point", "point", "point"] }
  ]
}`;

const OptionSchema = z.object({
  label: z.string(),
  for: z.array(z.string()),
  against: z.array(z.string()),
});

const ArguedSchema = z.object({
  refusal: z.string().nullable(),
  options: z.array(OptionSchema),
});

/** The Advocate, played by Z.ai's GLM in JSON mode, validated against the schema above. */
export function zaiAdvocate({ apiKey, baseURL, model }: ZaiSettings): Advocate {
  const client = new OpenAI({ apiKey, baseURL });
  return {
    async argue(dilemma: Dilemma) {
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: dilemma },
        ],
        response_format: { type: "json_object" },
      });

      const choice = completion.choices[0];
      if (choice === undefined) throw new AdvocateError("The Advocate returned no response.");
      if (choice.finish_reason !== "stop") {
        throw new AdvocateError(`The Advocate stopped early (${choice.finish_reason}).`);
      }
      return interpret(parseArgued(choice.message.content ?? ""));
    },
  };
}

function parseArgued(content: string): z.infer<typeof ArguedSchema> {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new AdvocateError("The Advocate's response was not valid JSON.");
  }
  const parsed = ArguedSchema.safeParse(json);
  if (!parsed.success) {
    throw new AdvocateError("The Advocate's response did not match the expected shape.");
  }
  return parsed.data;
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
