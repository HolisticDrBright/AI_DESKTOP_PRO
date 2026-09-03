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
