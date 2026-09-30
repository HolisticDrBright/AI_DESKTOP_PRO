"use client";

import { AGE_BAND_LABEL, OUTCOME_INTERPRETATION, OUTCOME_LABEL,
  type OutcomeReportResponse } from "@/contracts/practiceOutcomes";

/**
 * What happened in this practice, counted.
 *
 * Rendered from props so each state is testable. Four things it must get right.
 *
 * It says, every time and before the numbers, that this is not evidence that anything works. A
 * practitioner who took these counts as efficacy would tell a patient something untrue, and a
 * dashboard that buried the caveat in a tooltip would be the mechanism.
 *
 * It never computes a total. When the clinic withheld a cell it also withheld the total, and a
 * screen that added the visible counts back up would undo the suppression in one line of code.
 *
 * It says how many groups were withheld and why, rather than showing a shorter list silently.
 *
 * It says nothing at all when the whole cohort is too small, instead of showing an empty table
 * that reads as "no outcomes".
 */
export type PracticeOutcomeState = {
  report: OutcomeReportResponse | null;
  groupBy: ("treatment" | "ageBand" | "sex" | "followupBand")[];
  busy: boolean;
  error: string | null;
  onGroupBy: (value: PracticeOutcomeState["groupBy"]) => void;
  onRun: () => void;
};

const DIMENSIONS: { value: PracticeOutcomeState["groupBy"][number]; label: string }[] = [
  { value: "treatment", label: "Treatment" },
  { value: "ageBand", label: "Age band" },
  { value: "sex", label: "Sex" },
  { value: "followupBand", label: "How long after" },
];

export function PracticeOutcomeView({ state }: { state: PracticeOutcomeState }) {
  const { report, groupBy, busy, error } = state;
  const everythingWithheld = report !== null && report.groups.length === 0;
  return (
    <div data-testid="practice-outcomes" className="rounded-lg border p-3">
      <h3 className="text-sm font-semibold">What happened in this practice</h3>
      {/* Before the numbers, always. */}
      <p data-testid="practice-outcomes-interpretation" className="mt-1 text-sm">
        {OUTCOME_INTERPRETATION}
      </p>
      {error && <p role="alert" data-testid="practice-outcomes-error" className="mt-2 text-sm text-critical">{error}</p>}

      <fieldset className="mt-2">
        <legend className="text-sm">Break the counts down by (up to two)</legend>
        {DIMENSIONS.map(dimension => {
          const chosen = groupBy.includes(dimension.value);
          return (
            <label key={dimension.value} className="mr-3 text-sm">
              <input type="checkbox" data-testid={`practice-outcomes-dimension-${dimension.value}`}
                checked={chosen} disabled={busy || (!chosen && groupBy.length >= 2)}
                onChange={() => state.onGroupBy(chosen
                  ? groupBy.filter(value => value !== dimension.value)
                  : [...groupBy, dimension.value])} />
              {" "}{dimension.label}
            </label>
          );
        })}
      </fieldset>

      <button type="button" data-testid="practice-outcomes-run" disabled={busy} onClick={state.onRun}
        className="mt-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:opacity-50">
        {busy ? "Counting…" : "Count them"}
      </button>

      {report && (everythingWithheld ? (
        <p data-testid="practice-outcomes-all-withheld" className="mt-2 text-sm">
          Not enough people yet to show anything. Every group here is smaller than {report.minimumCohort}, and
          showing counts that small could identify someone. This is not &ldquo;no outcomes&rdquo; &mdash; it is too
          few to report.
        </p>
      ) : (
        <>
          <table className="mt-2 w-full text-sm">
            <thead><tr>
              <th className="text-left">Outcome</th>
              {groupBy.map(dimension => (
                <th key={dimension} className="text-left">
                  {DIMENSIONS.find(entry => entry.value === dimension)?.label}
                </th>
              ))}
              <th className="text-right">People</th>
            </tr></thead>
            <tbody>
              {report.groups.map((group, index) => (
                <tr key={index} data-testid="practice-outcomes-row" className="border-t border-hairline">
                  <td>{OUTCOME_LABEL[group.outcome]}</td>
                  {groupBy.map(dimension => (
                    <td key={dimension}>
                      {dimension === "ageBand" && group.ageBand ? AGE_BAND_LABEL(group.ageBand)
                        : dimension === "treatment" ? group.treatment
                          : dimension === "sex" ? group.sex : group.followupBand}
                    </td>
                  ))}
                  <td className="text-right">{group.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {report.suppressedGroups > 0 ? (
            <p data-testid="practice-outcomes-suppressed" className="mt-2 text-sm">
              {report.suppressedGroups} group{report.suppressedGroups === 1 ? " is" : "s are"} not shown because
              they hold fewer than {report.minimumCohort} people. No total is shown either — with a total you could
              work the withheld numbers out by subtraction.
            </p>
          ) : (
            <p data-testid="practice-outcomes-total" className="mt-2 text-sm">
              {report.total} people in total, with nothing withheld.
            </p>
          )}
        </>
      ))}
    </div>
  );
}
