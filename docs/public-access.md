# Public access operations

## Entry point

- URL: `https://zy-seedance.duckdns.org:10443`
- Public listener: Caddy on `0.0.0.0:10443/TCP`
- Upstream: `http://127.0.0.1:43170`
- Authentication: HTTP Basic Auth on every route
- TLS: Let's Encrypt certificate issued with DuckDNS DNS-01

Caddy access logging is not enabled. Basic Auth credentials are removed before
requests are proxied to the Web service.

## Manage users

Generate a bcrypt hash without putting the plaintext password in shell history:

```bash
sudo caddy hash-password
```

Enter the password twice when prompted. It is not echoed. Copy only the resulting
hash, then edit the user file:

```bash
sudoedit /etc/caddy/seedance-users.caddy
```

Each line has this form:

```text
username bcrypt-hash
```

- Add a user: append a new line.
- Delete a user: remove that user's line.
- Change a password: generate a new hash and replace that user's existing hash.

After every user change, validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

## Certificate operations

View the installed certificate and validity period:

```bash
sudo openssl x509 \
  -in /etc/caddy/certs/zy-seedance.duckdns.org/fullchain.pem \
  -noout -subject -issuer -dates -ext subjectAltName
```

Check automatic renewal:

```bash
sudo systemctl status seedance-acme-renew.timer
sudo systemctl list-timers seedance-acme-renew.timer --no-pager
sudo journalctl -u seedance-acme-renew.service --no-pager
```

Run a manual renewal check. acme.sh renews only when the certificate is due and
reloads Caddy after a successful renewal:

```bash
sudo systemctl start seedance-acme-renew.service
sudo systemctl status seedance-acme-renew.service
```

The renewal helper tries direct network access first and then the root-only
proxy fallback in `/etc/seedance-console/acme-proxy.env`.

## Caddy operations

```bash
sudo systemctl status caddy
sudo systemctl stop caddy
sudo systemctl start caddy
sudo ss -lntp | grep -E ':(10443)\b'
```

Stopping Caddy immediately closes the public entry point. It does not stop the
Seedance Console containers.

## Cloud firewall

Allow the new entry point in the Mobile Cloud security group:

```text
Direction: inbound
Protocol: TCP
Port: 10443
Source: 0.0.0.0/0
```

After the authenticated HTTPS entry point is verified, delete the old public
allow rule for port 43170. The host-side Web listener is already restricted to
`127.0.0.1:43170`.
