export function parseTelehealthRuntimeMode(value: string): "synthetic" | "production" {
  if (value !== "synthetic" && value !== "production") throw new Error("telehealth_configuration_invalid");
  return value;
}
