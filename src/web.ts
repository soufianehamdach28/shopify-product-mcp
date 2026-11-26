import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  localhostHostValidation,
  localhostOriginValidation,
  originValidation,
  toNodeHandler
} from "@modelcontextprotocol/node";
import { createProductServer } from "./mcp.js";
import {
  getProductByHandle,
  getStoreOverview,
  listCollections,
  loadConfig,
  resolveStoreSource,
  searchCatalog,
  StoreInputError,
  type CatalogSource
} from "./shopify.js";

const PUBLIC_DIR = new URL("../public/", import.meta.url);

const STATIC_FILES: Record<string, { file: string; contentType: string }> = {
  "/": {
    file: "index.html",
    contentType: "text/html; charset=utf-8"
  },
  "/index.html": {
    file: "index.html",
    contentType: "text/html; charset=utf-8"
  },
  "/app.js": {
    file: "app.js",
    contentType: "text/javascript; charset=utf-8"
  },
  "/styles.css": {
    file: "styles.css",
    contentType: "text/css; charset=utf-8"
  }
};

const config = loadConfig();
const mcpHandler = createMcpHandler(
  () => createProductServer(config),
  {
    onerror: (error) => {
      console.error("[shopify-product-mcp] MCP handler error:", error);
    }
  }
);
const handleMcpRequest = toNodeHandler(mcpHandler, {
  onerror: (error) => {
    console.error("[shopify-product-mcp] MCP adapter error:", error);
  }
});

const validateHost = config.allowedHosts
  ? hostHeaderValidation(config.allowedHosts)
  : localhostHostValidation();
const validateOrigin = config.allowedOrigins
  ? originValidation(config.allowedOrigins)
  : localhostOriginValidation();

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  const payload = JSON.stringify(body, null, 2);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders
  });
  res.end(payload);
}

function sendMethodNotAllowed(
  res: ServerResponse,
  allowed: string
): void {
  sendJson(
    res,
    405,
    { error: "Method not allowed." },
    { Allow: allowed }
  );
}

function parseLimit(value: string | null): number | null {
  if (value === null) {
    return 24;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const limit = Number(value);

  if (limit < 1 || limit > 50) {
    return null;
  }

  return limit;
}

function tokenMatches(provided: string | undefined, expected: string): boolean {
  const prefix = "Bearer ";

  if (!provided?.startsWith(prefix)) {
    return false;
  }

  const providedToken = Buffer.from(provided.slice(prefix.length));
  const expectedToken = Buffer.from(expected);

  return (
    providedToken.length === expectedToken.length &&
    timingSafeEqual(providedToken, expectedToken)
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function resolveRequestStore(
  res: ServerResponse,
  url: URL
): CatalogSource | null {
  try {
    return resolveStoreSource(url.searchParams.get("store"), {
      fallback: config.defaultStoreUrl,
      allowedStoreHosts: config.allowedStoreHosts
    });
  } catch (error) {
    if (error instanceof StoreInputError) {
      sendJson(res, 400, { error: error.message });
      return null;
    }

    throw error;
  }
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return;
  }

  const entry = STATIC_FILES[new URL(req.url ?? "/", "http://localhost").pathname];

  if (!entry) {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  try {
    const body = await readFile(new URL(entry.file, PUBLIC_DIR));

    res.writeHead(200, {
      "Content-Type": entry.contentType,
      "Content-Length": body.byteLength,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    res.end(body);
  } catch (error) {
    console.error("[shopify-product-mcp] Static file error:", error);
    sendJson(res, 500, { error: "Unable to load the web interface." });
  }
}

async function serveApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname === "/api/collections") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    const source = resolveRequestStore(res, url);

    if (!source) {
      return true;
    }

    try {
      const collections = await listCollections(source);
      sendJson(res, 200, {
        store: source.baseUrl,
        count: collections.length,
        collections
      });
    } catch (error) {
      sendJson(res, 502, {
        error: errorMessage(error, "Collection listing failed.")
      });
    }

    return true;
  }

  if (url.pathname === "/api/products") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    const source = resolveRequestStore(res, url);

    if (!source) {
      return true;
    }

    const query = (url.searchParams.get("q") ?? "").trim();

    if (query.length > 120) {
      sendJson(res, 400, {
        error: "q must be at most 120 characters."
      });
      return true;
    }

    const limit = parseLimit(url.searchParams.get("limit"));

    if (limit === null) {
      sendJson(res, 400, {
        error: "limit must be an integer between 1 and 50."
      });
      return true;
    }

    const collection = (url.searchParams.get("collection") ?? "").trim();

    if (collection && !/^[a-zA-Z0-9_-]+$/.test(collection)) {
      sendJson(res, 400, { error: "Invalid collection handle." });
      return true;
    }

    const minPriceRaw = url.searchParams.get("min_price");
    const maxPriceRaw = url.searchParams.get("max_price");
    const minPrice = minPriceRaw ? Number(minPriceRaw) : null;
    const maxPrice = maxPriceRaw ? Number(maxPriceRaw) : null;
    const inStockOnly = url.searchParams.get("in_stock") === "true";
    const vendor = (url.searchParams.get("vendor") ?? "").trim() || null;
    const productType = (url.searchParams.get("type") ?? "").trim() || null;
    const sortByRaw = url.searchParams.get("sort");
    const allowedSorts = ["relevance", "price_asc", "price_desc", "title_asc", "title_desc"] as const;
    const sortBy = allowedSorts.includes(sortByRaw as typeof allowedSorts[number])
      ? (sortByRaw as typeof allowedSorts[number])
      : "relevance";

    try {
      const products = await searchCatalog(
        source,
        query,
        limit,
        {
          collection: collection || null,
          minPrice: minPrice !== null && !isNaN(minPrice) ? minPrice : null,
          maxPrice: maxPrice !== null && !isNaN(maxPrice) ? maxPrice : null,
          inStockOnly: inStockOnly || null,
          vendor,
          productType,
          sortBy
        }
      );

      sendJson(res, 200, {
        store: source.baseUrl,
        collection: collection || null,
        count: products.length,
        products
      });
    } catch (error) {
      sendJson(res, 502, {
        error: errorMessage(error, "Product search failed.")
      });
    }

    return true;
  }

  if (url.pathname === "/api/overview") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }

    const source = resolveRequestStore(res, url);

    if (!source) {
      return true;
    }

    try {
      const overview = await getStoreOverview(source);
      sendJson(res, 200, overview);
    } catch (error) {
      sendJson(res, 502, {
        error: errorMessage(error, "Store overview failed.")
      });
    }

    return true;
  }

  const handlePrefix = "/api/products/";

  if (!url.pathname.startsWith(handlePrefix)) {
    return false;
  }

  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }

  const source = resolveRequestStore(res, url);

  if (!source) {
    return true;
  }

  let handle: string;

  try {
    handle = decodeURIComponent(url.pathname.slice(handlePrefix.length));
  } catch {
    sendJson(res, 400, { error: "Invalid product handle." });
    return true;
  }

  if (!/^[a-zA-Z0-9-]+$/.test(handle)) {
    sendJson(res, 400, { error: "Invalid product handle." });
    return true;
  }

  try {
    const product = await getProductByHandle(source, handle);

    if (!product) {
      sendJson(res, 404, {
        error: "Product not found in the publicly exposed catalog."
      });
      return true;
    }

    sendJson(res, 200, product);
  } catch (error) {
    sendJson(res, 502, {
      error: errorMessage(error, "Product lookup failed.")
    });
  }

  return true;
}

