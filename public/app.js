const storeForm = document.querySelector("#store-form");
const storeInput = document.querySelector("#store-input");
const searchForm = document.querySelector("#search-form");
const searchInput = document.querySelector("#search-input");
const collectionSelect = document.querySelector("#collection-select");
const collectionFilter = document.querySelector("#collection-filter");
const filters = document.querySelector("#filters");
const statusEl = document.querySelector("#status");
const resultsEl = document.querySelector("#results");
const emptyEl = document.querySelector("#empty");
const welcomeEl = document.querySelector("#welcome");
const mcpEndpoint = document.querySelector("#mcp-endpoint");
const submitButton = searchForm.querySelector("button");

const PAGE_SIZE = 24;
const MAX_VARIANTS = 4;
const SEARCH_DEBOUNCE_MS = 350;
const STORAGE_KEY = "shopify-catalog-store";

const state = {
  store: "",
  query: "",
  collection: ""
};

let allCollections = [];
let searchSequence = 0;
let activeController = null;
let debounceTimer = null;

mcpEndpoint.textContent = `${location.origin}/mcp`;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function element(tag, className, text) {
  const node = document.createElement(tag);

  if (className) {
    node.className = className;
  }

  if (text !== undefined) {
    node.textContent = text;
  }

  return node;
}

function normalizeStore(value) {
  return value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/+$/, "");
}

function readSavedStore() {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveStore(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Storage may be unavailable in private browsing; the URL still works.
  }
}

function collectionTitle(handle) {
  return allCollections.find((collection) => collection.handle === handle)?.title ??
    handle;
}

function collectionLabel(collection) {
  return collection.productsCount === null
    ? collection.title
    : `${collection.title} (${collection.productsCount})`;
}

function setCatalogVisible(visible) {
  welcomeEl.hidden = visible;
  searchForm.hidden = !visible;

  if (!visible) {
    filters.hidden = true;
    resultsEl.replaceChildren();
    emptyEl.hidden = true;
    setStatus("");
  }
}

function renderVariant(variant) {
  const row = element("li", "variant");

  const name = element(
    "span",
    "variant-name",
    variant.title === "Default Title" ? "Standard" : variant.title
  );
  const price = element("span", "variant-price", variant.price || "—");
  const availability = element(
    "span",
    variant.available ? "badge in-stock" : "badge out-of-stock",
    variant.available ? "In stock" : "Sold out"
  );

  row.append(name, price, availability);
  return row;
}

function renderProduct(product) {
  const card = element("article", "card");

  const media = element("div", "card-media");

  if (product.imageUrl) {
    const image = document.createElement("img");
    image.src = product.imageUrl;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    media.append(image);
  } else {
    media.append(
      element("span", "card-placeholder", product.title.slice(0, 1).toUpperCase())
    );
  }

  const body = element("div", "card-body");
  const meta = [product.vendor, product.productType].filter(Boolean).join(" · ");

  if (meta) {
    body.append(element("p", "card-meta", meta));
  }

  const heading = element("h2", "card-title");
  const link = document.createElement("a");
  link.href = product.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = product.title;
  heading.append(link);
  body.append(heading);

  if (product.description) {
    body.append(element("p", "card-description", product.description.slice(0, 160)));
  }

  const variants = element("ul", "variants");
  const visible = product.variants.slice(0, MAX_VARIANTS);
  variants.append(...visible.map(renderVariant));

  if (product.variants.length > MAX_VARIANTS) {
    variants.append(
      element(
        "li",
        "variant-more",
        `+${product.variants.length - MAX_VARIANTS} more variant(s)`
      )
    );
  }

  body.append(variants);
  card.append(media, body);

  return card;
}

function renderProducts(products) {
  resultsEl.replaceChildren(...products.map(renderProduct));

  if (products.length === 0) {
    emptyEl.textContent = state.query
      ? "No products matched that search."
      : "No products found for this store.";
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
  }
}

function renderCollections(items) {
  allCollections = items.filter(
    (collection) =>
      collection.productsCount === null || collection.productsCount > 0
  );
  collectionFilter.value = "";
  collectionFilter.hidden = allCollections.length <= 25;
  renderCollectionOptions("");
  filters.hidden = allCollections.length === 0;
}

function renderCollectionOptions(rawFilter) {
  const filter = rawFilter.trim().toLowerCase();
  const matches = filter
    ? allCollections.filter((collection) =>
      `${collection.title} ${collection.handle}`.toLowerCase().includes(filter)
    )
    : allCollections;
  const selected = state.collection
    ? allCollections.find((collection) => collection.handle === state.collection)
    : null;

  collectionSelect.replaceChildren(new Option("All products", ""));

  if (selected && !matches.some((collection) => collection.handle === selected.handle)) {
    collectionSelect.append(
      new Option(collectionLabel(selected), selected.handle)
    );
  }

  for (const collection of matches) {
    collectionSelect.append(
      new Option(collectionLabel(collection), collection.handle)
    );
  }

  if (selected) {
    collectionSelect.value = selected.handle;
  } else {
    state.collection = "";
    collectionSelect.value = "";
  }
}

