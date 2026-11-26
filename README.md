# shopify-product-mcp

MCP server and browser UI for public Shopify product catalogs.

The web app lets visitors type any store domain, then browse and search that
store's public products and filter them by collection. The MCP endpoint exposes
the same catalog capabilities to AI clients.

Data comes from the store's public `/products.json`, `/collections.json`, and
`/collections/{handle}/products.json` endpoints. Catalogs are paginated (up to
5,000 products and 2,500 collections) and cached for 60 seconds.

## Quick start

```bash
npm install
npm run dev:web
```

Open <http://localhost:3000> and enter a store domain such as
`allbirds.com`. No environment file is required for the web app.

The store must permit its public catalog endpoints. If they return `404` or
`403`, this app cannot read that store.

To set a default store, or to run the stdio server, copy `.env.example` to
`.env` and set `STORE_DOMAIN`.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev:web` | Run the web app with watch mode (`src/web.ts`) |
| `npm run dev` | Run the MCP server over stdio (`src/stdio.ts`) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled web app |
| `npm run start:stdio` | Run the compiled stdio MCP server |
| `npm test` | Run unit tests |

## Web app

- **Store picker**: enter a domain (`allbirds.com`, `your-store.myshopify.com`,
  or a custom domain). The last used store is remembered in `localStorage` and
  reflected in the URL. If no store is in the URL or stored locally, the UI
  falls back to `STORE_DOMAIN` when it is configured.
- **Search**: matches product title, description text, and product type.
- **Collection filter**: lists the store's public collections with product
  counts and restricts search and browsing to the selected collection.
- **Product links**: every result links back to the store's product page.

Shareable URLs look like:

```
/?store=allbirds.com&collection=shoes&q=runner
```

## API routes

| Route | Description |
| --- | --- |
| `GET /` | Browser UI |
| `GET /api/overview?store=` | Store catalog statistics, vendors, product types, and price range |
| `GET /api/collections?store=` | Collections with handles and product counts |
| `GET /api/products?store=&q=&limit=&collection=&min_price=&max_price=&in_stock=&vendor=&type=&sort=` | Search/browse products with filters and sorting (`limit` 1–50) |
| `GET /api/products/:handle?store=` | Product by handle |
| `POST/GET/DELETE /mcp` | MCP Streamable HTTP endpoint |
| `GET /healthz` | Health check |

`store` is required unless `STORE_DOMAIN` is configured as a fallback.

## MCP tools

| Tool | Arguments |
| --- | --- |
| `search_products` | `query`, `limit` (1–50), optional `collection`, optional `min_price`, optional `max_price`, optional `in_stock_only`, optional `vendor`, optional `product_type`, optional `sort_by` (`relevance`, `price_asc`, `price_desc`, `title_asc`, `title_desc`), optional `store` |
| `get_product` | `handle`, optional `store` |
| `compare_products` | `handles` (2–5 product handles), optional `store` |
| `get_store_overview` | optional `store` |
| `list_collections` | optional `query`, `limit` (1–500), optional `store` |
| `list_collection_products` | `collection`, `limit` (1–50), optional `store` |

Example: search and filter within one collection:

```json
{
  "name": "search_products",
  "arguments": {
    "store": "allbirds.com",
    "collection": "shoes",
    "query": "runner",
    "min_price": 50,
    "max_price": 150,
    "in_stock_only": true,
    "sort_by": "price_asc",
    "limit": 5
  }
}
```

Example: compare products side-by-side:

```json
{
  "name": "compare_products",
  "arguments": {
    "store": "allbirds.com",
    "handles": ["mens-tree-runners", "mens-wool-runners"]
  }
}
```

If `STORE_DOMAIN` is set, the `store` argument can be omitted.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `STORE_DOMAIN` | unset | Optional default store domain |
| `HOST` | `127.0.0.1` | Bind address |
| `PORT` | `3000` | HTTP port |
| `ALLOWED_STORE_HOSTS` | unset (any public host) | Comma-separated store hostnames the server may fetch; supports `*.example.com` |
| `ALLOWED_HOSTS` | localhost only | Comma-separated Host hostnames (no scheme/port) |
| `ALLOWED_ORIGINS` | localhost only | Comma-separated Origin hostnames (no scheme/port) |
| `MCP_AUTH_TOKEN` | unset | Optional bearer token required on `/mcp` |

Store input is restricted to public HTTPS hostnames. IP addresses, localhost,
and reserved hostnames are always rejected. For internet-facing deployments,
set `ALLOWED_STORE_HOSTS` to the exact stores you intend to serve.

## Connecting MCP clients

Point a Streamable HTTP client at `http://localhost:3000/mcp`:

```json
{
  "mcpServers": {
    "shopify-products": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

If `MCP_AUTH_TOKEN` is set, add
`"headers": { "Authorization": "Bearer <token>" }`.

You can also test the endpoint with the
[MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector
# choose Streamable HTTP and connect to http://localhost:3000/mcp
```

For stdio clients, use `npm run start:stdio` (after `npm run build`) with
`STORE_DOMAIN` in the environment:

```json
{
  "mcpServers": {
    "shopify-products": {
      "command": "npm",
      "args": ["run", "start:stdio"],
      "cwd": "/absolute/path/to/shopify-product-mcp",
      "env": { "STORE_DOMAIN": "your-store.myshopify.com" }
    }
  }
}
```

## Docker

A production image and Compose file are included:

```bash
cp .env.example .env
# Set PUBLIC_HOST to the public IP or domain users will visit.
# Add MCP_AUTH_TOKEN and ALLOWED_STORE_HOSTS for internet-facing use.
docker compose up -d --build
```

`PUBLIC_HOST` must be a hostname or IP only, without `http://` or a port.
`docker-compose.yml` derives `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` from it.
The app listens on port 3000 inside the container and is published on
`${PUBLIC_PORT:-3000}`.

For a complete Oracle Cloud VM walkthrough, including OCI security lists and
the VM firewall, see [`deploy/oracle-cloud.md`](deploy/oracle-cloud.md).

## Deployment notes

- Set `HOST=0.0.0.0` when running in a container or behind a reverse proxy.
  The Compose file already does this.
- Set `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` to the public hostname. Without
  them, only localhost Host/Origin headers are accepted.
- Set `ALLOWED_STORE_HOSTS` to restrict which stores can be queried.
- Consider setting `MCP_AUTH_TOKEN` if the endpoint is reachable from the
  internet.
- Prices are reported as returned by the store. The public endpoints do not
  include a currency code, so the UI and tools do not claim one.
