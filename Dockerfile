# Dockerfile — optional containerized app (see docker-compose.yml `app` profile)
# The SQLite dev/test path needs zero dependencies. The Postgres path needs the
# `pg` driver, which we install at build time (registry access required here).
FROM node:22-alpine

WORKDIR /app

# Only package.json exists (no lockfile / no bundled deps by design). Install
# the single production dependency needed for the Postgres adapter.
COPY package.json ./
RUN npm install --omit=dev pg@8 && npm cache clean --force

# App source.
COPY . .

# Build the widget bundle so /widget/consentgrid.js is served from dist.
RUN node widget/build.js

# Signing keys live on a mounted volume in dev; never bake keys into the image.
RUN mkdir -p /data/keys
ENV NODE_ENV=development \
    PORT=8080 \
    KMS_LOCAL_DIR=/data/keys

EXPOSE 8080

# Default command is overridden by docker-compose to run migrate+seed first.
CMD ["npm", "start"]
