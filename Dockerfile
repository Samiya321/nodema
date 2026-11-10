FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=8080
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN pip install --no-cache-dir uv && uv sync --frozen --no-dev --no-install-project
COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./
RUN uv sync --frozen --no-dev && useradd --create-home --uid 10001 nodema && chown -R nodema:nodema /app
USER nodema
EXPOSE 8080
CMD ["sh", "-c", "exec .venv/bin/nodema serve --host 0.0.0.0 --port ${PORT:-8080}"]
