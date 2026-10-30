FROM docker.io/cloudflare/sandbox:0.12.14

RUN npm install -g pnpm@10.28.2 && pnpm --version && git --version

WORKDIR /workspace
