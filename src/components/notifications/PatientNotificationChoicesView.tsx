import { NOTICE_KINDS, NOTICE_KIND_PHRASE, type ClinicNotificationSettingsView } from "@/contracts/patientNotifications";

/**
 * A linked patient's reminder and notice choices, as the clinic sees them: read only.
 *
 * There is no control here that changes a choice, and the route behind it has no such
 * request. Only the patient can turn on texts, from the app, at a number they agree to.
 *
 * The four states say different things and look different:
 * - loading: nothing is known yet;
 * - unavailable: the read failed, which says nothing about what the patient chose;
 * - refused: the clinic's access changed;
 * - loaded: what the patient chose, with "Unknown" where nothing was recorded.
 */
export type PatientNotificationChoicesState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "refused" }
  | { status: "loaded"; view: ClinicNotificationSettingsView };

const sentence = (phrase: string) => phrase.charAt(0).toUpperCase() + phrase.slice(1);

/** A text switched on is not a text sent: without an agreement, or after STOP, nothing goes out. */
function textLabel(on: boolean, view: ClinicNotificationSettingsView): string {
  if (!on) return "Off";
  if (view.textStopped) return "On, but stopped: the patient replied STOP";
  if (!view.textConsent) return "On, but not sent: no agreement on record";
  return "On";
}

export function PatientNotificationChoicesView({ state, busy, onRefresh }:
  { state: PatientNotificationChoicesState; busy: boolean; onRefresh: () => void }) {
  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="patient-notification-choices">
      <p className="font-semibold">Reminders and notices: the patient&apos;s choices</p>
      <p className="text-sm" data-testid="patient-notification-choices-read-only">
        Read only. Only the patient can turn on texts, from the app, at a number they agree to. Nothing here changes
        a choice.
      </p>
      <button className="rounded-lg border px-3 py-2 text-sm font-semibold" disabled={busy} onClick={onRefresh}>
        Load the patient&apos;s choices
      </button>
      {state.status === "loading" ? (
        <p role="status" data-testid="patient-notification-choices-loading">Loading the patient&apos;s choices…</p>
      ) : null}
      {state.status === "unavailable" ? (
        <p role="alert" data-testid="patient-notification-choices-unavailable">
          The patient&apos;s choices can&apos;t be read right now. This does not mean they chose nothing.
        </p>
      ) : null}
      {state.status === "refused" ? (
        <p role="alert" data-testid="patient-notification-choices-refused">
          Access changed. Sign in and check your clinic access, then load again.
        </p>
      ) : null}
      {state.status === "loaded" ? <Loaded view={state.view} /> : null}
    </div>
  );
}

function Loaded({ view }: { view: ClinicNotificationSettingsView }) {
  const reminders = view.preferences.appointmentReminders;
  return (
    <div className="space-y-2 text-sm" data-testid="patient-notification-choices-loaded">
      <table className="w-full text-left">
        <thead><tr><th>For</th><th>Email</th><th>Text</th><th>Push</th></tr></thead>
        <tbody>
          <tr data-testid="choice-appointment-reminders">
            <td>Appointment reminders</td><td>{reminders.email ? "On" : "Off"}</td>
            <td>{textLabel(reminders.sms, view)}</td><td>Not available</td>
          </tr>
          {NOTICE_KINDS.map(kind => {
            const choice = view.preferences.notices[kind];
            return (
              <tr key={kind} data-testid={`choice-${kind}`}>
                <td>{sentence(NOTICE_KIND_PHRASE[kind])}</td><td>{choice.email ? "On" : "Off"}</td>
                <td>{textLabel(choice.sms, view)}</td><td>Not available</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p data-testid="choice-text-agreement">
        {view.textConsent
          ? `Agreed to texts at a number ending ${view.textConsent.phoneLastTwo} on ${new Date(view.textConsent.agreedAt).toLocaleDateString("en-US", { dateStyle: "medium" })} (wording ${view.textConsent.wordingVersion}).`
          : "Has not agreed to texts. No text is sent."}
      </p>
      {view.textStopped ? (
        <p data-testid="choice-text-stopped">Replied STOP. No text is sent until they agree again from the app.</p>
      ) : null}
      <p data-testid="choice-time-zone">
        Time zone: {view.timeZone ?? "Unknown"}{view.timeZone ? "" : ". No text is sent without one."}
      </p>
      <p>Push notices are not available in the patient app.</p>
    </div>
  );
}
