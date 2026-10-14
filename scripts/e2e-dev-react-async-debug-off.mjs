import asyncHooks from 'node:async_hooks';
import { syncBuiltinESMExports } from 'node:module';

/**
 * Loaded only into the browser harness's development server worker, beside the memory probe
 * (scripts/e2e-dev-resources.mjs). Never in production, `next build`, or ordinary development.
 *
 * The development build of React's server renderer that Next 15.5 bundles (React 19.2 canary) installs, when it loads,
 * an async_hooks hook that records a node for every promise created while a render is pending — owner, a captured
 * stack trace, timings and the promises it awaited — for React DevTools' async debug information. Those nodes leave its
 * map only when a promise is collected, and some hold their promise, so across a long browser battery the dev server's
 * retained heap grows with every render until Next restarts its own worker at 80 % of the heap limit, mid-test.
 *
 * This leaves exactly that hook disabled: one created from Next's bundled development renderer with React's callback
 * shape. Every other async_hooks user is untouched, and the application's routes, responses and data are unchanged —
 * only the development-only async debug information is absent. One line records that it acted (no paths or data).
 */
const RENDERER = /next\/dist\/compiled\/next-server\/app-(?:page|route)(?:-[a-z]+)*\.runtime\.dev\.js|react-server-dom-[a-z]+\/cjs\/react-server-dom-[a-z]+-server\.[a-z.]*development\.js/;

if (process.env.E2E_DEV_SERVER === '1'
  && process.env.NEXT_PRIVATE_WORKER === '1'
  && process.env.NODE_ENV === 'development') {
  const original = asyncHooks.createHook;
  asyncHooks.createHook = function createHook(callbacks) {
    const hook = original.call(this, callbacks);
    const reactShape = callbacks && typeof callbacks.init === 'function' && typeof callbacks.promiseResolve === 'function'
      && typeof callbacks.destroy === 'function';
    if (reactShape && RENDERER.test(String(new Error().stack))) {
      hook.enable = function enable() { return this; };
      console.error(JSON.stringify({ check: 'e2e_next_dev_react_async_debug', event: 'disabled', pid: process.pid }));
    }
    return hook;
  };
  syncBuiltinESMExports();
}
