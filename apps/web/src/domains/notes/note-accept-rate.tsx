/**
 * Accept rate per extraction type — the number that says whether this feature
 * works.
 *
 * This was the riskiest assumption across three rounds of design: that people
 * accept extractions rather than ignoring the rail. The brief asks for it to
 * be instrumented from day one, and it is — but data nobody can see is not
 * instrumentation, it is a table. This is the readout.
 *
 * **What to do when it is low is decided in advance, so the number cannot be
 * argued with after the fact: fewer and better extractions, not more
 * prompting.** A feature that responds to being ignored by asking louder is
 * how a rail becomes a thing people learn to scroll past.
 *
 * Split by kind AND tier because those fail differently, and the difference
 * tells you which thing to change:
 *
 *  · a low `unsure` rate means the tier is doing its job — it is supposed to
 *    catch the marginal ones, and most of them are supposed to be declined;
 *  · a low `confident` rate means the extractor is wrong, which is the one
 *    that needs work.
 *
 * Deliberately not a percentage anywhere the owner sees a proposal — that is
 * the confidence rule, and it holds. This is a diagnostic about the feature,
 * shown once, away from the cards.
 */

import { useQuery } from "@tanstack/react-query";

import { notesAcceptratesGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";

const C = {
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
} as const;

interface Rate {
  kind: "task" | "memory" | "person_trait";
  confidenceTier: "confident" | "unsure";
  proposed: number;
  accepted: number;
  dismissed: number;
}

const KIND_LABEL: Record<Rate["kind"], string> = {
  task: "Tasks",
  memory: "Memories",
  person_trait: "About people",
};

export function NoteAcceptRate({ assistantId }: { assistantId: string }) {
  const query = useQuery({
    ...notesAcceptratesGetOptions({ path: { assistant_id: assistantId } }),
    enabled: Boolean(assistantId),
    staleTime: 60_000,
  }) as unknown as { data?: { rates: Rate[] } };

  const rates = (query.data?.rates ?? []).filter(
    (rate) => rate.accepted + rate.dismissed > 0,
  );

  // Nothing decided yet means there is no rate, and inventing one from three
  // decisions would be worse than showing none.
  if (rates.length === 0) return null;

  return (
    <div
      className="rounded-lg border p-3"
      style={{ borderColor: C.line, background: C.sunken }}
    >
      <p
        className="text-[10.5px] font-semibold tracking-wide uppercase"
        style={{ color: C.t3 }}
      >
        What you accept
      </p>
      <table className="mt-2 w-full text-[12px]">
        <tbody>
          {rates.map((rate) => {
            const decided = rate.accepted + rate.dismissed;
            const percent = Math.round((rate.accepted / decided) * 100);
            return (
              <tr key={`${rate.kind}:${rate.confidenceTier}`}>
                <td className="py-0.5" style={{ color: C.t1 }}>
                  {KIND_LABEL[rate.kind]}
                  {rate.confidenceTier === "unsure" ? (
                    <span style={{ color: C.t3 }}> · less sure</span>
                  ) : null}
                </td>
                <td className="py-0.5 text-right" style={{ color: C.t2 }}>
                  {rate.accepted} of {decided} kept
                </td>
                <td
                  className="w-12 py-0.5 text-right tabular-nums"
                  style={{ color: C.t1 }}
                >
                  {percent}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[11px] leading-relaxed" style={{ color: C.t3 }}>
        If the confident ones are being turned down, I&rsquo;m finding the wrong
        things — the fix is fewer and better, not asking more often.
      </p>
    </div>
  );
}
