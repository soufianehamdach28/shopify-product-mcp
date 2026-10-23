# VM-side deployment setup

On your Oracle Cloud VM, you'll only need `docker-compose.yml`, `.env`, and this setup script.

## 1. Install Docker

If not installed:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
```

Or follow the full guide in `deploy/oracle-cloud.md`.

## 2. Create directory and files

```bash
mkdir -p ~/shopify-product-mcp
cd ~/shopify-product-mcp
```

Copy `docker-compose.yml` from your repo to this directory.

## 3. Create `.env`

```bash
cp ../.env.example .env  # or create manually
nano .env
```

Minimum required for public deployment:

```env
PUBLIC_HOST=<YOUR_PUBLIC_IP>
PUBLIC_PORT=3000
MCP_AUTH_TOKEN=$(openssl rand -hex 32)
ALLOWED_STORE_HOSTS=coachsoak.com
```

## 4. Login to GHCR

```bash
echo $GITHUB_PAT | docker login ghcr.io -u <your-github-username> --password-stdin
```

Create a Personal Access Token (classic) with `read:packages` scope at https://github.com/settings/tokens.

## 5. Pull and start

```bash
docker compose pull
docker compose up -d
```

## 6. GitHub Secrets

Add these to your repo Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `SSH_HOST` | Public IP of your VM |
| `SSH_USER` | `ubuntu` (or `opc` for Oracle Linux) |
| `SSH_KEY` | Private SSH key (entire content including BEGIN/END) |
| `SSH_PORT` | `22` (optional) |
| `GHCR_USERNAME` | Your GitHub username (optional if same as actor) |
| `GHCR_TOKEN` | PAT with `read:packages` scope (optional if using GITHUB_TOKEN) |

After pushing to `main`, the workflow will automatically build, push, and deploy.
