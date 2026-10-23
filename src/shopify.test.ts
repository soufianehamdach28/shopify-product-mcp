import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cleanHtml,
  formatCollection,
  formatProduct,
  getCollectionProducts,
  getCollections,
  getProducts,
  listCollections,
  matchesQuery,
  normalizeStoreInput,
  resolveStoreSource,
  StoreInputError,
  type ShopifyCollection,
  type ShopifyProduct
} from "./shopify.js";

function makeProduct(
  overrides: Partial<ShopifyProduct> = {}
): ShopifyProduct {
  return {
    id: 1,
    title: "Red Shoe",
    handle: "red-shoe",
    body_html: "<p>A red shoe.</p>",
    product_type: "Shoes",
    vendor: "Acme",
    images: [{ src: "https://cdn.example.com/red-shoe.jpg", alt: "Red shoe" }],
    variants: [
      {
        id: 10,
        title: "Default Title",
        price: "49.00",
        available: true,
        sku: "RS-1"
      }
    ],
    ...overrides
  };
}

test("cleanHtml strips tags, decodes entities, and collapses whitespace", () => {
  assert.equal(
    cleanHtml("<p>Hello &amp; <strong>world</strong></p>"),
    "Hello & world"
  );
  assert.equal(cleanHtml("  a\n\t b  "), "a b");
});

test("cleanHtml truncates long descriptions to 1500 characters", () => {
  assert.equal(cleanHtml("a".repeat(2000)).length, 1500);
});

test("matchesQuery finds title, description, and product type matches", () => {
  const product = makeProduct();

  assert.equal(matchesQuery(product, "red"), true);
  assert.equal(matchesQuery(product, "a red shoe"), true);
  assert.equal(matchesQuery(product, "shoes"), true);
});

test("matchesQuery rejects products that do not match the query", () => {
  const product = makeProduct();

  assert.equal(matchesQuery(product, "zzz"), false);
  assert.equal(matchesQuery(product, "blue"), false);
});

test("matchesQuery ignores HTML tag names in descriptions", () => {
  const product = makeProduct({
    body_html: "<div><span>Leather upper</span></div>"
  });

  assert.equal(matchesQuery(product, "leather"), true);
  assert.equal(matchesQuery(product, "span"), false);
});

test("formatProduct maps fields and resolves the absolute product URL", () => {
  const formatted = formatProduct(
    { baseUrl: "https://shop.example.com" },
    makeProduct()
  );

  assert.equal(formatted.title, "Red Shoe");
  assert.equal(formatted.url, "https://shop.example.com/products/red-shoe");
  assert.equal(formatted.description, "A red shoe.");
  assert.equal(formatted.productType, "Shoes");
  assert.equal(formatted.vendor, "Acme");
  assert.equal(
    formatted.imageUrl,
    "https://cdn.example.com/red-shoe.jpg"
  );
  assert.deepEqual(formatted.variants, [
    {
      id: 10,
      title: "Default Title",
      sku: "RS-1",
      price: "49.00",
      currency: null,
      available: true
    }
  ]);
  assert.match(formatted.note, /Currency may be unavailable/);
});

test("formatProduct nulls out missing optional catalog fields", () => {
  const formatted = formatProduct(
    { baseUrl: "https://shop.example.com" },
    makeProduct({
      body_html: null,
      product_type: undefined,
      vendor: undefined,
      images: undefined,
      variants: [
        {
          id: 11,
          title: "Small",
          price: "10.00",
          available: false
        }
      ]
    })
  );

  assert.equal(formatted.description, "");
  assert.equal(formatted.productType, null);
  assert.equal(formatted.vendor, null);
  assert.equal(formatted.imageUrl, null);
  assert.equal(formatted.variants[0].sku, null);
  assert.equal(formatted.variants[0].available, false);
});

