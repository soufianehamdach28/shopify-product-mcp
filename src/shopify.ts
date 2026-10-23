import { isIP } from "node:net";

export type ShopifyVariant = {
  id: number;
  title: string;
  price: string;
  available: boolean;
  sku?: string | null;
};

export type ShopifyImage = {
  src?: string | null;
  alt?: string | null;
};

export type ShopifyProduct = {
  id: number;
  title: string;
  handle: string;
  body_html?: string | null;
  product_type?: string;
  vendor?: string;
  images?: ShopifyImage[];
  variants: ShopifyVariant[];
};

export type ShopifyCollection = {
  id: number;
  title: string;
  handle: string;
  description?: string;
  products_count?: number;
  image?: ShopifyImage | null;
};

type ProductResponse = {
  products: ShopifyProduct[];
};

type CollectionsResponse = {
  collections: ShopifyCollection[];
};

export type CatalogSource = {
  baseUrl: string;
  allowedStoreHosts?: string[] | null;
};

export type AppConfig = {
  defaultStoreUrl: string | null;
  port: number;
  host: string;
  allowedHosts: string[] | null;
  allowedOrigins: string[] | null;
  allowedStoreHosts: string[] | null;
  authToken: string | null;
};

export type FormattedVariant = {
  id: number;
  title: string;
  sku: string | null;
  price: string;
  currency: null;
  available: boolean;
};

export type FormattedProduct = {
  id: number;
  title: string;
  handle: string;
  url: string;
  description: string;
  productType: string | null;
  vendor: string | null;
  imageUrl: string | null;
  variants: FormattedVariant[];
  note: string;
};

export type FormattedCollection = {
  id: number;
  title: string;
  handle: string;
  url: string;
  description: string;
  productsCount: number | null;
  imageUrl: string | null;
};

export class StoreInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreInputError";
  }
}

const PAGE_SIZE = 250;
const MAX_PRODUCT_PAGES = 20;
const MAX_COLLECTION_PAGES = 10;
const MAX_CACHE_ENTRIES = 100;
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;

const FORBIDDEN_HOST_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".onion",
  ".test",
  ".invalid",
  ".example"
];

const PRODUCT_NOTE =
  "Prices are reported as returned by the public endpoint. " +
  "Currency may be unavailable; verify price and stock on the store.";

type CacheEntry<T> = {
  fetchedAt: number;
  value: T;
};

const productCache = new Map<string, CacheEntry<ShopifyProduct[]>>();
const collectionCache = new Map<string, CacheEntry<ShopifyCollection[]>>();
const collectionProductCache = new Map<
  string,
  CacheEntry<ShopifyProduct[]>
>();
const inFlightRequests = new Map<string, Promise<unknown>>();

export function loadConfig(
  env: Record<string, string | undefined> = process.env
): AppConfig {
  const defaultStoreUrl = env.STORE_DOMAIN?.trim()
    ? normalizeStoreInput(env.STORE_DOMAIN).baseUrl
    : null;

  return {
    defaultStoreUrl,
    port: parsePort(env.PORT),
    host: env.HOST?.trim() || "127.0.0.1",
    allowedHosts: parseList(env.ALLOWED_HOSTS),
    allowedOrigins: parseList(env.ALLOWED_ORIGINS),
    allowedStoreHosts: parseList(env.ALLOWED_STORE_HOSTS),
    authToken: env.MCP_AUTH_TOKEN?.trim() || null
  };
}