function syncUrl() {
  const url = new URL(location.href);

  if (state.store) {
    url.searchParams.set("store", state.store);
  } else {
    url.searchParams.delete("store");
  }

  if (state.collection) {
    url.searchParams.set("collection", state.collection);
  } else {
    url.searchParams.delete("collection");
  }

  if (state.query) {
    url.searchParams.set("q", state.query);
  } else {
    url.searchParams.delete("q");
  }

  history.replaceState(null, "", url);
}

async function loadStore(store, options = {}) {
  state.store = normalizeStore(store);
  state.query = options.query ?? "";
  state.collection = options.collection ?? "";

  storeInput.value = state.store;
  searchInput.value = state.query;
  allCollections = [];
  collectionSelect.replaceChildren(new Option("All products", ""));
  collectionFilter.value = "";
  collectionFilter.hidden = true;
  filters.hidden = true;
  setCatalogVisible(true);
  setStatus("Loading collections…");
  resultsEl.replaceChildren();
  emptyEl.hidden = true;
  resultsEl.classList.add("loading");
  collectionSelect.disabled = true;

  const sequence = ++searchSequence;
  activeController?.abort();
  activeController = new AbortController();

  try {
    const params = new URLSearchParams({ store: state.store });
    const response = await fetch(`/api/collections?${params.toString()}`, {
      signal: activeController.signal,
      headers: { Accept: "application/json" }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
    }

    if (sequence !== searchSequence) {
      return;
    }

    state.store = new URL(data.store).hostname;
    storeInput.value = state.store;
    saveStore(state.store);
    renderCollections(Array.isArray(data.collections) ? data.collections : []);
  } catch (error) {
    if (error.name === "AbortError" || sequence !== searchSequence) {
      return;
    }

    setStatus(
      error instanceof Error ? error.message : "Unable to load the store.",
      true
    );
  } finally {
    if (sequence === searchSequence) {
      collectionSelect.disabled = allCollections.length === 0;
    }
  }

  if (sequence !== searchSequence) {
    return;
  }

  await search(state.query);
}

async function search(rawQuery) {
  if (!state.store) {
    setCatalogVisible(false);
    return;
  }

  const query = rawQuery.trim();
  state.query = query;

  const sequence = ++searchSequence;
  activeController?.abort();
  activeController = new AbortController();

  submitButton.disabled = true;
  resultsEl.classList.add("loading");
  setStatus("Searching…");

  const params = new URLSearchParams({
    store: state.store,
    limit: String(PAGE_SIZE)
  });

  if (query) {
    params.set("q", query);
  }

  if (state.collection) {
    params.set("collection", state.collection);
  }

  try {
    const response = await fetch(`/api/products?${params.toString()}`, {
      signal: activeController.signal,
      headers: { Accept: "application/json" }
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
    }

    if (sequence !== searchSequence) {
      return;
    }

    state.store = new URL(data.store).hostname;
    storeInput.value = state.store;
    saveStore(state.store);

    const products = Array.isArray(data.products) ? data.products : [];
    renderProducts(products);

    const parts = [
      `${products.length} ${products.length === 1 ? "product" : "products"}`
    ];

    if (state.collection) {
      parts.push(`in ${collectionTitle(state.collection)}`);
    }

    if (query) {
      parts.push(`matching “${query}”`);
    }

    setStatus(parts.join(" "));
    syncUrl();
  } catch (error) {
    if (error.name === "AbortError" || sequence !== searchSequence) {
      return;
    }

    renderProducts([]);
    setStatus(
      error instanceof Error ? error.message : "Search failed.",
      true
    );
  } finally {
    if (sequence === searchSequence) {
      resultsEl.classList.remove("loading");
      submitButton.disabled = false;
    }
  }
}

storeForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const store = normalizeStore(storeInput.value);

  if (!store) {
    setStatus("Enter a store domain to begin.", true);
    storeInput.focus();
    return;
  }

  searchInput.value = "";
  void loadStore(store);
});

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  clearTimeout(debounceTimer);
  void search(searchInput.value);
});

searchInput.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void search(searchInput.value);
  }, SEARCH_DEBOUNCE_MS);
});

collectionSelect.addEventListener("change", () => {
  state.collection = collectionSelect.value;
  void search(state.query);
});

collectionFilter.addEventListener("input", () => {
  renderCollectionOptions(collectionFilter.value);
});

for (const button of document.querySelectorAll("[data-store]")) {
  button.addEventListener("click", () => {
    storeInput.value = button.dataset.store ?? "";
    storeForm.requestSubmit();
  });
}

const urlParams = new URLSearchParams(location.search);
const initialQuery = urlParams.get("q") ?? "";
const initialCollection = urlParams.get("collection") ?? "";
const initialStoreFromUrl = normalizeStore(urlParams.get("store") ?? "");
const initialStore = initialStoreFromUrl || readSavedStore();

async function fetchDefaultStore() {
  try {
    const response = await fetch("/healthz", {
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      return "";
    }

    const data = await response.json();

    return data.defaultStore
      ? new URL(data.defaultStore).hostname
      : "";
  } catch {
    return "";
  }
}

async function bootstrap() {
  setCatalogVisible(false);

  const store = initialStore || await fetchDefaultStore();

  if (!store || state.store) {
    return;
  }

  storeInput.value = store;
  void loadStore(store, {
    query: initialQuery,
    collection: initialCollection
  });
}

void bootstrap();
