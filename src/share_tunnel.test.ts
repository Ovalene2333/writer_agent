import assert from "node:assert/strict";
import test from "node:test";
import {
  buildShareEntryUrl,
  diagnoseTunnelFailure,
  formatTunnelFailureReport,
  isAllowedPublicOrigin,
  normalizePublicOrigin,
  tunnelLogTail,
} from "./share_tunnel.js";

test("share entry URLs explicitly distinguish token and no-token modes", () => {
  assert.equal(
    buildShareEntryUrl("http://192.168.1.2:4096", "secret", "public", "https://demo.trycloudflare.com"),
    "http://192.168.1.2:4096/#token=secret&public=https%3A%2F%2Fdemo.trycloudflare.com",
  );
  assert.equal(
    buildShareEntryUrl("https://demo.trycloudflare.com", "", "lan", "http://192.168.1.2:4096"),
    "https://demo.trycloudflare.com/#auth=none&lan=http%3A%2F%2F192.168.1.2%3A4096",
  );
  assert.equal(
    buildShareEntryUrl("https://ovalene.dpdns.org", "secret", "lan", "http://192.168.1.2:4096"),
    "https://ovalene.dpdns.org/#token=secret&lan=http%3A%2F%2F192.168.1.2%3A4096",
  );
});

test("normalizePublicOrigin accepts bare hostnames for Named Tunnel", () => {
  assert.equal(normalizePublicOrigin("ovalene.dpdns.org"), "https://ovalene.dpdns.org");
  assert.equal(normalizePublicOrigin("https://ovalene.dpdns.org/"), "https://ovalene.dpdns.org");
  assert.throws(() => normalizePublicOrigin("http://ovalene.dpdns.org"), /https/);
  assert.ok(isAllowedPublicOrigin("https://ovalene.dpdns.org"));
  assert.ok(isAllowedPublicOrigin("https://demo.trycloudflare.com"));
  assert.equal(isAllowedPublicOrigin("http://192.168.1.2:4096"), false);
});

const edgeTimeoutLog = [
  '2026-07-14T16:24:45Z ERR Unable to establish connection with Cloudflare edge error="TLS handshake with edge error: read tcp 192.168.152.127:14270->198.41.192.107:7844: i/o timeout"',
  "2026-07-14T16:24:45Z INF Retrying connection in up to 2s",
].join("\n");

test("diagnoseTunnelFailure identifies Cloudflare edge TLS timeouts", () => {
  const diagnosis = diagnoseTunnelFailure(edgeTimeoutLog);
  assert.match(diagnosis.cause, /TLS 握手超时/);
  assert.ok(diagnosis.suggestions.some(item => item.includes("TCP 7844")));
});

test("diagnoseTunnelFailure distinguishes DNS failures", () => {
  const diagnosis = diagnoseTunnelFailure("ERR failed to resolve region1.v2.argotunnel.com: no such host");
  assert.match(diagnosis.cause, /DNS/);
});

test("tunnelLogTail strips ANSI codes and bounds verbose diagnostics", () => {
  const output = Array.from({ length: 25 }, (_, index) => `\u001b[31mline-${index}\u001b[0m`).join("\n");
  const tail = tunnelLogTail(output, 3);
  assert.equal(tail, "line-22\nline-23\nline-24");
});

test("formatTunnelFailureReport includes attempts, diagnosis, advice and raw log tail", () => {
  const report = formatTunnelFailureReport([
    { attempt: 1, code: 1, output: "first failure" },
    { attempt: 2, code: 1, output: edgeTimeoutLog },
    { attempt: 3, code: 1, output: edgeTimeoutLog },
  ]);
  assert.match(report, /已尝试 3\/3 次/);
  assert.match(report, /判断：.*TLS 握手超时/);
  assert.match(report, /恢复建议/);
  assert.match(report, /最近一次 cloudflared 日志/);
  assert.match(report, /198\.41\.192\.107:7844/);
});
