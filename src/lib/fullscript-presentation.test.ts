import { describe, expect, it } from 'vitest';
import { FULLSCRIPT_INTEGRATE_URL, fullscriptConnectionCopy } from './fullscript-presentation';

describe('Fullscript connection presentation', () => {
  it('does not imply a production login will work against the sandbox identity system', () => {
    const copy = fullscriptConnectionCopy('sandbox_us');
    expect(copy.button).toBe('Connect Fullscript sandbox');
    expect(copy.guidance).toContain('normal Fullscript practitioner email and password may not work');
    expect(copy.failure).toContain('sandbox practitioner or staff account');
  });

  it('keeps the production and unconfigured messages distinct', () => {
    expect(fullscriptConnectionCopy('production_us').guidance).not.toContain('sandbox');
    expect(fullscriptConnectionCopy(null).guidance).toContain('configured');
    expect(FULLSCRIPT_INTEGRATE_URL).toBe('https://fullscript.dev');
  });
});
