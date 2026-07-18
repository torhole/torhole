FROM node:22-alpine AS ui

WORKDIR /src
COPY monitoring/torhole-ui-v2/package.json monitoring/torhole-ui-v2/package-lock.json ./
RUN npm ci
COPY monitoring/torhole-ui-v2/ ./
RUN npm run build -- --base=/ --outDir=/ui

FROM docker:27-cli

RUN apk add --no-cache bash python3 docker-cli-compose
WORKDIR /app
COPY bootstrap/server.py ./
COPY --from=ui /ui ./ui
EXPOSE 8099
CMD ["python3", "/app/server.py"]
