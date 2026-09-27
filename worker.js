import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { AuthorizationError, OAuthProvider } from "@cloudflare/workers-oauth-provider";

const DEFAULT_OPENAPI_URL = "https://www.torn.com/swagger/openapi.json";
const DEFAULT_API_BASE = "https://api.torn.com/v2";
const DEFAULT_USER_AGENT = "TornChatGPT/1.0";
const OPENAPI_TTL_MS = 15 * 60 * 1000;
const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const MCP_RESOURCE = "https://tornapi-plugin-gpt.kboone801.workers.dev/mcp";
const MCP_SCOPE = "mcp:read";

let schemaCache = { document: null, fetchedAt: 0 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Accept,Authorization,Content-Type,Last-Event-ID,MCP-Protocol-Version,Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id,MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...headers }
});

const text = (body, status = 200, headers = {}) => new Response(body, {
  status,
  headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS, ...headers }
});

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/([?&]key=)[^&\s]+/gi, "$1[REDACTED]");
  message = message.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
  return message.slice(0, 1000);
}

function validKey(key) {
  return !!key && key.length >= 8 && key.length <= 512 && /^[A-Za-z0-9_-]+$/.test(key);
}

function envValue(env, name, fallback) {
  return typeof env?.[name] === "string" && env[name] ? env[name] : fallback;
}

async function getOpenApi(env) {
  const now = Date.now();
  if (schemaCache.document && now - schemaCache.fetchedAt < OPENAPI_TTL_MS) return schemaCache.document;

  const response = await fetch(envValue(env, "TORN_OPENAPI_URL", DEFAULT_OPENAPI_URL), {
    headers: {
      Accept: "application/json",
      "User-Agent": envValue(env, "TORN_USER_AGENT", DEFAULT_USER_AGENT)
    },
    cf: { cacheTtl: 900 }
  });

  if (!response.ok) throw new Error(`Torn OpenAPI fetch failed: HTTP ${response.status}`);
  const document = await response.json();
  if (!document || typeof document !== "object" || !document.paths) throw new Error("Torn returned an invalid OpenAPI document.");
  schemaCache = { document, fetchedAt: now };
  return document;
}

function dereferenceParameter(document, parameter) {
  if (!parameter?.$ref) return parameter;
  const prefix = "#/components/parameters/";
  if (!parameter.$ref.startsWith(prefix)) return parameter;
  const name = parameter.$ref.slice(prefix.length);
  return document.components?.parameters?.[name] ?? parameter;
}

function normalizeOperation(document, path, method, pathItem, operation) {
  const parameters = [
    ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
    ...(Array.isArray(operation.parameters) ? operation.parameters : [])
  ].map(p => dereferenceParameter(document, p));

  const filtered = parameters.filter(p => !(p?.in === "query" && (
    p.name === "key" || p.name === "ApiKeyMinimal" || p.name === "ApiKeyLimited" || p.name === "ApiKeyPublic"
  )));

  filtered.push({
    name: "key",
    in: "query",
    required: true,
    description: "Your individual, personal Torn API key.",
    schema: { type: "string" }
  });

  return { ...operation, parameters: filtered, "x-torn-path": path, "x-torn-method": method.toUpperCase() };
}

function discover(document) {
  const result = [];
  for (const [path, pathItem] of Object.entries(document.paths || {})) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const [method, rawOperation] of Object.entries(pathItem)) {
      if (!METHODS.has(method.toLowerCase())) continue;
      const operation = normalizeOperation(document, path, method.toLowerCase(), pathItem, rawOperation);
      const operationId = String(operation.operationId || `torn_${method}_${path}`)
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 128);
      result.push({ name: operationId, method: method.toUpperCase(), path, operation });
    }
  }
  return result;
}

function inputSchema(operation) {
  const properties = {};
  const required = [];

  for (const p of operation.parameters || []) {
    if (!p?.name || p.name === "key") continue;
    const schema = p.schema && !p.schema.$ref ? p.schema : { type: "string" };
    properties[p.name] = { ...schema, description: p.description || `${p.in || "query"} parameter: ${p.name}` };
    if (p.required) required.push(p.name);
  }

  if (operation.requestBody) {
    properties.body = { type: "object", description: "Request body defined by the Torn OpenAPI operation." };
  }

  return { type: "object", properties, required, additionalProperties: false };
}

function substitutePath(path, args) {
  return path.replace(/\{([^}]+)\}/g, (_, name) => {
    if (args[name] === undefined || args[name] === null) throw new Error(`Missing path parameter: ${name}`);
    return encodeURIComponent(String(args[name]));
  });
}

