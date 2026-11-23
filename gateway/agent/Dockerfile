FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# zlib's security update, which the base image does not have yet. Over HTTPS, as everything else these hosts fetch.
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y zlib1g \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY agent.py update.py ed25519.py ./

RUN useradd --system --uid 10001 --create-home gateway \
 && mkdir -p /data \
 && chown gateway:gateway /data
USER gateway

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "/app/agent.py", "status", "--db", "/data/queue.db"]

# The launcher (update.py, part of the image, never replaced by an update) runs the agent and its signed updates.
CMD ["python", "-u", "/app/update.py", "run"]
