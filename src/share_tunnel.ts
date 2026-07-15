import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import process from "node:process";
import QRCode from "qrcode";

const MAX_ATTEMPTS = 3;
const RESTART_DELAYS_MS = [2_000, 5_000];
const MAX_OUTPUT_CHARS = 24_000;
const REPORT_LOG_LINES = 18;

export interface ShareTunnelController {
  kill(): void;
}

export interface TunnelFailure {
  attempt: number;
  code: number | null;
  output: string;
}

export interface TunnelDiagnosis {
  cause: string;
  suggestions: string[];
}

export function diagnoseTunnelFailure(output: string): TunnelDiagnosis {
  if (/TLS handshake with edge error:[^\n]*(?:i\/o timeout|deadline exceeded)/i.test(output)) {
    return {
      cause: "到 Cloudflare 边缘节点的 TLS 握手超时；TCP 7844 路径可能被网络、防火墙或运营商瞬时丢包。",
      suggestions: [
        "程序已固定使用 HTTP/2，并会切换边缘节点后自动重启隧道。",
        "若连续失败，请检查防火墙是否允许访问 Cloudflare TCP 7844，或换一个网络重试。",
      ],
    };
  }
  if (/(?:lookup .* no such host|DNS query failed|failed to resolve)/i.test(output)) {
    return {
      cause: "无法解析 Cloudflare 域名，当前 DNS 服务不可用或受到了拦截。",
      suggestions: ["检查系统 DNS 和代理设置，然后确认 api.cloudflare.com 可以解析和访问。"],
    };
  }
  if (/(?:connection refused|connectex: No connection could be made)/i.test(output)) {
    return {
      cause: "目标连接被明确拒绝，可能是代理、防火墙或本机安全软件阻止了 cloudflared。",
      suggestions: ["允许 cloudflared 出站联网，并检查代理是否支持到 Cloudflare 的长连接。"],
    };
  }
  if (/(?:quick tunnel|trycloudflare)[^\n]*(?:failed|error|unavailable|status code 4\d\d|status code 5\d\d)/i.test(output)) {
    return {
      cause: "Cloudflare Quick Tunnel 地址申请失败或服务暂时不可用。",
      suggestions: [
        "稍后重试，并检查 ~/.cloudflared/config.yaml 是否包含命名隧道配置。",
        "若需要稳定公网地址，请改用已登录的命名 Tunnel。",
      ],
    };
  }
  if (/(?:x509|certificate|tls: failed to verify)/i.test(output)) {
    return {
      cause: "TLS 证书校验失败，常见原因是系统时间错误或 HTTPS 检查代理替换了证书。",
      suggestions: ["校准系统时间，并检查杀毒软件、公司代理或网关的 HTTPS/TLS 检查设置。"],
    };
  }
  if (/(?:i\/o timeout|context deadline exceeded|failed to connect|Unable to establish connection)/i.test(output)) {
    return {
      cause: "连接 Cloudflare 时超时，网络链路不稳定或出站连接受到限制。",
      suggestions: ["检查网络、防火墙和代理；也可换用手机热点确认是否为当前网络的问题。"],
    };
  }
  return {
    cause: "cloudflared 意外退出，日志中没有匹配到已知故障类型。",
    suggestions: ["根据下方原始日志定位原因；必要时用 `cloudflared tunnel --loglevel debug --url http://127.0.0.1:<端口>` 复现。"],
  };
}

export function tunnelLogTail(output: string, maxLines = REPORT_LOG_LINES): string {
  const lines = output
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim().length > 0);
  return lines.slice(-maxLines).join("\n");
}