async function callTorn(env, key, operation, args) {
  if (!validKey(key)) throw new Error("Authenticated Torn credential is unavailable.");

  const url = new URL(envValue(env, "TORN_API_BASE", DEFAULT_API_BASE) + substitutePath(operation.path, args || {}));
  for (const p of operation.parameters || []) {
    if (p.in !== "query" || p.name === "key") continue;
    const value = args?.[p.name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach(item => url.searchParams.append(p.name, String(item)));
    else url.searchParams.set(p.name, String(value));
  }
  url.searchParams.set("key", key);

  const init = { method: operation.method, headers: { Accept: "application/json", "User-Agent": envValue(env, "TORN_USER_AGENT", DEFAULT_USER_AGENT) } };
  if (args?.body !== undefined && operation.requestBody) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(args.body);
  }

  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json") ? await response.json() : await response.text();
  return { isError: !response.ok, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

async function validateTornKey(env, key) {
  if (!validKey(key)) return null;
  const url = new URL(`${envValue(env, "TORN_API_BASE", DEFAULT_API_BASE)}/user/profile`);
  url.searchParams.set("key", key);
  const response = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": envValue(env, "TORN_USER_AGENT", DEFAULT_USER_AGENT) }
  });
  if (!response.ok) return null;
  const payload = await response.json();
  const profile = payload?.profile ?? payload?.user ?? payload;
  const id = profile?.id ?? profile?.user_id;
  if (id === undefined || id === null) return null;
  return { id: String(id), name: typeof profile?.name === "string" ? profile.name : `Torn user ${id}` };
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

function parseCookies(request) {
  const result = {};
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return result;
}

function csrfCookie(token) {
  return `__Host-torn-csrf=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`;
}

function clearCsrfCookie() {
  return "__Host-torn-csrf=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0";
}

function authorizeErrorResponse(error) {
  if (!(error instanceof AuthorizationError)) throw error;
  if (!error.redirectUri) return text(error.description, 400);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect.href, 302);
}



async function parseAuthRequestCompat(oauth, request) {
  const url = new URL(request.url);
  const suppliedClientId = url.searchParams.get("client_id");
  const suppliedRedirectUri = url.searchParams.get("redirect_uri");

  if (suppliedClientId) return oauth.parseAuthRequest(request);

  const stableClientId = "https://chatgpt.com/oauth/client.json";
  const stableRedirectUri = "https://chatgpt.com/connector_platform_oauth_redirect";
  let clientId = stableClientId;
  let redirectUri = suppliedRedirectUri || stableRedirectUri;

  if (suppliedRedirectUri) {
    try {
      const redirect = new URL(suppliedRedirectUri);
      if (redirect.origin !== "https://chatgpt.com") return oauth.parseAuthRequest(request);
      if (redirect.href === stableRedirectUri) clientId = stableClientId;
      else {
        const match = redirect.pathname.match(/^\/connector\/oauth\/([^/]+)$/);
        if (match) clientId = "https://chatgpt.com/oauth/" + match[1] + "/client.json";
        else return oauth.parseAuthRequest(request);
      }
    } catch {
      return oauth.parseAuthRequest(request);
    }
  }

  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  return oauth.parseAuthRequest(new Request(url, request));
}

async function authorize(request, env) {
  const oauth = env.OAUTH_PROVIDER;
  let oauthRequest;
  try {
    oauthRequest = await parseAuthRequestCompat(oauth, request);
  } catch (error) {
    return authorizeErrorResponse(error);
  }

  const client = await oauth.lookupClient(oauthRequest.clientId);
  if (!client) return text("Unknown OAuth client.", 400);

  if (request.method === "GET") {
    const csrf = crypto.randomUUID();
    const params = new URL(request.url).search;
    const redirectHost = (() => { try { return new URL(oauthRequest.redirectUri).host; } catch { return "the requesting app"; } })();
    const scopes = oauthRequest.scope.filter(scope => scope === MCP_SCOPE);
    const headers = new Headers({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
      "Set-Cookie": csrfCookie(csrf)
    });
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Torn API V2 authorization</title><style>body{font-family:system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 20px;line-height:1.5}input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;margin-top:8px}button{cursor:pointer}code{word-break:break-all}</style></head><body><h1>Torn API V2</h1><p><strong>${htmlEscape(client.clientName || "ChatGPT")}</strong> is requesting access for <code>${htmlEscape(redirectHost)}</code>.</p><p>Enter your personal Torn API key. It is validated directly with Torn and then stored only inside the encrypted OAuth grant. It is never sent to ChatGPT as a tool argument.</p><p>Requested permission: ${htmlEscape(scopes.join(", ") || MCP_SCOPE)}</p><form method="post" action="/authorize"><input type="hidden" name="csrf" value="${htmlEscape(csrf)}"><input type="hidden" name="oauth_params" value="${htmlEscape(params)}"><label for="key">Personal Torn API key</label><input id="key" name="key" type="password" autocomplete="off" required minlength="8"><button type="submit">Connect Torn account</button></form></body></html>`, { status: 200, headers });
  }

  if (request.method !== "POST") return text("Method not allowed.", 405, { Allow: "GET,POST" });

  const form = await request.formData();
  const cookies = parseCookies(request);
  const csrf = String(form.get("csrf") || "");
  if (!csrf || !cookies["__Host-torn-csrf"] || csrf !== cookies["__Host-torn-csrf"]) return text("Authorization session expired. Please restart the connection.", 400);

  const key = String(form.get("key") || "").trim();
  const query = String(form.get("oauth_params") || "");
  const authUrl = new URL(new URL(request.url).origin + "/authorize");
  authUrl.search = query.startsWith("?") ? query : `?${query}`;
  let approvedRequest;
  try {
    approvedRequest = await parseAuthRequestCompat(oauth, new Request(authUrl, { method: "GET", headers: request.headers }));
  } catch (error) {
    return authorizeErrorResponse(error);
  }

  const user = await validateTornKey(env, key);
  if (!user) return text("The Torn API key could not be validated. Check the key and try again.", 401, { "Set-Cookie": clearCsrfCookie() });

  const grantedScopes = approvedRequest.scope.filter(scope => scope === MCP_SCOPE);
  if (!grantedScopes.includes(MCP_SCOPE)) return text("The requested MCP permission is unavailable.", 400, { "Set-Cookie": clearCsrfCookie() });

  try {
    const { redirectTo } = await oauth.completeAuthorization({
      request: approvedRequest,
      userId: user.id,
      metadata: { clientName: client.clientName || "ChatGPT", tornUserId: user.id, tornDisplayName: user.name },
      scope: grantedScopes,
      props: { tornApiKey: key, tornUserId: user.id, displayName: user.name }
    });

    if (!redirectTo) {
      return text("OAuth authorization completed but no callback redirect was returned.", 500, {
        "Set-Cookie": clearCsrfCookie()
      });
    }

    const safeRedirect = htmlEscape(redirectTo);
    return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="0;url=${safeRedirect}"><title>Connecting to ChatGPT</title></head><body><p>Authorization successful. Returning to ChatGPT...</p><p>If you are not redirected automatically, <a href="${safeRedirect}">continue to ChatGPT</a>.</p><script>window.location.replace(${JSON.stringify(redirectTo)});</script></body></html>`, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": clearCsrfCookie(),
        ...CORS
      }
    });
  } catch (error) {
    return text("OAuth authorization could not be completed: " + safeError(error), 500, {
      "Set-Cookie": clearCsrfCookie()
    });
  }
}

