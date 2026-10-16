# Single-image deploy (Railway, Hugging Face Spaces, any container host):
# FastAPI serves both the API and the built React UI on one port, so cookies and /api just work.
#
# Local multi-container development still uses docker-compose.yml (web + coupon-service + postgres + redis).

# ---- 1. build the React UI ----
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 2. the service + the built UI ----
FROM python:3.12-slim
WORKDIR /code
COPY coupon-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY coupon-service/ .
COPY --from=web /web/dist ./static

ENV PYTHONUNBUFFERED=1
EXPOSE 8000
# $PORT is injected by Railway / Spaces; default for local runs
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-1} --proxy-headers --forwarded-allow-ips='*'"]
