const VERDICT_VALUES = {
  ALLOW: "allow",
  CONSTRAIN: "constrain",
  REQUIRE_APPROVAL: "require_approval",
  BLOCK: "block",
  HALT: "halt"
} as const;

export type Verdict = (typeof VERDICT_VALUES)[keyof typeof VERDICT_VALUES];

const VERDICT_PRIORITIES: Record<Verdict, number> = {
  [VERDICT_VALUES.ALLOW]: 1,
  [VERDICT_VALUES.CONSTRAIN]: 2,
  [VERDICT_VALUES.REQUIRE_APPROVAL]: 3,
  [VERDICT_VALUES.BLOCK]: 4,
  [VERDICT_VALUES.HALT]: 5
};

function isVerdict(value: string): value is Verdict {
  return (Object.values(VERDICT_VALUES) as string[]).includes(value);
}

export const Verdict = Object.freeze({
  ...VERDICT_VALUES,
  fromString(value?: string | null): Verdict {
    if (!value) {
      return VERDICT_VALUES.ALLOW;
    }

    const normalized = value.toLowerCase().replaceAll("-", "_");

    if (normalized === "continue") {
      return VERDICT_VALUES.ALLOW;
    }

    if (normalized === "stop") {
      return VERDICT_VALUES.HALT;
    }

    if (
      normalized === "require_approval" ||
      normalized === "request_approval"
    ) {
      return VERDICT_VALUES.REQUIRE_APPROVAL;
    }

    return isVerdict(normalized) ? normalized : VERDICT_VALUES.ALLOW;
  },
  highestPriority(verdicts: Verdict[]): Verdict {
    return verdicts.reduce<Verdict>(
      (highest, verdict) =>
        VERDICT_PRIORITIES[verdict] > VERDICT_PRIORITIES[highest]
          ? verdict
          : highest,
      VERDICT_VALUES.ALLOW
    );
  },
  priorityOf(verdict: Verdict): number {
    return VERDICT_PRIORITIES[verdict];
  },
  requiresApproval(verdict: Verdict): boolean {
    return verdict === VERDICT_VALUES.REQUIRE_APPROVAL;
  },
  shouldStop(verdict: Verdict): boolean {
    return verdict === VERDICT_VALUES.BLOCK || verdict === VERDICT_VALUES.HALT;
  }
});
