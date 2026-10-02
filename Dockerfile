# The runtime image only: bin/quickmeet is built outside it by `lgx build`
# (CGO_ENABLED=0, so it is static and runs on Alpine). CI already builds the
# binary on a cached lg runtime; building inside Docker would rebuild the Go
# runtime in a layer on every dependency change. The cost: this image cannot
# be built from a bare clone without lgx and Go.
#
# The same file makes the published image: .github/workflows/release.yml
# builds it around each architecture's CI binary and pushes it to ghcr.io.
FROM alpine:3.22

RUN apk add --no-cache ca-certificates

LABEL org.opencontainers.image.source="https://github.com/abogoyavlensky/quickmeet" \
      org.opencontainers.image.description="Self-hosted 1-to-1 video calls from a single binary"

WORKDIR /app
# The database lives in /app/data; mount a volume there to keep it.
RUN mkdir -p /app/data

# Defaults for a container: the SFU listens on every interface so a proxy
# outside the container can reach it, and all media goes over one UDP port
# so one port mapping carries it. Off loopback, the app refuses to start
# with the development secret: set LIVEKIT_API_SECRET. Advertising the
# public IP (LIVEKIT_USE_EXTERNAL_IP) is left to the `docker run` command:
# on a server it is needed, on a laptop it breaks media.
ENV DB_PATH=/app/data/quickmeet.db \
    LIVEKIT_BIND=0.0.0.0 \
    LIVEKIT_UDP_PORT=7882

COPY bin/quickmeet /app/quickmeet

# The app, the SFU's signalling, ICE over TCP, media.
EXPOSE 8080 7880 7881 7882/udp
CMD ["/app/quickmeet"]