const OAUTH_RESOURCE_METADATA =
  "https://tornapi-plugin-gpt.kboone801.workers.dev/.well-known/oauth-protected-resource/mcp";

const OAUTH_CHALLENGE =
  `Bearer resource_metadata="${OAUTH_RESOURCE_METADATA}", error="invalid_token", error_description="OAuth authorization is required to use Torn API V2."`;

function oauthRequiredResult() {
  return {
    content: [{ type: "text", text: "Authentication required. Connect your personal Torn API account to continue." }],
    isError: true,
    _meta: {
      "mcp/www_authenticate": [OAUTH_CHALLENGE]
    }
  };
}

async function buildMcpHandler(env, props) {
  const document = await getOpenApi(env);
  const operations = discover(document);
  const key = props?.tornApiKey;
  const server = new McpServer({ name: "tornapi-plugin-gpt", version: "2.0.0" });

  for (const item of operations) {
    server.registerTool(item.name, {
      title: item.operation.summary || item.name,
      description: [item.operation.summary, item.operation.description, `Torn API ${item.method} ${item.path}`].filter(Boolean).join("\n\n"),
      inputSchema: fromJsonSchema(inputSchema(item.operation)),
      annotations: {
        readOnlyHint: !["POST", "PUT", "PATCH", "DELETE"].includes(item.method),
        openWorldHint: true
      },
      securitySchemes: [{ type: "oauth2", scopes: [MCP_SCOPE] }]
    }, async (args) => {
      if (!validKey(key)) return oauthRequiredResult();
      return callTorn(env, key, item.operation, args || {});
    });
  }

  return createMcpHandler(async () => server, { legacy: "stateless" });
}

const apiHandler = {
  async fetch(request, env, ctx) {
    const handler = await buildMcpHandler(env, ctx.props || {});
    return handler.fetch(request);
  }
};

const defaultHandler = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return authorize(request, env);
    if (url.pathname === "/health") return json({ ok: true, service: "tornapi-plugin-gpt", runtime: "cloudflare-workers" });
    if (url.pathname === "/openapi") {
      try {
        const document = await getOpenApi(env);
        const operations = discover(document);
        return json({ ok: true, openapi: document.openapi, pathCount: Object.keys(document.paths || {}).length, operationCount: operations.length, source: envValue(env, "TORN_OPENAPI_URL", DEFAULT_OPENAPI_URL), keyInjection: true });
      } catch (error) {
        return json({ ok: false, error: safeError(error) }, 502);
      }
    }
    return text("Not found.", 404);
  }
};

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  scopesSupported: [MCP_SCOPE],
  resourceMetadata: {
    resource: MCP_RESOURCE,
    authorization_servers: [new URL(MCP_RESOURCE).origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Torn API V2"
  },
  requiredScopes: [MCP_SCOPE],
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/oauth/register"
});
