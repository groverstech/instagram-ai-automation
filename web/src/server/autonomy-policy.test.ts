/**
 * Autonomy policy engine (autonomy/policy.ts): a decision table over level × action × content ×
 * pause × caps, and a property check that nothing is ever allowed to publish while paused.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, classify, decide, effectiveLevel, normaliseRules, type Context, type Level } from "./autonomy/policy";

const wed10 = new Date("2027-03-03T10:00:00Z"); // a Wednesday, 10:00 UTC: inside the default window
const rules = { ...DEFAULT_RULES, warmup: 0 };
const base = (o: Partial<Context> = {}): Context => ({
  platformAllowsAutonomous: true,
  brandLevel: "autonomous",
  accountLevel: null,
  planMax: null,
  suspended: false,
  paused: false,
  aiStopped: false,
  rules,
  rulesVersion: 3,
  competitors: ["Acme Pottery"],
  origin: "ai",
  complete: true,
  content: { caption: "Slow mornings, hand-thrown mugs.", pillar: "craft", hashtags: ["#stoneware"] },
  at: wed10,
  counters: { today: 0, week: 0, lastAt: null, autonomousSoFar: 10 },
  approval: "policy",
  ...o,
});

describe("autonomy policy", () => {
  it("levels: plan, platform switch, suspension and the account can only lower the brand's level", () => {
    expect(effectiveLevel(base())).toBe("autonomous");
    expect(effectiveLevel(base({ platformAllowsAutonomous: false }))).toBe("assisted");
    expect(effectiveLevel(base({ suspended: true }))).toBe("assisted");
    expect(effectiveLevel(base({ accountLevel: "advisor" }))).toBe("advisor");
    expect(effectiveLevel(base({ brandLevel: "assisted", accountLevel: "autonomous" }))).toBe("assisted"); // never above the brand
    expect(effectiveLevel(base({ planMax: "assisted" }))).toBe("assisted");
    expect(effectiveLevel(base({ brandLevel: "nonsense" }))).toBe("assisted"); // unknown → the default
    expect(effectiveLevel(base({ accountLevel: "nonsense" }))).toBe("assisted");
    expect(effectiveLevel(base({ brandLevel: "advisor", platformAllowsAutonomous: false }))).toBe("advisor");
  });

  it("Advisor never lets the AI save posts; Assisted and Autonomous do; the kill switch stops it", () => {
    expect(decide("ai_draft", base({ brandLevel: "advisor" })).result).toBe("deny");
    expect(decide("ai_draft", base({ brandLevel: "assisted" })).result).toBe("allow");
    expect(decide("ai_draft", base()).result).toBe("allow");
    expect(decide("ai_draft", base({ aiStopped: true })).result).toBe("deny");
  });

  it("auto-approval only at the Autonomous level, for the AI's own complete posts within the rules", () => {
    expect(decide("auto_approve", base())).toMatchObject({ result: "allow", policyVersion: 3, level: "autonomous" });
    for (const l of ["advisor", "assisted"] as Level[]) expect(decide("auto_approve", base({ brandLevel: l })).result).toBe("require_approval");
    expect(decide("auto_approve", base({ platformAllowsAutonomous: false })).result).toBe("require_approval");
    expect(decide("auto_approve", base({ origin: "human" })).result).toBe("require_approval");
    expect(decide("auto_approve", base({ complete: false })).result).toBe("require_approval");
    expect(decide("auto_approve", base({ aiStopped: true })).result).toBe("require_approval");
    expect(decide("auto_approve", base({ content: { caption: "  " } })).result).toBe("require_approval");
  });

  it("restricted content always needs a person", () => {
    const cases = [
      "20% off this weekend only",
      "Now just $25",
      "Big sale on mugs",
      "Giveaway: win a mug set",
      "Our glaze is clinically proven to cure stress",
      "Better than Acme Pottery",
      "Our thoughts on the election",
      "Shop at https://evil.example.net/mugs",
    ];
    for (const caption of cases) {
      const d = decide("auto_approve", base({ content: { caption } }));
      expect(d.result, caption).toBe("require_approval");
      expect(d.reasons.join(" "), caption).toMatch(/Restricted content/);
    }
    // A link on an allowed domain is fine; a banned topic isn't.
    expect(decide("auto_approve", base({ rules: { ...rules, linkDomains: ["kora.studio"] }, content: { caption: "New mugs at shop.kora.studio/mugs" } })).result).toBe("allow");
    expect(decide("auto_approve", base({ rules: { ...rules, bannedTopics: ["kiln accident"] }, content: { caption: "About the kiln accident" } })).result).toBe("require_approval");
    expect(classify({ caption: "plain text" }, { rules }).restricted).toEqual([]);
  });

  it("frequency, schedule, warm-up and pillar rules", () => {
    const d = (o: Partial<Context>) => decide("auto_approve", base(o));
    expect(d({ counters: { today: 1, week: 1, lastAt: null, autonomousSoFar: 10 } }).reasons.join()).toMatch(/Daily cap/);
    expect(d({ counters: { today: 0, week: 5, lastAt: null, autonomousSoFar: 10 } }).reasons.join()).toMatch(/Weekly cap/);
    expect(d({ counters: { today: 0, week: 0, lastAt: new Date(wed10.getTime() - 3600_000), autonomousSoFar: 10 } }).reasons.join()).toMatch(/Less than 4 h/);
    expect(d({ counters: { today: 0, week: 0, lastAt: null, autonomousSoFar: 2 }, rules: { ...rules, warmup: 5 } }).reasons.join()).toMatch(/Warm-up/);
    expect(d({ at: new Date("2027-03-03T23:00:00Z") }).reasons.join()).toMatch(/outside the allowed hours/);
    expect(d({ at: new Date("2027-03-06T10:00:00Z") }).reasons.join()).toMatch(/day isn't allowed/); // Saturday
    expect(d({ at: undefined }).result).toBe("require_approval");
    expect(d({ counters: undefined }).result).toBe("require_approval"); // fails closed
    expect(d({ rules: { ...rules, allowedPillars: ["education"] } }).reasons.join()).toMatch(/Pillar "craft"/);
  });

  it("publish: a person's approval is enough unless paused; a policy approval is checked again in full", () => {
    expect(decide("publish", base({ approval: "person", brandLevel: "advisor" })).result).toBe("allow");
    expect(decide("publish", base({ approval: "none" })).result).toBe("deny");
    expect(decide("publish", base()).result).toBe("allow");
    expect(decide("publish", base({ brandLevel: "assisted" })).result).toBe("require_approval"); // level lowered since
    expect(decide("publish", base({ content: { caption: "50% off" } })).result).toBe("require_approval"); // edited since
  });

  it("property: nothing is ever allowed to publish while paused, whatever else is true", () => {
    const levels = ["advisor", "assisted", "autonomous", "x", null];
    const approvals = ["person", "policy", "none"] as const;
    let n = 0;
    for (const brandLevel of levels)
      for (const accountLevel of levels)
        for (const approval of approvals)
          for (const platformAllowsAutonomous of [true, false])
            for (const suspended of [true, false])
              for (const aiStopped of [true, false]) {
                const d = decide("publish", base({ paused: true, brandLevel, accountLevel, approval, platformAllowsAutonomous, suspended, aiStopped }));
                expect(d.result).toBe("deny");
                n++;
              }
    expect(n).toBe(5 * 5 * 3 * 2 * 2 * 2);
    // And randomised contexts: a paused publish is never allowed.
    for (let i = 0; i < 500; i++) {
      const d = decide("publish", base({ paused: true, counters: { today: Math.floor(Math.random() * 3), week: Math.floor(Math.random() * 9), lastAt: Math.random() < 0.5 ? null : new Date(wed10.getTime() - Math.random() * 1e8), autonomousSoFar: Math.floor(Math.random() * 9) } }));
      expect(d.result).toBe("deny");
    }
  });

  it("rules: malformed stored rules fall back to the strict defaults", () => {
    expect(normaliseRules(null)).toEqual(DEFAULT_RULES);
    expect(normaliseRules({ maxPerDay: 99, allowedHours: [25, 3, 3, "x"], bannedTopics: [" Politics ", ""] })).toMatchObject({ maxPerDay: DEFAULT_RULES.maxPerDay, allowedHours: [3], bannedTopics: ["politics"] });
  });
});
