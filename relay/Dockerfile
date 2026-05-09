FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags="-s -w" -o /relay ./main.go

FROM alpine:3.19
RUN apk add --no-cache ca-certificates wget && \
    addgroup -S relay && adduser -S -G relay relay
COPY --from=builder /relay /usr/local/bin/relay
USER relay
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/relay"]
