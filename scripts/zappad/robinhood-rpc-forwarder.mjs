import { createServer } from "node:http";

const HOST = "127.0.0.1";
const PORT = Number(process.env.ROBINHOOD_RPC_FORWARD_PORT ?? 8548);
const UPSTREAM = "https://rpc.mainnet.chain.robinhood.com";
const MAX_BODY_BYTES = 1_000_000;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65_535) {
  throw new Error("ROBINHOOD_RPC_FORWARD_PORT must be a valid TCP port");
}

const server = createServer((request, response) => {
  if (request.method !== "POST") {
    response.writeHead(405, { allow: "POST" });
    response.end();
    return;
  }

  let body = "";
  let bodyBytes = 0;
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    bodyBytes += Buffer.byteLength(chunk);
    if (bodyBytes > MAX_BODY_BYTES) {
      response.writeHead(413);
      response.end();
      request.destroy();
      return;
    }
    body += chunk;
  });
  request.on("end", async () => {
    if (response.writableEnded) return;
    try {
      const upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "curl/8.7.1"
        },
        body,
        signal: AbortSignal.timeout(30_000)
      });
      response.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json"
      });
      response.end(await upstream.text());
    } catch (error) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error)
        })
      );
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Robinhood RPC forwarder listening on http://${HOST}:${PORT}`);
});
