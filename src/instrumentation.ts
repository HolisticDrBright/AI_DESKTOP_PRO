export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertAwsProductionRuntime } = await import("./server/runtime/awsProductionGate");
  assertAwsProductionRuntime();
  // The reviewed purchase-to-course runtime: closed unless its flags AND its pinned target verify. A
  // failure leaves it closed and never stops the server. The inline runtime test lets the edge build
  // drop this branch (and its Node-only modules) entirely.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.PROGRAM_COMMERCE_QUALIFICATION_ENABLED === "true") {
    const { bootstrapReviewedCommerce } = await import("./server/commerce/reviewed/reviewed-bootstrap");
    const outcome = await bootstrapReviewedCommerce().catch(() => ({ installed: false as const, reason: "bootstrap_failed" }));
    console.info(JSON.stringify({ event: "program_commerce_bootstrap", ...outcome }));
  }
}
