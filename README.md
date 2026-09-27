# Torn API MCP App for ChatGPT

Cloudflare Workers-only remote MCP App for the official Torn API v2.

## Architecture

ChatGPT -> OAuth 2.1 -> Cloudflare Worker -> live Torn OpenAPI -> dynamic MCP tools -> Torn API v2

The Worker uses Cloudflare's OAuth 2.1 provider and the MCP TypeScript SDK. OAuth access tokens are resource-bound and the authenticated grant contains the user's Torn credential in encrypted OAuth-provider storage.

The live Torn OpenAPI source is:

https://www.torn.com/swagger/openapi.json

The Torn API base is:

https://api.torn.com/v2

## Dynamic API coverage

At runtime the Worker:

1. Fetches the live Torn OpenAPI document.
2. Iterates every current OpenAPI path and supported HTTP operation.
3. Resolves Torn API-key parameter references.
4. Removes any existing `key` parameter.
5. Injects exactly one canonical required `key` parameter.
6. Removes `key` from the model-visible tool input schema.
7. Injects the authenticated user's Torn API key server-side immediately before the Torn request.

No endpoint count is hardcoded.

## Authentication

The MCP resource is protected with OAuth 2.1.

During authorization, the user is shown a Cloudflare Worker authorization page and enters their personal Torn API key. The Worker validates the key against Torn's V2 `/user/profile` endpoint, derives the Torn user ID, and stores the Torn key inside the encrypted OAuth grant properties.

The Torn API key is never:

- committed to GitHub;
- placed in MCP tool arguments;
- supplied by the model;
- returned to ChatGPT;
- logged in error messages.

OAuth access tokens are separate from Torn API keys.

## Cloudflare requirement

The OAuth provider requires a KV namespace bound as `OAUTH_KV`.

In Cloudflare:

1. Create a Workers KV namespace.
2. Bind it to this Worker using binding name `OAUTH_KV`.
3. Keep the binding available to the production deployment.

The repository enables the `global_fetch_strictly_public` compatibility flag because Client ID Metadata Documents are enabled for MCP client registration.

## Remote endpoint

Production MCP URL:

`https://tornapi-plugin-gpt.kboone801.workers.dev/mcp`

Health endpoint:

`https://tornapi-plugin-gpt.kboone801.workers.dev/health`

OAuth protected-resource discovery is provided automatically by the OAuth provider.

## ChatGPT setup

Create an **MCP App**.

Use:

- Name: `Torn API V2`
- Description: `Personal Torn API V2 access for authenticated Torn data and actions.`
- Connection: `https://tornapi-plugin-gpt.kboone801.workers.dev/mcp`
- Authentication: OAuth

After the OAuth-enabled deployment is live, ChatGPT should discover the authorization metadata instead of showing placeholder OAuth endpoints.

If ChatGPT offers registration methods, prefer **Client Identifier Metadata Document (CIMD)** when available. DCR remains enabled as a compatibility fallback.

Do not manually enter an OAuth endpoint with an `example.com` placeholder.

## Deployment

Cloudflare Workers Builds is the only deployment path.

1. Connect GitHub repository `SharpSplinter/tornapi-plugin-gpt` to Cloudflare Workers Builds.
2. Use repository root `/`.
3. Use deploy command `npx wrangler deploy`.
4. Pushes to `main` deploy automatically.
5. Create and bind the `OAUTH_KV` namespace in Cloudflare before using OAuth.
6. After the OAuth-enabled deployment succeeds, return to the ChatGPT MCP App configuration and retry OAuth discovery.

No local server, Docker host, VPS, or manual OpenAPI snapshot is required.

## Security model

- No master Torn API key.
- Each OAuth grant is associated with one Torn user ID.
- Torn credentials are encrypted by the OAuth provider's grant storage.
- OAuth tokens are separately stored and validated.
- MCP tokens are audience-bound to the MCP resource.
- PKCE S256 is handled by the OAuth provider.
- Client metadata discovery uses the required Cloudflare SSRF protection flag.
- Model-supplied `key` arguments are ignored and are not exposed in tool schemas.
- Torn API keys are redacted from error text.
- The Worker dynamically follows the live Torn OpenAPI document.

## Important limitation

The original idea of scanning raw ChatGPT conversation history for a key cannot be implemented reliably by an MCP server. The authenticated OAuth credential is the authoritative security boundary. The Worker therefore refuses MCP access without a valid OAuth credential and never treats conversation text as authentication.

## License

MIT
