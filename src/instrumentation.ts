export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertAwsProductionRuntime } = await import("./server/runtime/awsProductionGate");
  assertAwsProductionRuntime();
}
