FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
COPY schema.sql README.md ./
RUN mkdir -p /app/data && chown -R node:node /app
ENV NODE_ENV=production PORT=4100 REQUIRE_POSTGRES=1
EXPOSE 4100
USER node
CMD ["sh", "-c", "node src/migrate.js && exec node src/server.js"]
