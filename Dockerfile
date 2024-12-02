FROM alpine/git AS contracts

RUN git clone https://github.com/everx-labs/ton-labs-contracts.git /ton-labs-contracts

FROM sergemedvedev/ever-node-tools:0.60.11 AS node-tools

FROM node:bullseye-slim

EXPOSE 3000

RUN mkdir -p /usr/src/app
WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y \
    ca-certificates \
    libssl1.1

COPY --from=contracts /ton-labs-contracts/solidity contracts/solidity
COPY --from=node-tools \
    /usr/bin/console \
    /usr/bin/keygen \
    /usr/bin/

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

CMD ["node", "app.js"]
