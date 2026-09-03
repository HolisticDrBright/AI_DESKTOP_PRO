import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Desktop Ask ALP status', () => {
  it('does not present Desktop as the consumer activation gate', () => {
    const source = readFileSync(path.join(process.cwd(), 'src', 'app', 'settings', 'ask-alp', 'page.tsx'), 'utf8');
    expect(source).toContain('Enabled for authenticated V2 consumers');
    expect(source).toContain('does not require a Desktop practitioner activation');
    expect(source).toContain('There is no confirmation code to enter here');
    expect(source).not.toContain('<AskAlpActivation />');
  });
});
