# GitHub Actions Deployment

This repo has a workflow to build the Docker image and deploy to an Oracle Cloud VM.

## Files
- `.github/workflows/deploy.yml` - CI/CD pipeline
- `Dockerfile` - Multi-stage build
- `docker-compose.yml` - Image-based deployment (pulls from GHCR)

## Setup

1. **Push to GitHub**: Initialize git and push to `main` branch
2. **Set secrets** (Settings → Secrets and variables → Actions):
   - `SSH_HOST` - VM public IP
   - `SSH_USER` - SSH username (ubuntu/opc)
   - `SSH_KEY` - Private SSH key
   - `SSH_PORT` - (optional, default 22)
   - `GHCR_TOKEN` or `GHCR_USERNAME` - (optional, workflow uses GITHUB_TOKEN)
3. **Prepare VM**: Follow `deploy/VM_SETUP.md`
4. **Push and deploy**: On push to `main`, GitHub Actions will build and deploy automatically

## Manual trigger
Go to Actions → Build and Deploy → Run workflow to trigger manually.