test("getProducts paginates and caches the catalog", async () => {
  const originalFetch = globalThis.fetch;
  const baseUrl = `https://pagination-test-${Date.now()}.example.com`;
  const requestedPages: number[] = [];

  const firstPage = Array.from({ length: 250 }, (_, index) =>
    makeProduct({
      id: index + 1,
      handle: `product-${index + 1}`,
      title: `Product ${index + 1}`
    })
  );
  const secondPage = [
    makeProduct({ id: 251, handle: "product-251", title: "Product 251" })
  ];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url
    );
    const page = Number(url.searchParams.get("page") ?? "1");

    requestedPages.push(page);

    const products = page === 1 ? firstPage : page === 2 ? secondPage : [];

    return new Response(JSON.stringify({ products }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const products = await getProducts({ baseUrl });
    assert.equal(products.length, 251);
    assert.deepEqual(requestedPages, [1, 2]);

    const cached = await getProducts({ baseUrl });
    assert.equal(cached.length, 251);
    assert.deepEqual(requestedPages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normalizeStoreInput accepts bare, https, and trailing-dot domains", () => {
  assert.equal(
    normalizeStoreInput("allbirds.com").baseUrl,
    "https://allbirds.com"
  );
  assert.equal(
    normalizeStoreInput("  https://www.allbirds.com/  ").baseUrl,
    "https://www.allbirds.com"
  );
  assert.equal(
    normalizeStoreInput("https://allbirds.com.").baseUrl,
    "https://allbirds.com"
  );
});

test("normalizeStoreInput rejects unsafe or non-origin inputs", () => {
  const invalid = [
    "http://allbirds.com",
    "https://user:pass@allbirds.com",
    "https://allbirds.com:8443",
    "https://allbirds.com/path",
    "https://allbirds.com?x=1",
    "localhost",
    "127.0.0.1",
    "https://[::1]",
    "intranet",
    "foo.local",
    "https://foo.internal",
    "https://foo.test"
  ];

  for (const value of invalid) {
    assert.throws(
      () => normalizeStoreInput(value),
      StoreInputError,
      value
    );
  }
});

test("resolveStoreSource uses the fallback and enforces allowed hosts", () => {
  assert.equal(
    resolveStoreSource(undefined, { fallback: "allbirds.com" }).baseUrl,
    "https://allbirds.com"
  );
  assert.equal(
    resolveStoreSource("www.allbirds.com", {
      allowedStoreHosts: ["allbirds.com"]
    }).baseUrl,
    "https://www.allbirds.com"
  );
  assert.equal(
    resolveStoreSource("shop.allbirds.com", {
      allowedStoreHosts: ["*.allbirds.com"]
    }).baseUrl,
    "https://shop.allbirds.com"
  );

  assert.throws(
    () => resolveStoreSource("evil.example.net", {
      allowedStoreHosts: ["allbirds.com"]
    }),
    StoreInputError
  );

  assert.throws(
    () => resolveStoreSource(undefined),
    /Store domain required/
  );
});

test("formatCollection maps collection metadata", () => {
  const collection: ShopifyCollection = {
    id: 5,
    title: "Shoes",
    handle: "shoes",
    description: "<p>All shoes.</p>",
    products_count: 42,
    image: { src: "https://cdn.example.com/shoes.jpg" }
  };

  const formatted = formatCollection(
    { baseUrl: "https://shop.example.com" },
    collection
  );

  assert.equal(formatted.url, "https://shop.example.com/collections/shoes");
  assert.equal(formatted.description, "All shoes.");
  assert.equal(formatted.productsCount, 42);
  assert.equal(formatted.imageUrl, "https://cdn.example.com/shoes.jpg");
});

test("getCollections paginates and listCollections formats and sorts", async () => {
  const originalFetch = globalThis.fetch;
  const baseUrl = `https://collections-test-${Date.now()}.example.com`;
  const requestedPages: number[] = [];

  const firstPage = Array.from({ length: 250 }, (_, index) => ({
    id: index + 1,
    title: `Collection ${String(index + 1).padStart(3, "0")}`,
    handle: `collection-${index + 1}`,
    products_count: index
  }));
  const secondPage = [
    {
      id: 251,
      title: "Zebra Collection",
      handle: "zebra",
      products_count: 3
    }
  ];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url
    );
    const page = Number(url.searchParams.get("page") ?? "1");
    requestedPages.push(page);

    const collections = page === 1 ? firstPage : page === 2 ? secondPage : [];

    return new Response(JSON.stringify({ collections }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }) as typeof fetch;

  try {
    const collections = await getCollections({ baseUrl });
    assert.equal(collections.length, 251);

    const formatted = await listCollections({ baseUrl });
    assert.equal(formatted.length, 251);
    assert.equal(formatted.at(-1)?.title, "Zebra Collection");
    assert.deepEqual(requestedPages, [1, 2]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getCollectionProducts scopes requests to one collection and caches", async () => {
  const originalFetch = globalThis.fetch;
  const baseUrl = `https://collection-products-${Date.now()}.example.com`;
  const requestedUrls: string[] = [];

  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input
          : input.url
    );
    requestedUrls.push(url.toString());

    return new Response(
      JSON.stringify({ products: [makeProduct()] }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }
    );
  }) as typeof fetch;

  try {
    const products = await getCollectionProducts({ baseUrl }, "shoes");
    assert.equal(products.length, 1);
    assert.match(
      requestedUrls[0],
      /\/collections\/shoes\/products\.json\?limit=250&page=1$/
    );

    await getCollectionProducts({ baseUrl }, "shoes");
    assert.equal(requestedUrls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
