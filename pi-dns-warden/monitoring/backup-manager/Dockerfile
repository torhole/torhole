FROM python:3.12-alpine

# docker-cli + docker-cli-compose: backup-manager exec's docker commands and
# runs ops/scripts/19-validate-stack.sh which uses `docker compose ...`.
# Without docker-cli-compose installed, _compose.sh fails to find `docker
# compose` and validation errors out with all checks skipped.
RUN apk add --no-cache bash docker-cli docker-cli-compose openssl

WORKDIR /app
# All backend modules (server.py + extracted modules like env_store.py).
# test_*.py land in the image too — harmless; they run in CI, not at runtime.
COPY *.py /app/

EXPOSE 8080

CMD ["python3", "/app/server.py"]