async function serveMcp(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
    sendMethodNotAllowed(res, "POST, GET, DELETE");
    return;
  }

  if (config.authToken && !tokenMatches(req.headers.authorization, config.authToken)) {
    sendJson(
      res,
      401,
      { error: "Unauthorized." },
      { "WWW-Authenticate": 'Bearer realm="shopify-product-mcp"' }
    );
    return;
  }

  if (!validateOrigin(req, res)) {
    return;
  }

  await handleMcpRequest(req, res);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!validateHost(req, res)) {
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`
  );

  if (url.pathname === "/healthz") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return;
    }

    sendJson(res, 200, {
      ok: true,
      defaultStore: config.defaultStoreUrl,
      uptime: Math.round(process.uptime())
    });
    return;
  }

  if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
    await serveMcp(req, res);
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    if (await serveApi(req, res, url)) {
      return;
    }

    sendJson(res, 404, { error: "Not found." });
    return;
  }

  await serveStatic(req, res);
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error: unknown) => {
    console.error("[shopify-product-mcp] Unhandled request error:", error);

    if (!res.headersSent) {
      sendJson(res, 500, { error: "Internal server error." });
      return;
    }

    res.end();
  });
});

server.on("error", (error) => {
  console.error("[shopify-product-mcp] Server error:", error);
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  console.log(
    `[shopify-product-mcp] web app listening on http://${config.host}:${config.port}`
  );
  console.log(
    `[shopify-product-mcp] MCP endpoint: http://${config.host}:${config.port}/mcp`
  );
  console.log(
    config.defaultStoreUrl
      ? `[shopify-product-mcp] default store: ${config.defaultStoreUrl}`
      : "[shopify-product-mcp] no default store; choose one in the web UI"
  );
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`[shopify-product-mcp] ${signal} received, shutting down`);

  await mcpHandler.close().catch((error: unknown) => {
    console.error("[shopify-product-mcp] MCP shutdown error:", error);
  });

  server.close(() => process.exit(0));
  server.closeIdleConnections();

  setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
