# Torn API MCP Gateway for ChatGPT

A Cloudflare Workers-only remote MCP gateway for the official Torn API v2.

## Architecture

ChatGPT -> Cloudflare Worker -> live Torn OpenAPI -> dynamic MCP tools -> Torn API v2

The Worker fetches the authoritative OpenAPI document from:

https://www.torn.com/swagger/openapi.json

It discovers every current OpenAPI path and HTTP operation at runtime and injects exactly one required query parameter:

```json
{
  "name": "key",
  "in": "query",
  "required": true,
  "description": "Your individual, personal Torn API key.",
  "schema": { "type": "string" }
}
```

Torn's OpenAPI may reference ApiKeyMinimal, ApiKeyLimited, or ApiKeyPublic. The Worker resolves those parameter references and replaces them with the canonical `key` contract above.

## Remote-only deployment

There is no application server, Docker host, VPS, local proxy, or manually maintained OpenAPI snapshot.

The production endpoint is:

`https://<worker-subdomain>.workers.dev/mcp`

## Authentication

The Worker expects an authenticated bearer credential. The bearer value must be the current user's Torn API key or a server-issued credential that the Worker securely maps to that user's Torn key.

Do not commit Torn API keys.

For a shared ChatGPT project, configure OAuth 2.1 so each project participant receives an identity-bound credential. The Worker must never trust a model-supplied `key` argument.

## Endpoints

- `POST /mcp` - Streamable HTTP MCP endpoint
- `OPTIONS /mcp` - CORS preflight
- `GET /health` - health check
- `GET /openapi` - live schema/operation diagnostics

## Deployment

1. Create a Cloudflare account.
2. Create a Workers API token with permission to deploy Workers.
3. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets.
4. Push to `main`.
5. GitHub Actions deploys the Worker.
6. Connect the resulting `/mcp` URL to ChatGPT.

For production user authentication, configure OAuth 2.1 using Cloudflare's Workers OAuth Provider or Cloudflare Access and bind the resulting authenticated subject to the user's Torn credential.

## Security properties

- No master Torn API key.
- No Torn key in source control.
- No Torn key in tool arguments.
- Server-side credential injection.
- API keys are removed from OpenAPI tool schemas.
- API-key-bearing URLs are never returned.
- Error messages redact `key=` and bearer credentials.
- OpenAPI discovery is live and dynamic.
- The schema is cached briefly in the Worker isolate to reduce upstream requests.

## Cloudflare Free plan considerations

The Worker is designed to remain within the Cloudflare Workers Free model for modest usage. Cloudflare currently documents 100,000 Worker requests/day, 10 ms CPU/request, and 50 subrequests/request on Free. Large tool catalogs can increase MCP response size, so a future Code Mode/search-and-execute interface may be preferable if the Torn schema grows substantially.

## License

MIT
