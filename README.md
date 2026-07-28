# gmail-multi-mcp

MCP server exposing several Google Workspace accounts — across **separate orgs and
domains** — to Claude at the same time, with verified send-as alias support.

## Why this exists

The built-in Gmail connector (`https://gmailmcp.googleapis.com/mcp/v1`) authenticates
one Google identity and its `create_draft` takes no `from` parameter, so it can only
ever draft as the connected account. Adding a second custom connector for a second
account is blocked separately: Claude keys custom connectors by URL alone and rejects
a duplicate URL.

So this is **one server holding N accounts**, with an `account` argument on every tool
and a validated `from` argument on the compose tools.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_accounts` | Configured accounts and their keys |
| `list_send_as` | Send-as identities on an account, and which are usable |
| `search_messages` | Gmail query syntax search |
| `get_message` | One message, full bodies |
| `get_thread` | Every message in a thread |
| `list_drafts` | Drafts, optionally filtered |
| `create_draft` | Create a draft, optionally as an alias or as a threaded reply |
| `update_draft` | Merge changes into an existing draft |
| `send_draft` | Send an existing draft — **only if `GMAIL_MULTI_ALLOW_SEND=1`** |
| `send_message` | Compose and send — **only if `GMAIL_MULTI_ALLOW_SEND=1`** |

Sending is off by default. Routines run unattended with no approval step, so the send
tools are not even registered unless you opt in.

## Setup

### 1. One OAuth client per Workspace org

This is the part that determines whether the whole thing works. The Gmail scopes used
here are *restricted*, which means:

- **External + Testing** → refresh tokens expire after **7 days**. Unusable.
- **External + Published** → Google verification plus an annual CASA Tier-2 security
  assessment. Weeks of work.
- **Internal** → no verification, refresh tokens do not expire. ✅

An Internal app is only internal to *one* org, so three orgs need three OAuth clients.
For each one, signed in as an admin of that domain:

1. [Google Cloud Console](https://console.cloud.google.com) → create or pick a project
   owned by that Workspace org.
2. **APIs & Services → Library** → enable **Gmail API**.
3. **APIs & Services → OAuth consent screen** → User Type **Internal** → fill in app
   name and support email.
4. **Data access / Scopes** → add:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.settings.basic`
5. **Credentials → Create credentials → OAuth client ID** → application type
   **Desktop app**. Desktop clients accept loopback redirects on any port, so there is
   nothing to register. Copy the client ID and secret.
6. In that org's **Admin console → Security → Access and data control → API controls →
   App access control**, confirm the app is not blocked. Restricted scopes are blocked
   by default in some orgs; if so, allowlist it by client ID and mark it Trusted.

### 2. Authorize each account

Run once per account, in a browser signed in as that account:

```bash
npm run auth -- --account indelible --client-id <id> --client-secret <secret>
```

Credentials land in `~/.gmail-multi-mcp/accounts.json` at mode 0600. The `--account`
value is the key you will pass as `account` in every tool call, so keep it short.

### 3. Point Claude at it

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "gmail-multi": {
      "command": "node",
      "args": ["C:\\Users\\kevin\\src\\gmail-multi-mcp\\src\\index.js"]
    }
  }
}
```

To enable sending, add `"env": { "GMAIL_MULTI_ALLOW_SEND": "1" }`.

### Cloud routines

Cloud sessions have no access to your home directory, so credentials come from the
environment instead. Set `GMAIL_MULTI_ACCOUNTS` on the cloud environment to the
contents of `accounts.json` — raw JSON, or base64 if the shell mangles quotes — and
commit a `.mcp.json` to a repository the routine clones.

`*.googleapis.com` and `accounts.google.com` are already on the default **Trusted**
network allowlist, so no allowlist change is needed.

## The two things this server is careful about

**Unverified From addresses.** Gmail does not reliably error when you set a `From`
the account cannot send as — it silently substitutes the primary address. A draft
meant to go out as one business quietly goes out as another. So every `from` is
checked against `users.settings.sendAs.list` first and rejected if it is not verified.
The primary address reports an empty `verificationStatus` rather than `accepted`, so
it is admitted via `isPrimary`.

**Draft updates.** `drafts.update` is a full PUT replace, not a patch. `update_draft`
reads the existing draft, merges your changes over it, and rebuilds — preserving
`threadId` and the `In-Reply-To`/`References` headers, without which the draft
silently detaches from its thread. The draft id is stable across updates even though
the underlying message id changes each time, so key any state off `draftId`.

## Development

```bash
npm test
```

Covers the MIME builder: base64url alphabet, multipart structure, RFC 2047 header
encoding, threading headers, line wrapping, and payload extraction. No parser is
needed — drafts are read back with `format=full`, which returns a decoded tree.
