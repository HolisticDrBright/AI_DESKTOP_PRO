// The browser harness's development server preload, loaded by the explicit E2E resource budget
// (scripts/e2e-dev-resources.mjs) and nowhere else. It is ONE module on purpose: `next dev` re-parses NODE_OPTIONS for
// its worker into a single value per option (node_modules/next/dist/cli/next-dev.js, getParsedNodeOptionsWithoutInspect),
// so a second `--import` would silently replace the first. Each imported module applies its own gate.
import './e2e-dev-memory-probe.mjs';
import './e2e-dev-react-async-debug-off.mjs';
