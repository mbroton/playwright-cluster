
# build stage
FROM golang:1.23-alpine AS build

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux go build -o /app/proxy ./cmd/proxy

# final stage
FROM alpine:3.20

WORKDIR /app

COPY --from=build /app/proxy /app/proxy

EXPOSE 3111

ENTRYPOINT [ "/app/proxy" ] 