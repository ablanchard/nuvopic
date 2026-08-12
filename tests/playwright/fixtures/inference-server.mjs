import http from "node:http";

const host = "127.0.0.1";
const port = 9090;
const requests = [];
const embedding = Array.from({ length: 512 }, (_, index) =>
  index === 0 ? 1 : 0
);

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}:${port}`);

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/stats") {
    sendJson(response, 200, { requests });
    return;
  }

  if (request.method === "POST" && url.pathname === "/reset") {
    requests.length = 0;
    sendJson(response, 200, { status: "reset" });
    return;
  }

  if (
    request.method === "POST" &&
    (url.pathname === "/caption" || url.pathname === "/faces")
  ) {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const imageBytes = Buffer.from(body.image ?? "", "base64").length;
        requests.push({ path: url.pathname, imageBytes });

        if (imageBytes === 0) {
          sendJson(response, 400, { error: "image is required" });
        } else if (url.pathname === "/caption") {
          sendJson(response, 200, {
            caption: "A person photographed outdoors by the Playwright GPU fixture",
          });
        } else {
          sendJson(response, 200, {
            faces: [
              {
                bbox: { x: 20, y: 20, width: 120, height: 120 },
                embedding,
                confidence: 0.99,
              },
            ],
          });
        }
      } catch (error) {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    return;
  }

  sendJson(response, 404, { error: "not found" });
});

server.listen(port, host);

function shutdown() {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