export function formatTunnelFailureReport(failures: TunnelFailure[]): string {
  const latest = failures.at(-1);
  if (!latest) return "cloudflared 未提供失败详情。\n";
  const diagnosis = diagnoseTunnelFailure(latest.output);
  const lines = [
    "",
    `cloudflared 公网隧道最终失败（已尝试 ${failures.length}/${MAX_ATTEMPTS} 次，最后退出代码 ${latest.code ?? "未知"}）。`,
    `判断：${diagnosis.cause}`,
    "恢复建议：",
    ...diagnosis.suggestions.map(item => `  - ${item}`),
    "最近一次 cloudflared 日志：",
  ];
  const tail = tunnelLogTail(latest.output);
  if (tail) lines.push(...tail.split("\n").map(line => `  ${line}`));
  else lines.push("  （cloudflared 没有输出日志）");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function startShareTunnel(port: number, token: string, lanOrigin: string): ShareTunnelController {
  process.stdout.write("正在创建公网临时访问地址（cloudflared）...\n");
  process.stdout.write(`本机/局域网源：${lanOrigin}\n`);

  let active: ChildProcessWithoutNullStreams | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  const failures: TunnelFailure[] = [];

  const launch = (attempt: number) => {
    if (stopped) return;
    let printed = false;
    let registered = false;
    let publicOrigin = "";
    let outputBuffer = "";
    let readinessTimer: NodeJS.Timeout | undefined;
    let spawnError: Error | undefined;
    let valid = true;

    const tunnel = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${port}`], {
      windowsHide: true,
      stdio: "pipe",
      env: {
        ...process.env,
        TUNNEL_TRANSPORT_PROTOCOL: process.env.WRITER_TUNNEL_PROTOCOL || "http2",
      },
    });
    active = tunnel;

    const printAccess = () => {
      if (printed || !publicOrigin) return;
      printed = true;
      if (readinessTimer) clearTimeout(readinessTimer);
      // 二维码走局域网入口：页在 HTTP 上，才能在局域网/Cloudflare 间自动切 API（HTTPS 页无法探测 HTTP 局域网）。
      const dualEntry = `${lanOrigin}/#token=${encodeURIComponent(token)}&public=${encodeURIComponent(publicOrigin)}`;
      const publicOnly = `${publicOrigin}/#token=${encodeURIComponent(token)}&lan=${encodeURIComponent(lanOrigin)}`;
      process.stdout.write("\n手机扫码（推荐，一次即可；在家走局域网，出门自动切 Cloudflare）：\n");
      process.stdout.write(`${dualEntry}\n`);
      void QRCode.toString(dualEntry, { type: "terminal", small: true })
        .then(qr => {
          if (stopped || !valid) return;
          process.stdout.write(qr);
          process.stdout.write(`仅公网备用（不在家 Wi‑Fi 时打开）：\n${publicOnly}\n`);
          process.stdout.write("注意：公网地址会暴露写作工作台。只给可信设备；结束进程后隧道关闭。隧道重连后请使用最新地址。\n");
        })
        .catch(() => {
          if (valid) process.stdout.write("二维码生成失败，请直接复制上方地址。\n");
        });
    };

    const handleOutput = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      outputBuffer = `${outputBuffer}${text}`.slice(-MAX_OUTPUT_CHARS);
      const match = outputBuffer.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match && !publicOrigin) {
        publicOrigin = match[0];
        process.stdout.write("公网地址已分配，正在等待隧道连接就绪...\n");
        readinessTimer = setTimeout(() => {
          if (printed || stopped) return;
          const diagnosis = diagnoseTunnelFailure(outputBuffer);
          process.stderr.write(`公网隧道仍在连接，cloudflared 正在切换边缘节点。当前判断：${diagnosis.cause}\n`);
        }, 15_000);
      }
      if (!registered && /Registered tunnel connection/i.test(outputBuffer)) {
        registered = true;
        failures.length = 0;
        const registeredAt = outputBuffer.lastIndexOf("Registered tunnel connection");
        if (registeredAt >= 0) outputBuffer = outputBuffer.slice(registeredAt);
        printAccess();
      }
    };
    tunnel.stdout.on("data", handleOutput);
    tunnel.stderr.on("data", handleOutput);

    tunnel.once("error", (error) => {
      spawnError = error;
    });
    tunnel.once("close", (code) => {
      valid = false;
      if (readinessTimer) clearTimeout(readinessTimer);
      if (active === tunnel) active = undefined;
      if (stopped) return;

      if (spawnError) {
        process.stderr.write(`无法启动 cloudflared：${spawnError.message}\n`);
        process.stderr.write("请先安装 Cloudflare Tunnel 客户端，或改用 `writer web --lan` 只在局域网访问。\n");
        return;
      }

      if (registered) {
        failures.length = 0;
        const delay = RESTART_DELAYS_MS[0];
        const diagnosis = diagnoseTunnelFailure(outputBuffer);
        process.stderr.write(`已建立的公网隧道中断，旧公网地址已失效（cloudflared 代码 ${code ?? "未知"}）。${diagnosis.cause}\n`);
        process.stderr.write(`${delay / 1_000} 秒后自动重新创建隧道（新一轮第 1/${MAX_ATTEMPTS} 次）...\n`);
        restartTimer = setTimeout(() => launch(1), delay);
        return;
      }

      failures.push({ attempt, code, output: outputBuffer });
      if (attempt < MAX_ATTEMPTS) {
        const delay = RESTART_DELAYS_MS[attempt - 1] ?? RESTART_DELAYS_MS.at(-1) ?? 5_000;
        const diagnosis = diagnoseTunnelFailure(outputBuffer);
        process.stderr.write(`公网隧道尚未就绪（cloudflared 代码 ${code ?? "未知"}）。${diagnosis.cause}\n`);
        process.stderr.write(`${delay / 1_000} 秒后自动重新创建隧道（第 ${attempt + 1}/${MAX_ATTEMPTS} 次）...\n`);
        restartTimer = setTimeout(() => launch(attempt + 1), delay);
        return;
      }
      process.stderr.write(formatTunnelFailureReport(failures));
    });
  };

  launch(1);
  return {
    kill() {
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      active?.kill();
    },
  };
}
