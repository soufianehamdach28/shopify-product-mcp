import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  getProductByHandle,
  listCollections,
  resolveStoreSource,
  searchCatalog,
  type AppConfig,
  type CatalogSource
} from "./shopify.js";

const storeSchema = z.string()
  .trim()
  .min(1)
  .max(300)
  .optional()
  .describe(
    "Store domain, for example \"allbirds.com\". " +
    "Defaults to the server's STORE_DOMAIN when configured."
  );

const collectionSchema = z.string()
  .trim()
  .min(1)
  .max(255)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "Use the collection handle, for example \"shoes\"."
  )
  .describe("Collection handle from list_collections.");

function textResult(value: unknown) {
  return {
    content: [{
      type: "text" as const,
      text: typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2)
    }]
  };
}

function errorResult(message: string) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: message
    }]
  };
}

function resolveSource(
  config: AppConfig,
  store: string | undefined
): CatalogSource {
  return resolveStoreSource(store, {
    fallback: config.defaultStoreUrl,
    allowedStoreHosts: config.allowedStoreHosts
  });
}

export function createProductServer(config: AppConfig): McpServer {
  const server = new McpServer({
    name: "public-shopify-products",
    version: "1.1.0"
  });

  server.registerTool(
    "search_products",
    {
      description:
        "Search products in a store's public catalog. " +
        "Optionally restrict results to one collection.",
      inputSchema: {
        query: z.string().min(1).max(120),
        limit: z.number().int().min(1).max(20).default(10),
        collection: collectionSchema.optional(),
        store: storeSchema
      }
    },
    async ({ query, limit, collection, store }) => {
      try {
        const source = resolveSource(config, store);
        const matches = await searchCatalog(
          source,
          query,
          limit,
          collection ?? null
        );

        return textResult({
          store: source.baseUrl,
          collection: collection ?? null,
          count: matches.length,
          products: matches
        });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Product search failed."
        );
      }
    }
  );

  server.registerTool(
    "list_collections",
    {
      description:
        "List a store's public collections with their handles and product counts. " +
        "Use the optional query to filter by title or handle.",
      inputSchema: {
        query: z.string()
          .trim()
          .max(120)
          .optional()
          .describe("Optional text filter for collection titles or handles."),
        limit: z.number().int().min(1).max(500).default(100),
        store: storeSchema
      }
    },
    async ({ query, limit, store }) => {
      try {
        const source = resolveSource(config, store);
        const allCollections = await listCollections(source);
        const normalizedQuery = query?.trim().toLowerCase() ?? "";
        const matches = normalizedQuery
          ? allCollections.filter((collection) =>
            `${collection.title} ${collection.handle}`
              .toLowerCase()
              .includes(normalizedQuery)
          )
          : allCollections;
        const collections = matches.slice(0, limit);

        return textResult({
          store: source.baseUrl,
          total: allCollections.length,
          matching: matches.length,
          count: collections.length,
          collections
        });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Collection listing failed."
        );
      }
    }
  );

  server.registerTool(
    "list_collection_products",
    {
      description:
        "List all products in one collection, up to the requested limit.",
      inputSchema: {
        collection: collectionSchema,
        limit: z.number().int().min(1).max(50).default(20),
        store: storeSchema
      }
    },
    async ({ collection, limit, store }) => {
      try {
        const source = resolveSource(config, store);
        const products = await searchCatalog(
          source,
          "",
          limit,
          collection
        );

        return textResult({
          store: source.baseUrl,
          collection,
          count: products.length,
          products
        });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Collection product listing failed."
        );
      }
    }
  );

  server.registerTool(
    "get_product",
    {
      description:
        "Get a public product's details and variant prices using its handle.",
      inputSchema: {
        handle: z.string()
          .min(1)
          .max(200)
          .regex(/^[a-zA-Z0-9-]+$/),
        store: storeSchema
      }
    },
    async ({ handle, store }) => {
      try {
        const source = resolveSource(config, store);
        const product = await getProductByHandle(source, handle);

        if (!product) {
          return textResult(
            "Product not found in the publicly exposed catalog."
          );
        }

        return textResult(product);
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Product lookup failed."
        );
      }
    }
  );

  return server;
}
