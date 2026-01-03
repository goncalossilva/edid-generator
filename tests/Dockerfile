FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends edid-decode ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /work
COPY . /work

ENV EDID_TEST_IN_DOCKER=1
