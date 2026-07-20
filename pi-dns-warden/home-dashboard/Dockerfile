FROM node:22-alpine AS ui

WORKDIR /src
COPY monitoring/torhole-ui/package.json monitoring/torhole-ui/package-lock.json ./
RUN npm ci
COPY monitoring/torhole-ui/ ./
RUN npm run build -- --base=/ --outDir=/ui

FROM python:3.13-alpine

RUN addgroup -S torhole && adduser -S -G torhole torhole
WORKDIR /app
COPY home-dashboard/server.py ./
COPY --from=ui /ui ./ui
USER torhole
EXPOSE 8080
CMD ["python", "/app/server.py"]
