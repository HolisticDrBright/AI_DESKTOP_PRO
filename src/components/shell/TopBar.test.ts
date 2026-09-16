import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('does not claim authentication from a static shared shell', () => {
  const source = readFileSync('src/components/shell/TopBar.tsx', 'utf8');
  expect(source).not.toContain('Signed-in practitioner');
  expect(source).toContain('Session &amp; organization');
  expect(source).toContain('href="/login"');
  expect(source).toContain('Practitioner sign-in</Link>');
  expect(source).toContain('<SignOutButton />');
});