function parsePort(value: string | undefined): number {
  if (!value?.trim()) {
    return 3000;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  return port;
}

function parseList(value: string | undefined): string[] | null {
  const entries = value
    ?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  return entries && entries.length > 0 ? entries : null;
}

function assertPublicHostname(hostname: string): void {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (
    host.length === 0 ||
    host.length > 253 ||
    !host.includes(".") ||
    isIP(host) !== 0
  ) {
    throw new StoreInputError(
      "Enter a public store domain (IP addresses and local hosts are not allowed)."
    );
  }

  const labels = host.split(".");

  if (labels.some((label) => label.length === 0 || label.length > 63)) {
    throw new StoreInputError("Enter a valid store domain.");
  }

  if (!/^[a-z0-9.-]+$/.test(host)) {
    throw new StoreInputError("Enter a valid store domain.");
  }

  if (
    FORBIDDEN_HOST_SUFFIXES.some(
      (suffix) => host === suffix.slice(1) || host.endsWith(suffix)
    )
  ) {
    throw new StoreInputError(
      "Enter a public store domain (local and reserved hosts are not allowed)."
    );
  }
}

function assertStoreHostAllowed(
  hostname: string,
  allowedStoreHosts: string[] | null | undefined
): void {
  if (!allowedStoreHosts || allowedStoreHosts.length === 0) {
    return;
  }

  const host = hostname.toLowerCase().replace(/\.$/, "");
  const permitted = allowedStoreHosts.some((entry) => {
    const allowed = entry
      .toLowerCase()
      .replace(/^\*\.?/, "")
      .replace(/\.$/, "");

    return host === allowed || host.endsWith(`.${allowed}`);
  });

  if (!permitted) {
    throw new StoreInputError(
      `Store host "${host}" is not allowed by this server.`
    );
  }
}

/**
 * Normalizes user input like "allbirds.com" or "https://allbirds.com/"
 * into a validated HTTPS origin.
 */
export function normalizeStoreInput(input: string): CatalogSource {
  const value = input.trim();

  if (!value) {
    throw new StoreInputError(
      "Enter a store domain, for example \"your-store.myshopify.com\"."
    );
  }

  if (value.length > 300) {
    throw new StoreInputError("Store domain is too long.");
  }

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;

  let url: URL;

  try {
    url = new URL(candidate);
  } catch {
    throw new StoreInputError(
      "Enter a valid store domain, for example \"your-store.myshopify.com\"."
    );
  }

  if (url.protocol !== "https:") {
    throw new StoreInputError("Store domain must use HTTPS.");
  }

  if (url.username || url.password) {
    throw new StoreInputError("Store domain must not include credentials.");
  }

  if (url.port) {
    throw new StoreInputError("Store domain must not include a port.");
  }

  if (url.pathname !== "/" || url.search || url.hash) {
    throw new StoreInputError(
      "Enter only the store domain, without a path, query, or fragment."
    );
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  assertPublicHostname(hostname);

  return { baseUrl: `https://${hostname}` };
}

/**
 * Resolves a per-call store input (web query param or MCP tool argument),
 * falling back to the STORE_DOMAIN default when configured.
 */
export function resolveStoreSource(
  input: string | null | undefined,
  options: {
    fallback?: string | null;
    allowedStoreHosts?: string[] | null;
  } = {}
): CatalogSource {
  const raw = input?.trim() || options.fallback?.trim() || "";

  if (!raw) {
    throw new StoreInputError(
      "Store domain required. Enter a store domain in the web app, " +
      "pass `store` to the tool, or set STORE_DOMAIN."
    );
  }

  const source = normalizeStoreInput(raw);
  const hostname = new URL(source.baseUrl).hostname;

  assertStoreHostAllowed(hostname, options.allowedStoreHosts);

  return {
    ...source,
    allowedStoreHosts: options.allowedStoreHosts ?? null
  };
}

async function safeFetch(
  url: string | URL,
  allowedStoreHosts: string[] | null | undefined
): Promise<Response> {
  let current = new URL(url.toString());

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== "https:") {
      throw new StoreInputError("Store requests must use HTTPS.");
    }

    assertPublicHostname(current.hostname);
    assertStoreHostAllowed(current.hostname, allowedStoreHosts);

    const response = await fetch(current, {
      redirect: "manual",
      headers: {
        Accept: "application/json",
        "User-Agent": "PublicProductMCP/1.1"
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");

      if (!location) {
        return response;
      }

      current = new URL(location, current);
      continue;
    }

    return response;
  }

  throw new Error("Too many redirects while contacting the store.");
}

async function fetchJson<T>(
  source: CatalogSource,
  url: string
): Promise<T> {
  const response = await safeFetch(url, source.allowedStoreHosts);

  if (!response.ok) {
    throw new Error(
      `Store endpoint unavailable: HTTP ${response.status}. ` +
      "Check whether the store permits its public catalog endpoints."
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error(
      "The store did not return JSON. It may block its public catalog endpoints."
    );
  }
}

function setCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  value: T
): void {
  cache.delete(key);
  cache.set(key, { fetchedAt: Date.now(), value });

  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;

    if (oldest === undefined) {
      break;
    }

    cache.delete(oldest);
  }
}

async function withCache<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  loader: () => Promise<T>
): Promise<T> {
  const cached = cache.get(key);

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const pending = inFlightRequests.get(key) as Promise<T> | undefined;

  if (pending) {
    return pending;
  }

  const request = loader()
    .then((value) => {
      setCache(cache, key, value);
      return value;
    })
    .finally(() => {
      inFlightRequests.delete(key);
    });

  inFlightRequests.set(key, request);

  return request;
}

async function fetchProductsPage(
  source: CatalogSource,
  page: number
): Promise<ShopifyProduct[]> {
  const data = await fetchJson<ProductResponse>(
    source,
    `${source.baseUrl}/products.json?limit=${PAGE_SIZE}&page=${page}`
  );

  if (!data || !Array.isArray(data.products)) {
    throw new Error("Unexpected public catalog response.");
  }

  return data.products;
}

async function fetchCollectionsPage(
  source: CatalogSource,
  page: number
): Promise<ShopifyCollection[]> {
  const data = await fetchJson<CollectionsResponse>(
    source,
    `${source.baseUrl}/collections.json?limit=${PAGE_SIZE}&page=${page}`
  );

  if (!data || !Array.isArray(data.collections)) {
    throw new Error("Unexpected public collections response.");
  }

  return data.collections;
}

