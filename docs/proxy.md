# SpotPilot HTTPS proxy

This setup provides an authenticated HTTPS forward proxy with a stable IPv4
egress address. It supports every current SpotPilot API request while limiting
the proxy destination allowlist to SafeTrade and CoinEx.

The outer TLS connection protects the proxy username and password. Inside it,
`CONNECT` creates an opaque TCP tunnel. SpotPilot then performs a separate,
normally verified TLS handshake directly with the selected exchange.

## What the proxy can and cannot see

The proxy can observe:

- the connecting IP address and proxy username;
- `safe.trade:443` or `api.coinex.com:443` as the destination;
- connection timestamps, duration and byte counts.

It cannot read the exchange URL path, API key, signature, request body or API
response. It can block or slow a connection. If it tries to replace the
exchange certificate, Node.js rejects the TLS connection because SpotPilot
does not trust a proxy CA and never disables certificate verification.

## Ubuntu installation

The commands below target a current Ubuntu or Debian server. Create an IPv4
`A` record such as `proxy.example.com` pointing to the static address that the
exchange has allowlisted. Do not add an `AAAA` record for this IPv4-only proxy.
If Cloudflare hosts the DNS zone, set this record to **DNS only** (grey cloud),
not Proxied. The client must establish the forward-proxy connection directly
with Squid; ordinary Cloudflare Layer 7 proxying is not a CONNECT relay.

Install Squid, the password utility and Certbot:

```bash
sudo apt update
sudo apt install -y squid apache2-utils certbot
```

Check that the packaged Squid supports an HTTPS listening port:

```bash
squid -v
```

The build options should include OpenSSL or GnuTLS support.

### Obtain a public TLS certificate

On a dedicated proxy host without another web server:

```bash
sudo certbot certonly --standalone -d proxy.example.com
```

Standalone validation needs inbound TCP port 80 temporarily. If the proxy and
website share a host, obtain the certificate through the existing web server
instead, for example with Certbot's Nginx plugin or webroot method. Squid can
use the resulting certificate without owning port 443.

Copy the certificate into a directory readable by Squid. Ubuntu and Debian run
Squid as the `proxy` user/group:

```bash
sudo install -d -o root -g proxy -m 0750 /etc/squid/tls
sudo install -o root -g proxy -m 0640 \
  /etc/letsencrypt/live/proxy.example.com/fullchain.pem \
  /etc/squid/tls/fullchain.pem
sudo install -o root -g proxy -m 0640 \
  /etc/letsencrypt/live/proxy.example.com/privkey.pem \
  /etc/squid/tls/privkey.pem
```

### Create proxy credentials

Create a separate account for every user so access can be revoked without
affecting anyone else:

```bash
sudo htpasswd -c /etc/squid/passwords first-user
sudo htpasswd /etc/squid/passwords second-user
sudo chown root:proxy /etc/squid/passwords
sudo chmod 0640 /etc/squid/passwords
```

Use a URL-safe random password, for example hexadecimal output from
`openssl rand -hex 24`. The interactive `htpasswd` prompt keeps the password
out of shell history.

### Install the restricted configuration

Back up the distribution configuration and install the supplied minimal file:

```bash
sudo cp /etc/squid/squid.conf /etc/squid/squid.conf.distribution
sudo cp deploy/proxy/squid.conf.example /etc/squid/squid.conf
```

The example listens on TCP 8443 so it can coexist with a website on 443. Open
8443 in the host firewall or cloud security group. Do not expose Squid's usual
unencrypted 3128 port.

Install the systemd restriction that prevents Squid from opening IPv6 sockets:

```bash
sudo mkdir -p /etc/systemd/system/squid.service.d
sudo cp deploy/proxy/squid.service.override.conf \
  /etc/systemd/system/squid.service.d/override.conf
sudo systemctl daemon-reload
```

This ensures SafeTrade sees the allowlisted IPv4 even when the host itself also
has IPv6 connectivity. It does not disable IPv6 for the website or other
services on the same server.

Validate and start the proxy:

```bash
sudo squid -k parse
sudo systemctl restart squid
sudo systemctl enable squid
sudo systemctl status squid --no-pager
```

If the authentication helper path differs on the distribution, locate it with
`dpkg -L squid | grep basic_ncsa_auth` and update `squid.conf`.

### Renew certificates automatically

Edit `PROXY_DOMAIN` in the supplied renewal-hook example, then install it:

```bash
sudo cp deploy/proxy/renew-certificate.sh.example \
  /etc/letsencrypt/renewal-hooks/deploy/spotpilot-squid
sudo chmod 0755 \
  /etc/letsencrypt/renewal-hooks/deploy/spotpilot-squid
sudo /etc/letsencrypt/renewal-hooks/deploy/spotpilot-squid
sudo certbot renew --dry-run
```

## Configure SpotPilot

Add the authenticated proxy URL to `.env`:

```dotenv
SPOTPILOT_PROXY_URL=https://first-user:URL_SAFE_PASSWORD@proxy.example.com:8443
```

If it is missing or empty, SpotPilot uses direct connections. When present, it
applies to all public and private SafeTrade and CoinEx API calls.

Test public endpoints before private balances or orders:

```bash
npm run smoke:safetrade
npm run smoke:coinex
```

You can also test the tunnel independently:

```bash
curl --proxy https://first-user:URL_SAFE_PASSWORD@proxy.example.com:8443 \
  https://safe.trade/api/v2/trade/public/tickers/btcusdt
```

Do not add `-k`, `--insecure`, a custom exchange CA, or certificate-validation
exceptions. Successful output should show a `CONNECT` tunnel followed by the
normal certificate for the exchange hostname.

## Operational checks

The active configuration must not contain TLS interception, generated origin
certificates or TLS key logging. Review it whenever Squid is updated:

```bash
sudo squid -k parse
sudo grep -RniE '^[[:space:]]*(ssl_bump|tls_key_log|icap_|ecap_)' \
  /etc/squid
sudo journalctl -u squid --since today
sudo tail -n 50 /var/log/squid/access.log
```

The grep command should return no active directives. The access log should
contain `CONNECT` destinations, not exchange request paths or authentication
headers.

## Adding another exchange

Proxy use in the application is already global. When SpotPilot adds a new
exchange, append its API hostname to the `exchange_api` ACL in `squid.conf`,
run `sudo squid -k parse`, and reload Squid.
