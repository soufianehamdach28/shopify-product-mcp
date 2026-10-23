# Deploy on an Oracle Cloud VM with Docker

This guide deploys the app to an Oracle Cloud Infrastructure (OCI) Compute VM
and exposes it on a public IP over HTTP.

> **HTTP is for testing.** Traffic is not encrypted, including any MCP bearer
> token. Add a domain and HTTPS reverse proxy before using this for anything
> sensitive. Set `MCP_AUTH_TOKEN` even for testing.

## 1. Create the VM

In the OCI Console:

1. Go to **Compute → Instances → Create instance**.
2. Choose an **Ubuntu 24.04** image.
3. Pick a shape:
   - **Ampere A1 Flex** (Always Free eligible): 1–2 OCPUs and at least 4 GB RAM
     is comfortable for the Docker build.
   - **VM.Standard.E2.1.Micro** (Always Free): 1 GB RAM can run the container,
     but the TypeScript build may run out of memory. Add swap or build the
     image elsewhere if needed.
4. Assign a **public IPv4 address**.
5. Upload or select your SSH key.
6. Create the instance and note its **public IP**.

## 2. Open the port in OCI

Add an ingress rule to the VM's network:

1. Open the instance → **Networking** → the VCN → **Security Lists** →
   **Default Security List** (or the NSG attached to the instance).
2. Add an ingress rule:
   - **Source**: `0.0.0.0/0`
   - **IP Protocol**: TCP
   - **Destination Port Range**: `3000`
   - **Description**: Shopify catalog app

For a more restrictive setup, use your own IP as the source instead of
`0.0.0.0/0`.

If you use an NSG instead of a security list, add the rule there.

## 3. Connect to the VM

```bash
ssh -i ~/.ssh/your-key ubuntu@<PUBLIC_IP>
```

The default user is `ubuntu` on Oracle's Ubuntu images (`opc` on Oracle Linux).

## 4. Install Docker

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu \
$(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y \
  docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker "$USER"
newgrp docker
```

Verify:

```bash
docker --version
docker compose version
```

## 5. Allow the port in the VM firewall

Oracle's Ubuntu images usually have iptables rules that only allow SSH.
Check them:

```bash
sudo iptables -L INPUT -n --line-numbers
```

If there is a `REJECT` rule for new connections, insert an ACCEPT rule above
it:

```bash
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
sudo netfilter-persistent save
```

If `ufw` is active instead:

```bash
sudo ufw allow 3000/tcp
sudo ufw status
```

On Oracle Linux, use `firewalld`:

```bash
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

## 6. Copy the project to the VM

From your local machine:

```bash
cd /home/soufiane/projects/shopify-product-mcp

rsync -av \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude .env \
  ./ ubuntu@<PUBLIC_IP>:~/shopify-product-mcp/
```

Alternatively, push the project to a Git repository and clone it on the VM.

## 7. Create the server `.env`

On the VM:

```bash
cd ~/shopify-product-mcp
cp .env.example .env
nano .env
```

Set at least these values:

```env
# Optional default store
STORE_DOMAIN=coachsoak.com

HOST=0.0.0.0
PORT=3000

# The public IP (or domain) users will visit.
# No http://, no port.
PUBLIC_HOST=<PUBLIC_IP>
PUBLIC_PORT=3000

# Recommended on the public internet: restrict which stores can be queried.
# ALLOWED_STORE_HOSTS=coachsoak.com

# Recommended: require a bearer token on /mcp
MCP_AUTH_TOKEN=<paste-output-of-openssl-rand-hex-32>
```

Generate a token with:

```bash
openssl rand -hex 32
```

`PUBLIC_HOST` is used to build `ALLOWED_HOSTS` and `ALLOWED_ORIGINS` in
`docker-compose.yml`. It must match the host used in the browser exactly
(without the scheme or port).

If you later use a domain, change `PUBLIC_HOST` to that domain.

## 8. Build and start

```bash
cd ~/shopify-product-mcp
docker compose up -d --build
```

Check status and logs:

```bash
docker compose ps
docker compose logs -f --tail=100
```

Wait for the health check to pass, then test locally on the VM:

```bash
curl http://127.0.0.1:3000/healthz
```

Expected response includes:

```json
{
  "ok": true,
  "defaultStore": "https://coachsoak.com"
}
```

Open the app:

```text
http://<PUBLIC_IP>:3000
```

MCP endpoint:

```text
http://<PUBLIC_IP>:3000/mcp
```

If `MCP_AUTH_TOKEN` is set, clients must send:

```http
Authorization: Bearer <your-token>
```

## 9. Update the app

After pulling or uploading new code:

```bash
cd ~/shopify-product-mcp
docker compose up -d --build
docker image prune -f
```

Useful commands:

```bash
docker compose logs -f
docker compose restart
docker compose down
```

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `PUBLIC_HOST is required` | Add `PUBLIC_HOST=<PUBLIC_IP>` to `.env` on the VM. |
| `403 Invalid Host` | `PUBLIC_HOST` must be exactly the IP or domain used in the browser, without `http://` or the port. |
| Connection times out | Open TCP 3000 in the OCI security list/NSG **and** the VM's iptables/ufw/firewalld. |
| `502` from a product API | The store may block `/products.json`, or `ALLOWED_STORE_HOSTS` excludes it. |
| Container unhealthy | Run `docker compose logs --tail=100` and check for startup errors. |
| `permission denied` on Docker | Run `newgrp docker`, or log out and back in. |
| Port 3000 already in use | Set `PUBLIC_PORT=3001` in `.env` and open 3001 in OCI/firewall. |
| Build runs out of memory | Use a larger shape or build the image on another machine and push it to a registry. |

## Security checklist

- Set `MCP_AUTH_TOKEN`.
- Set `ALLOWED_STORE_HOSTS` to the stores you actually need.
- Restrict the OCI ingress rule to your IP when possible.
- Move to HTTPS before real use. A domain plus a reverse proxy such as Caddy
  with automatic Let's Encrypt certificates is the next step.
- Keep the OS and Docker updated:
  ```bash
  sudo apt-get update && sudo apt-get upgrade -y
  ```
