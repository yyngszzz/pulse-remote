# Security

## What this is, in threat-model terms

`pulse-remote` is not a read-only dashboard. Once it is running and a phone is paired, that phone can

- drive the agent on this machine (send prompts, answer its questions, approve what it asks for),
- read the machine's files through the client's own file routes,
- open whatever the client can open, including the settings that own the harness configuration.

So the honest framing is: **whoever holds a paired device has remote control of this machine.** Treat
the pairing secret like an SSH key, and treat an exposed listener like an open SSH port.

## Defaults, and why they are the defaults

- The listener binds **`127.0.0.1`** and nothing else. Reaching it from a phone requires a deliberate
  act (an SSH reverse tunnel, or a reverse proxy) — that act is the security boundary, so it should
  be a decision, not a default.
- The listener is **not** a substitute for authentication in front of it. Put it behind TLS that you
  control, and do not open its port to the internet.
- Pairing happens through a **one-time code** (30 minute window) and the resulting device token is
  stored **hashed** (scrypt). Devices can be revoked, and revocation takes effect immediately.
- **Management endpoints are loopback-only**, authenticated by a token file on this machine — so a
  paired phone cannot mint new devices or read the device roster.
- Unpaired callers get the pairing gate and nothing else: no session list, no transcript, no files.

## Known trade-offs (deliberate, documented elsewhere too)

- **A self-signed certificate on a bare IP** is the deployment this was built for (no domain, no
  public CA, no filing). It removes a whole chain of paperwork *and* removes the safety net that a
  real certificate would give you: the phone has to be told to trust exactly that host. If you can
  use a domain and a real certificate, do.
- **Push channels are third parties.** The optional webhook / ServerChan / Bark transports send the
  notification text — which is distilled activity from your own sessions — to someone else's server.
  Leave `notify: 'none'` (the default) unless you have decided that is acceptable.
- **The web push subscription list lives on this machine** in the plugin's state file. It is not
  encrypted at rest; the file mode is `0600`.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security → Report a vulnerability) rather
than a public issue. If that is unavailable, open an issue that says only "security report — please
contact me" and wait for a private channel.

There is no bug bounty. This is a personal project, and the realistic response time is "as soon as I
read it".
