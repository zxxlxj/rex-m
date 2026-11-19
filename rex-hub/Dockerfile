FROM rust:1.93-alpine3.23 AS build
RUN apk add --no-cache build-base pkgconf sqlite-dev sqlite-static
ENV LIBSQLITE3_SYS_STATIC=1
WORKDIR /build
COPY migrations ./migrations
COPY docker ./docker
WORKDIR /build/docker
RUN cargo build --release --locked

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && addgroup -S -g 10001 rex && adduser -S -D -H -u 10001 -G rex rex && mkdir -p /data && chown rex:rex /data
COPY --from=build /build/docker/target/release/rex-hub /usr/local/bin/rex-hub
COPY public /app/public
ENV DATA_DIR=/data WEB_DIR=/app/public PORT=8080
USER 10001:10001
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/rex-hub"]
