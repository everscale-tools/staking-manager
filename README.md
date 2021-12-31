![build](https://img.shields.io/docker/cloud/build/sergemedvedev/freeton-staking-manager.svg)
[![version](https://img.shields.io/docker/v/sergemedvedev/freeton-staking-manager?sort=semver)](https://hub.docker.com/r/sergemedvedev/freeton-staking-manager/tags)

# Everscale Staking Manager

## What is it?

This product is a complete solution for an Everscale validator, which abstracts away all the complexity of dealing with validator node and the network while sending stakes, receiving rewards and coping with various kinds of hardware or network issues.

It supports both wallet-based and DePool-based staking.

## Support the Project
You could help by:
- submitting an issue
- making a pull request
- sending some TONs to _0:cba74138b0ac11873e1ec262a71a22c3352de44383877679d1c6bd5165b7b49e_

  ![0:cba74138b0ac11873e1ec262a71a22c3352de44383877679d1c6bd5165b7b49e](gallery/wallet.png)

## Have it Up & Running

- Refer to [config.js.example](config.js.example) to create the `./config.js` file
- Create `./docker-compose.yml` using example below and deploy the service:
    ```yaml
    version: "2.3"
    services:
      staking-manager:
        image: sergemedvedev/freeton-staking-manager:4.0.0
        volumes:
          - type: bind
            source: ./config.js
            target: /usr/src/app/config.js
            read_only: true
          - type: volume
            source: data
            target: /data/staking-manager
        ports:
          - "127.0.0.1:3000:3000"
        environment:
          DEBUG: "app,api,lib:*"
        restart: always

    volumes:
      data:
    ```

  If you want to expose API to the internet, generate a secret and activate token-based authentication by providing additional environment variables:
    ```console
    $ openssl rand --hex 32
    ```
    ```yaml
    ports:
      - "3000:3000"
    environment:
      EVERSCALE_SM_ADMIN_NAME: <nice name>
      EVERSCALE_SM_ADMIN_PASSWORD: <strong password>
      EVERSCALE_SM_AUTH_SECRET: <secret generated via openssl>
    ```
    ```console
    $ docker-compose up -d
    ```

## API Reference

If you have authentication enabled, get your token first:
  ```console
  $ curl -s -H 'Content-Type: application/json' -d '{"name":"<nice name>","password":"<strong password>"}' <ip address or domain name>:3000/auth
  ```
For convenience, you might want to store the token in a file in the HTTP header form:
  ```console
  $ echo 'EVERSCALE-SM-APIKEY: <token you received>' > token-header
  ```
Now `curl` can be called like that:
  ```console
  $ curl -H @token-header ...
  ```

### POST /stake/:action
Tries to send/recover/resize a stake

> __:action__ "send", "recover" or "resize"

NOTE: only "send" (without "force") is usable in "depool" funding mode

Example:
```console
$ curl -XPOST localhost:3000/stake/recover
```

Pass _force_ query parameter to send a stake even if it's "already submitted":
```console
$ curl -XPOST localhost:3000/stake/send?force=yes
```

Pass _value_ query parameter to set the default stake size:

```console
$ curl -XPOST localhost:3000/stake/resize?value=20000
```
---

### POST /elections/:action
Allows to skip upcoming elections (no idea why one would need it)

> __:action__ "skip" or "participate"

Example:
```console
$ curl -XPOST localhost:3000/elections/skip
```
---

### GET /elections/history
Returns info (keys, stake, etc.) about elections the node participated in

Example:
```console
$ curl -s localhost:3000/elections/history | jq '.'
```
---

### PUT /ticktock
Invokes DePool's State Update method (ticktock)

Example:
```console
$ curl -XPUT localhost:3000/ticktock
```
---

### POST /validation/resume
Returns the node back to validation after it's re-sync'ed from scratch

> __NOTE__: at the moment it's NOT supported

Example:
```console
$ curl -XPOST localhost:3000/validation/resume
```
---

### GET /stats/:representation
Shows validator stats

> __:representation__ "json" or "influxdb"

Pass _interval_ query parameter (in seconds) to change the time frame for blocks signatures counting (default: 60s)

Example:
```console
$ curl localhost:3000/stats/json?interval=3600
```

---

## TODO

- Add multiple nodes management
