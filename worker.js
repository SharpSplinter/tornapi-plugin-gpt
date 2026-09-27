import { createMcpHandler, fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { AuthorizationError, OAuthProvider } from "@cloudflare/workers-oauth-provider";

const DEFAULT_OPENAPI_URL = "https://www.torn.com/swagger/openapi.json";
const DEFAULT_API_BASE = "https://api.torn.com/v2";
const DEFAULT_USER_AGENT = "TornChatGPT/1.0";
const OPENAPI_TTL_MS = 15 * 60 * 1000;
const METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "trace"]);
const MCP_RESOURCE = "https://tornapi-plugin-gpt.kboone801.workers.dev/mcp";
const MCP_SCOPE = "mcp:read";
const BUILD_ID = "7462c744b86df03efa0e5092e80231c3766dd2a3";

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
  const init = { method: operation.method, headers: { Accept: "application/json", Authorization: `ApiKey ${key}`, "User-Agent": envValue(env, "TORN_USER_AGENT", DEFAULT_USER_AGENT) } };
  if (args?.body !== undefined && operation.requestBody) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(args.body);
  }

  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json") ? await response.json() : await response.text();
  return { isError: !response.ok, content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Upstream request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function validateTornKey(env, key) {
  if (!validKey(key)) return null;
  const url = new URL(`${envValue(env, "TORN_API_BASE", DEFAULT_API_BASE)}/user/profile`);
  const response = await fetchWithTimeout(url, {
    headers: { Accept: "application/json", Authorization: `ApiKey ${key}`, "User-Agent": envValue(env, "TORN_USER_AGENT", DEFAULT_USER_AGENT) }
  }, 12000);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error?.error || payload?.error?.description || payload?.error || `HTTP ${response.status}`;
    throw new Error(`Torn rejected the API key: ${String(detail).slice(0, 300)}`);
  }
  if (!payload || typeof payload !== "object") return null;
  const profile = payload?.profile ?? payload?.user ?? payload;
  const id = profile?.id ?? profile?.user_id;
  if (id === undefined || id === null) return null;
  return { id: String(id), name: typeof profile?.name === "string" ? profile.name : `Torn user ${id}` };
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}

async function parseAuthRequestCompat(oauth, request) {
  const url = new URL(request.url);
  if (url.searchParams.get("client_id") && !url.searchParams.get("response_type")) {
    url.searchParams.set("response_type", "code");
    return oauth.parseAuthRequest(new Request(url, request));
  }
  return oauth.parseAuthRequest(request);
}

function authorizeFailure(stage, error, status = 500) {
  const message = htmlEscape(safeError(error));
  const retry = status >= 500
    ? "<p>Return to ChatGPT and start the account connection again.</p>"
    : "";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Torn API V2 authorization error</title><style>body{font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;line-height:1.5}code{word-break:break-word;background:#f4f4f4;padding:2px 5px;border-radius:4px}a{display:inline-block;margin-top:12px}</style></head><body><h1>Connection could not be completed</h1><p><strong>Stage:</strong> ${htmlEscape(stage)}</p><p><strong>Details:</strong> <code>${message}</code></p>${retry}<p><a href="/authorize">Restart Torn authorization</a></p></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        ...CORS
      }
    }
  );
}

