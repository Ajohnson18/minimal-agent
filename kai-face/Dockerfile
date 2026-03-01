# ── Build stage ──────────────────────────────────────────────
FROM node:22-slim AS build

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

WORKDIR /app

COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install --immutable

COPY . .
RUN yarn build

# ── Production stage ─────────────────────────────────────────
FROM nginx:alpine AS production

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 3000

CMD ["nginx", "-g", "daemon off;"]
