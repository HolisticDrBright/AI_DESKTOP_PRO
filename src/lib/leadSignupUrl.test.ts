import { describe, expect, it } from 'vitest';
import { leadSignupUrl } from './leadSignupUrl';

describe('the program sign-up address', () => {
  it('is the campaign service origin plus /signup/<program>, only for a program with a list', () => {
    expect(leadSignupUrl('longevity-program', 'https://updates.fictional.example')).toBe('https://updates.fictional.example/signup/longevity-program');
    expect(leadSignupUrl('diabetes-program', 'https://updates.fictional.example/')).toBe('https://updates.fictional.example/signup/diabetes-program');
    expect(leadSignupUrl('journey-fixture-program', 'https://updates.fictional.example')).toBeNull();
  });
  it('is absent without an https origin, or with a path, query, fragment or credentials', () => {
    for (const origin of [undefined, '', 'http://updates.fictional.example', 'https://updates.fictional.example/x', 'https://updates.fictional.example/?a=1', 'https://u:p@updates.fictional.example', 'not a url']) {
      expect(leadSignupUrl('longevity-program', origin), String(origin)).toBeNull();
    }
  });
});