async function fetchCollectionProductsPage(
  source: CatalogSource,
  handle: string,
  page: number
): Promise<ShopifyProduct[]> {
  const data = await fetchJson<ProductResponse>(
    source,
    `${source.baseUrl}/collections/${encodeURIComponent(handle)}` +
    `/products.json?limit=${PAGE_SIZE}&page=${page}`
  );

  if (!data || !Array.isArray(data.products)) {
    throw new Error("Unexpected public collection response.");
  }

  return data.products;
}

export async function getProducts(
  source: CatalogSource
): Promise<ShopifyProduct[]> {
  return withCache(
    productCache,
    `products:${source.baseUrl}`,
    async () => {
      const products: ShopifyProduct[] = [];

      for (let page = 1; page <= MAX_PRODUCT_PAGES; page += 1) {
        const batch = await fetchProductsPage(source, page);
        products.push(...batch);

        if (batch.length < PAGE_SIZE) {
          break;
        }
      }

      return products;
    }
  );
}

export async function getCollections(
  source: CatalogSource
): Promise<ShopifyCollection[]> {
  return withCache(
    collectionCache,
    `collections:${source.baseUrl}`,
    async () => {
      const collections: ShopifyCollection[] = [];

      for (let page = 1; page <= MAX_COLLECTION_PAGES; page += 1) {
        const batch = await fetchCollectionsPage(source, page);
        collections.push(...batch);

        if (batch.length < PAGE_SIZE) {
          break;
        }
      }

      return collections;
    }
  );
}

export async function getCollectionProducts(
  source: CatalogSource,
  handle: string
): Promise<ShopifyProduct[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(handle)) {
    throw new StoreInputError("Invalid collection handle.");
  }

  return withCache(
    collectionProductCache,
    `collection:${source.baseUrl}:${handle}`,
    async () => {
      const products: ShopifyProduct[] = [];

      for (let page = 1; page <= MAX_PRODUCT_PAGES; page += 1) {
        const batch = await fetchCollectionProductsPage(source, handle, page);
        products.push(...batch);

        if (batch.length < PAGE_SIZE) {
          break;
        }
      }

      return products;
    }
  );
}

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export function cleanHtml(value = ""): string {
  return stripHtml(value).slice(0, 1500);
}

export function matchesQuery(
  product: ShopifyProduct,
  normalizedQuery: string
): boolean {
  const haystack =
    `${product.title} ${stripHtml(product.body_html ?? "")} ` +
    `${product.product_type ?? ""}`;

  return haystack.toLowerCase().includes(normalizedQuery);
}

export function formatProduct(
  source: CatalogSource,
  product: ShopifyProduct
): FormattedProduct {
  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    url: `${source.baseUrl}/products/${encodeURIComponent(product.handle)}`,
    description: cleanHtml(product.body_html ?? ""),
    productType: product.product_type ?? null,
    vendor: product.vendor ?? null,
    imageUrl: product.images?.[0]?.src ?? null,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku ?? null,
      price: variant.price,
      currency: null,
      available: variant.available
    })),
    note: PRODUCT_NOTE
  };
}

export function formatCollection(
  source: CatalogSource,
  collection: ShopifyCollection
): FormattedCollection {
  return {
    id: collection.id,
    title: collection.title,
    handle: collection.handle,
    url:
      `${source.baseUrl}/collections/` +
      `${encodeURIComponent(collection.handle)}`,
    description: cleanHtml(collection.description ?? "").slice(0, 300),
    productsCount: collection.products_count ?? null,
    imageUrl: collection.image?.src ?? null
  };
}

export async function listCollections(
  source: CatalogSource
): Promise<FormattedCollection[]> {
  const collections = await getCollections(source);

  return collections
    .filter((collection) => collection.handle !== "all")
    .map((collection) => formatCollection(source, collection))
    .sort((left, right) => left.title.localeCompare(right.title));
}

export async function searchCatalog(
  source: CatalogSource,
  query: string,
  limit: number,
  collection?: string | null
): Promise<FormattedProduct[]> {
  const products = collection
    ? await getCollectionProducts(source, collection)
    : await getProducts(source);
  const normalizedQuery = query.trim().toLowerCase();

  return products
    .filter((product) =>
      normalizedQuery === ""
        ? true
        : matchesQuery(product, normalizedQuery)
    )
    .slice(0, limit)
    .map((product) => formatProduct(source, product));
}

export async function getProductByHandle(
  source: CatalogSource,
  handle: string
): Promise<FormattedProduct | null> {
  const products = await getProducts(source);
  const product = products.find(
    (item) => item.handle.toLowerCase() === handle.toLowerCase()
  );

  return product ? formatProduct(source, product) : null;
}