async function withTimeout(promise, timeoutMs, stage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${stage} timed out after ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function authorize(request, env) {
  const oauth = env.OAUTH_PROVIDER;

  if (!env.OAUTH_KV || typeof env.OAUTH_KV.put !== "function") {
    return authorizeFailure("OAuth storage", new Error("The OAUTH_KV binding is not available to this Worker deployment."), 500);
  }

  if (request.method === "GET") {
    let oauthRequest;
    let client;
    try {
      oauthRequest = await parseAuthRequestCompat(env, oauth, request);
      client = await oauth.lookupClient(oauthRequest.clientId);
      if (!client) return authorizeFailure("OAuth client", new Error("Unknown OAuth client."), 400);

      const handle = crypto.randomUUID();
      await env.OAUTH_KV.put(
        `oauth:consent:${handle}`,
        JSON.stringify({ authorizationUrl: (() => {
          const stored = new URL(request.url);
          stored.searchParams.set("client_id", oauthRequest.clientId);
          stored.searchParams.set("redirect_uri", oauthRequest.redirectUri);
          stored.searchParams.set("response_type", oauthRequest.responseType || "code");
          return stored.href;
        })() }),
        { expirationTtl: 600 }
      );

      const redirectHost = (() => {
        try { return new URL(oauthRequest.redirectUri).host; }
        catch { return "the requesting app"; }
      })();
      const scopes = oauthRequest.scope.filter(scope => scope === MCP_SCOPE);
      const headers = new Headers({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer"
      });

      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Torn API V2 authorization</title><style>body{font-family:system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 20px;line-height:1.5}input,button{font:inherit;width:100%;box-sizing:border-box;padding:12px;margin-top:8px}button{cursor:pointer}code{word-break:break-all}</style></head><body><h1>Torn API V2</h1><p><strong>${htmlEscape(client.clientName || "ChatGPT")}</strong> is requesting access for <code>${htmlEscape(redirectHost)}</code>.</p><p>Enter your personal Torn API key. It is validated directly with Torn and stored only inside the encrypted OAuth grant. It is never sent to ChatGPT as a tool argument.</p><p>Requested permission: ${htmlEscape(scopes.join(", ") || MCP_SCOPE)}</p><form method="post" action="/authorize"><input type="hidden" name="handle" value="${htmlEscape(handle)}"><label for="key">Personal Torn API key</label><input id="key" name="key" type="password" autocomplete="off" required minlength="8"><button type="submit">Connect Torn account</button></form></body></html>`,
        { status: 200, headers }
      );
    } catch (error) {
      if (error instanceof AuthorizationError) return authorizeFailure("OAuth authorization request", error, 400);
      return authorizeFailure("OAuth consent setup", error, 500);
    }
  }

  if (request.method !== "POST") {
    return text("Method not allowed.", 405, { Allow: "GET,POST" });
  }

  let form;
  try {
    form = await request.formData();
  } catch (error) {
    return authorizeFailure("Authorization form", error, 400);
  }

  const handle = String(form.get("handle") || "");
  const key = String(form.get("key") || "").trim();
  if (!handle) return authorizeFailure("Consent session", new Error("The authorization handle is missing. Start the connection again."), 400);

  let session;
  try {
    session = await env.OAUTH_KV.get(`oauth:consent:${handle}`, "json");
  } catch (error) {
    return authorizeFailure("OAuth storage lookup", error, 500);
  }
  if (!session?.authorizationUrl) {
    return authorizeFailure("Consent session", new Error("The authorization session expired. Start the connection again."), 400);
  }

  let approvedRequest;
  try {
    approvedRequest = await parseAuthRequestCompat(
      oauth,
      new Request(session.authorizationUrl, { method: "GET" })
    );
  } catch (error) {
    if (error instanceof AuthorizationError) return authorizeFailure("OAuth authorization request", error, 400);
    return authorizeFailure("OAuth request validation", error, 400);
  }

  let client;
  try {
    client = await oauth.lookupClient(approvedRequest.clientId);
  } catch (error) {
    return authorizeFailure("OAuth client lookup", error, 400);
  }
  if (!client) return authorizeFailure("OAuth client", new Error("Unknown OAuth client."), 400);

  let user;
  try {
    user = await validateTornKey(env, key);
  } catch (error) {
    return authorizeFailure("Torn API key validation", error, 502);
  }
  if (!user) {
    return authorizeFailure("Torn API key validation", new Error("The Torn API key could not be validated. Check the key and try again."), 401);
  }

  const grantedScopes = approvedRequest.scope.filter(scope => scope === MCP_SCOPE);
  if (!grantedScopes.includes(MCP_SCOPE)) {
    return authorizeFailure("OAuth scope", new Error("The requested MCP permission is unavailable."), 400);
  }

  try {
    const result = await withTimeout(oauth.completeAuthorization({
      request: approvedRequest,
      userId: user.id,
      metadata: {
        clientName: client.clientName || "ChatGPT",
        tornUserId: user.id,
        tornDisplayName: user.name
      },
      scope: grantedScopes,
      props: { tornApiKey: key, tornUserId: user.id, displayName: user.name },
      revokeExistingGrants: false
    }), 20000, "OAuth grant completion");

    await env.OAUTH_KV.delete(`oauth:consent:${handle}`);

    const headers = new Headers(CORS);
    headers.set("Location", result.redirectTo);
    headers.set("Cache-Control", "no-store");
    headers.set("Referrer-Policy", "no-referrer");
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return authorizeFailure("OAuth grant completion", error, 500);
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
      description: [item.operation.summary, item.operation.description, `Torn API ${item.method} ${item.path}`].filter(Boolean).join("\n"),
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
    if (url.pathname === "/health") return json({ ok: true, service: "tornapi-plugin-gpt", runtime: "cloudflare-workers", build: BUILD_ID });
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
  onError: (error) => {
    console.error("OAuth provider error", JSON.stringify({ code: error.code, description: error.description, internal: error.internal }));
  }
});
