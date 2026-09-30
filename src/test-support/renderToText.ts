import type {ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

/**
 * Render a component and read back what it actually says.
 *
 * Every screen assertion in this repository was a source scan: the file contains this
 * string, therefore the screen shows it. That is weaker than it looks — a string can sit
 * in a branch that never renders, or behind a condition that inverted — and it is why the
 * empty/failed/loading distinction could only be checked structurally.
 *
 * This closes the part of the gap that needs no new dependency. `react-dom/server` is
 * already here, so a component can be rendered for real and its text and test ids
 * asserted. Tests using it are written with `createElement` rather than JSX, because this
 * project's tsconfig sets `jsx: "preserve"` for Next.js and the test transform cannot
 * parse JSX under it; that is a smaller price than reconfiguring the build.
 *
 * What it cannot do is interact. There is no DOM, so no clicking, and `useEffect` does not
 * run, so a component that loads in an effect renders its first state and no other. Those
 * cases need a DOM environment and a testing library — new dependency trees on an
 * application heading into a security review, and a decision for the owner rather than a
 * detail of a test helper. So this is used where the branch is decided by props or by
 * first render, and the source scans stay for the rest rather than being replaced by
 * something that looks stronger and is not.
 */
export function renderToText(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&#x27;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ').trim();
}

/** The raw markup, for asserting a test id or an attribute rather than prose. */
export function renderToMarkup(element: ReactElement): string {
  return renderToStaticMarkup(element);
}

/** Which of a component's declared test ids are present in what it actually rendered. */
export function renderedTestIds(element: ReactElement): string[] {
  return [...new Set([...renderToStaticMarkup(element).matchAll(/data-testid="([^"]+)"/g)].map(match => match[1]!))].sort();
}
