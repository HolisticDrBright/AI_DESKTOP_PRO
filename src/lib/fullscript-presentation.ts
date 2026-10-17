export type FullscriptEnvironment = 'sandbox_us' | 'production_us' | null;

export const FULLSCRIPT_INTEGRATE_URL = 'https://fullscript.dev';

export function fullscriptConnectionCopy(environment: FullscriptEnvironment) {
  if (environment === 'sandbox_us') {
    return {
      button: 'Connect Fullscript sandbox',
      guidance: 'This test connector uses Fullscript Integrate sandbox. Your normal Fullscript practitioner email and password may not work in the sandbox. Sign in with the sandbox practitioner or staff account associated with this API client.',
      failure: 'The Fullscript sandbox did not authorize this connection. Use the sandbox practitioner or staff account assigned in Fullscript Integrate—not your normal production Fullscript login.',
    } as const;
  }
  if (environment === 'production_us') {
    return {
      button: 'Connect Fullscript',
      guidance: 'Sign in with the Fullscript practitioner or staff account authorized for this clinic.',
      failure: 'Fullscript did not authorize this connection. Confirm the account has practitioner or staff access to this clinic and try again.',
    } as const;
  }
  return {
    button: 'Connect Fullscript',
    guidance: 'Fullscript must be configured before an account can be connected.',
    failure: 'Fullscript did not authorize this connection.',
  } as const;
}

/** Where the OAuth callback sends the practitioner back: a closed set, each a true statement about what happened. */
export const FULLSCRIPT_CALLBACK_OUTCOMES = ['connected', 'already_connected', 'practitioner_connected_elsewhere', 'link_used', 'not_authorized',
  'session_changed', 'unavailable', 'unconfirmed'] as const;
export type FullscriptCallbackOutcome = typeof FULLSCRIPT_CALLBACK_OUTCOMES[number];

/** The value in `?fullscript=`, or null. `connection_failed` is what earlier deployments sent for every failure. */
export function readFullscriptCallbackOutcome(value: string | null): FullscriptCallbackOutcome | 'connection_failed' | null {
  if (value === 'connection_failed') return value;
  return (FULLSCRIPT_CALLBACK_OUTCOMES as readonly string[]).includes(value ?? '') ? value as FullscriptCallbackOutcome : null;
}

export type FullscriptPosture = {
  configured: boolean;
  connected: boolean;
  environment: FullscriptEnvironment;
  resourceOwnerType?: string | null;
  scopes?: string[];
  connectedAt?: string | null;
  reason?: string;
  /** A saved connection exists that is not used until this account reconnects; `reconnectReason` says why. */
  reconnectRequired?: boolean;
  reconnectReason?: 'account_binding' | 'membership_changed';
};

export const FULLSCRIPT_RECONNECT_COPY = {
  account_binding: 'An earlier Fullscript connection was saved before connections were tied to your account, so it isn’t used. Reconnect to use Fullscript.',
  membership_changed: 'Your clinic access changed after this Fullscript connection was made, so it isn’t used. Reconnect to use Fullscript.',
} as const;

/**
 * What the Fullscript card says and offers, from what is actually known. An outage is never "Not configured" and never
 * "Ready to connect": while the status cannot be read, nothing is claimed about the connection and nothing is offered.
 */
export function fullscriptPanelState(input: {
  posture: FullscriptPosture | null;
  /** The status read failed (the server's clinician-safe message), or null. */
  loadError: string | null;
  outcome: FullscriptCallbackOutcome | 'connection_failed' | null;
  busy: 'connecting' | 'disconnecting' | null;
}) {
  const { posture, loadError, outcome, busy } = input;
  const copy = fullscriptConnectionCopy(posture?.environment ?? null);
  const known = loadError === null && posture !== null;
  const connected = known && posture.connected;
  const badge = loadError !== null ? 'Unavailable' : posture === null ? 'Checking…'
    : busy === 'connecting' ? 'Connecting…' : busy === 'disconnecting' ? 'Disconnecting…'
      : posture.connected ? 'Connected' : posture.reconnectRequired ? 'Reconnect needed' : posture.configured ? 'Ready to connect' : 'Not configured';
  const notice = outcome === null || outcome === 'connected' ? null : {
    already_connected: 'This account is already connected to Fullscript in this clinic, so nothing was changed. To use a different Fullscript account, disconnect first.',
    practitioner_connected_elsewhere: 'That Fullscript account is already connected to another Desktop account, so nothing was saved here and that connection was not changed. A Fullscript account connects to one Desktop account: disconnect it there first, or ask support to move it.',
    link_used: 'That Fullscript sign-in link was already used or has expired, so nothing was changed. Start again from Connect if you still need to connect.',
    not_authorized: copy.failure,
    session_changed: 'That Fullscript sign-in was started from a different account, clinic or session, so nothing was saved. Start again from Connect.',
    unavailable: 'Fullscript couldn’t be connected right now, so nothing was saved. Try again in a moment.',
    unconfirmed: 'Fullscript’s answer was lost on the way back, so we can’t yet say whether this connected. Refresh in a moment: if it shows Connected, it worked; if not, nothing was saved.',
    connection_failed: 'Fullscript wasn’t connected, so nothing was saved. Try again.',
  }[outcome];
  return {
    badge,
    connected,
    showConnect: known && !posture.connected,
    connectEnabled: known && !posture.connected && posture.configured && busy === null,
    showDisconnect: connected,
    disconnectEnabled: connected && busy === null,
    reconnectMessage: known && posture.reconnectRequired ? FULLSCRIPT_RECONNECT_COPY[posture.reconnectReason ?? 'account_binding'] : null,
    notice,
    setupHint: known && !posture.configured ? 'Add the sandbox credentials to the AWS secret and configure the encrypted token table before connecting.' : null,
  };
}
