import "dotenv/config";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createProductServer } from "./mcp.js";
import { loadConfig } from "./shopify.js";

const config = loadConfig();

console.error(
  config.defaultStoreUrl
    ? `[shopify-product-mcp] default store ${config.defaultStoreUrl} over stdio`
    : "[shopify-product-mcp] stdio ready; pass `store` to each tool or set STORE_DOMAIN"
);

serveStdio(() => createProductServer(config));
