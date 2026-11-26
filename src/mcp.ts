import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  getProductByHandle,
  getStoreOverview,
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
        "Search and filter products in a store's public catalog. " +
        "Supports collection filtering, price bounds, in-stock filtering, vendor, and sorting.",
      inputSchema: {
        query: z.string().max(120).default("").describe("Search keyword or product name."),
        limit: z.number().int().min(1).max(50).default(10),
        collection: collectionSchema.optional(),
        min_price: z.number().min(0).optional().describe("Minimum variant price filter."),
        max_price: z.number().min(0).optional().describe("Maximum variant price filter."),
        in_stock_only: z.boolean().optional().describe("Only return products with at least one variant in stock."),
        vendor: z.string().max(100).optional().describe("Filter by vendor or brand name."),
        product_type: z.string().max(100).optional().describe("Filter by product category or type."),
        sort_by: z
          .enum(["relevance", "price_asc", "price_desc", "title_asc", "title_desc"])
          .default("relevance")
          .describe("Sort order for results."),
        store: storeSchema
      }
    },
    async ({
      query,
      limit,
      collection,
      min_price,
      max_price,
      in_stock_only,
      vendor,
      product_type,
      sort_by,
      store
    }) => {
      try {
        const source = resolveSource(config, store);
        const matches = await searchCatalog(
          source,
          query,
          limit,
          {
            collection: collection ?? null,
            minPrice: min_price ?? null,
            maxPrice: max_price ?? null,
            inStockOnly: in_stock_only ?? null,
            vendor: vendor ?? null,
            productType: product_type ?? null,
            sortBy: sort_by
          }
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

  server.registerTool(
    "compare_products",
    {
      description:
        "Compare multiple products (between 2 and 5) by their handles side-by-side " +
        "to inspect prices, available variants, and specs.",
      inputSchema: {
        handles: z
          .array(z.string().min(1).max(200).regex(/^[a-zA-Z0-9-]+$/))
          .min(2)
          .max(5)
          .describe("Array of product handles to compare (2 to 5 handles)."),
        store: storeSchema
      }
    },
    async ({ handles, store }) => {
      try {
        const source = resolveSource(config, store);
        const items = await Promise.all(
          handles.map(async (handle) => {
            const product = await getProductByHandle(source, handle);
            return {
              handle,
              found: Boolean(product),
              product: product ?? null
            };
          })
        );

        return textResult({
          store: source.baseUrl,
          total: handles.length,
          compared: items
        });
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Product comparison failed."
        );
      }
    }
  );

  server.registerTool(
    "get_store_overview",
    {
      description:
        "Get a high-level summary of a Shopify store: total public product count, " +
        "number of collections, active brand vendors, product categories, and price ranges.",
      inputSchema: {
        store: storeSchema
      }
    },
    async ({ store }) => {
      try {
        const source = resolveSource(config, store);
        const overview = await getStoreOverview(source);

        return textResult(overview);
      } catch (error) {
        return errorResult(
          error instanceof Error
            ? error.message
            : "Store overview failed."
        );
      }
    }
  );

  return server;
}
