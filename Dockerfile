# The runtime image only: bin/quickmeet is built outside it by `lgx build`
# (CGO_ENABLED=0, so it is static and runs on Alpine). CI already builds the
# binary on a cached lg runtime; building inside Docker would rebuild the Go
# runtime in a layer on every dependency change. The cost: this image cannot
# be built from a bare clone without lgx and Go.
FROM alpine:3.22

RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY bin/quickmeet /app/quickmeet

LABEL org.opencontainers.image.source=https://github.com/abogoyavlensky/quickmeet

CMD ["/app/quickmeet"]
