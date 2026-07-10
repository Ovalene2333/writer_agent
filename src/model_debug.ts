import process from "node:process";

export function modelDebugEnabled(): boolean {
  return /^(?:1|true|yes|on)$/i.test(process.env.WRITER_DEBUG ?? "");
}

export function logModelRequest(endpoint: string, body: string): void {
  if (!modelDebugEnabled()) return;
  process.stderr.write(`\n[WRITER DEBUG] REQUEST ${endpoint}\n${body}\n[WRITER DEBUG] END REQUEST\n`);
}

export function logModelResponse(endpoint: string, body: string): void {
  if (!modelDebugEnabled()) return;
  process.stderr.write(`\n[WRITER DEBUG] RESPONSE ${endpoint}\n${body}\n[WRITER DEBUG] END RESPONSE\n`);
}
