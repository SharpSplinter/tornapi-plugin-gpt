const OPENAPI_URL = "https://www.torn.com/swagger/openapi.json";
const API_BASE = "https://api.torn.com/v2";
const USER_AGENT = "TornChatGPT/1.0";
const OPENAPI_TTL_MS = 15 * 60 * 1000;
const METHODS = new Set(["get","post","put","patch","delete","head","options","trace"]);

let schemaCache = { document: null, fetchedAt: 0 };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,HEAD,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Accept,Authorization,Content-Type,Last-Event-ID,MCP-Protocol-Version,Mcp-Session-Id",
  "Access-Control-Expose-Headers": "Mcp-Session-Id,MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin"
};

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS, ...headers }
  });

const text = (body, status = 200, headers = {}) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS, ...headers }
  });

function safeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(/([?&]key=)[^&\s]+/gi, "$1[REDACTED]");
  message = message.replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
  return message.slice(0, 1000);
}

function credential(request) {
  const value = request.headers.get("Authorization");
  if (!value) return null;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function validKey(key) {
  return !!key && key.length >= 8 && key.length <= 512 && /^[A-Za-z0-9_-]+$/.test(key);
}

async function getOpenApi(request) {
  const now = Date.now();
  if (schemaCache.document && now - schemaCache.fetchedAt < OPENAPI_TTL_MS) {
    return schemaCache.document;
  }

  const response = await fetch(OPENAPI_URL, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    cf: { cacheTtl: 900 }
  });

  if (!response.ok) {
    throw new Error(`Torn OpenAPI fetch failed: HTTP ${response.status}`);
  }

  const document = await response.json();
  if (!document || typeof document !== "object" || !document.paths) {
    throw new Error("Torn returned an invalid OpenAPI document.");
  }

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

  const filtered = parameters.filter(p =>
    !(p?.in === "query" && (
      p.name === "key" ||
      p.name === "ApiKeyMinimal" ||
      p.name === "ApiKeyLimited" ||
      p.name === "ApiKeyPublic"
    ))
  );

  filtered.push({
    name: "key",
    in: "query",
    required: true,
    description: "Your individual, personal Torn API key.",
    schema: { type: "string" }
  });

  return {
    ...operation,
    parameters: filtered,
    "x-torn-path": path,
    "x-torn-method": method.toUpperCase()
  };
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
    properties[p.name] = {
      ...schema,
      description: p.description || `${p.in || "query"} parameter: ${p.name}`
    };
    if (p.required) required.push(p.name);
  }

  if (operation.requestBody) {
    properties.body = {
      type: "object",
      description: "Request body defined by the Torn OpenAPI operation."
    };
  }

  return { type: "object", properties, required, additionalProperties: false };
}

function substitutePath(path, args) {
  return path.replace(/\{([^}]+)\}/g, (_, name) => {
    if (args[name] === undefined || args[name] === null) {
      throw new Error(`Missing path parameter: ${name}`);
    }
    return encodeURIComponent(String(args[name]));
  });
}

async function callTorn(request, operation, args) {
  const key = credential(request);
  if (!validKey(key)) {
    return {
      isError: true,
      content: [{ type: "text", text: "Please provide your personal Torn API key to authenticate this session." }]
    };
  }

  const url = new URL(API_BASE + substitutePath(operation.path, args || {}));

  for (const p of operation.parameters || []) {
    if (p.in !== "query" || p.name === "key") continue;
    const value = args?.[p.name];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(p.name, String(item));
    } else {
      url.searchParams.set(p.name, String(value));
    }
  }

  url.searchParams.set("key", key);

  const init = {
    method: operation.method,
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT
    }
  };

  if (args?.body !== undefined && operation.requestBody) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(args.body);
  }

  const response = await fetch(url, init);
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("json")
    ? await response.json()
    : await response.text();

  return {
    isError: !response.ok,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}

async function listTools(request) {
  const document = await getOpenApi(request);
  return discover(document).map(item => ({
    name: item.name,
    description: [
      item.operation.summary,
      item.operation.description,
      `Torn API ${item.method} ${item.path}`
    ].filter(Boolean).join("\n\n"),
    inputSchema: inputSchema(item.operation)
  }));
}

async function callTool(request, name, args) {
  const document = await getOpenApi(request);
  const operation = discover(document).find(item => item.name === name);
  if (!operation) throw new Error(`Unknown Torn operation: ${name}`);
  return callTorn(request, operation, args || {});
}

async function mcp(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return text("MCP endpoint requires POST.", 405);

  let message;
  try {
    message = await request.json();
  } catch {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  const id = message.id ?? null;

  try {
    switch (message.method) {
      case "initialize":
        return json({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "tornapi-plugin-gpt", version: "1.0.0" }
          }
        }, 200, { "MCP-Protocol-Version": "2025-03-26" });

      case "notifications/initialized":
        return new Response(null, { status: 202, headers: CORS });

      case "ping":
        return json({ jsonrpc: "2.0", id, result: {} });

      case "tools/list":
        return json({
          jsonrpc: "2.0",
          id,
          result: { tools: await listTools(request) }
        });

      case "tools/call": {
        const params = message.params || {};
        const result = await callTool(request, params.name, params.arguments || {});
        return json({ jsonrpc: "2.0", id, result });
      }

      default:
        return json({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${message.method}` }
        }, 404);
    }
  } catch (error) {
    return json({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: safeError(error) }
    }, 500);
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") return mcp(request);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "tornapi-plugin-gpt", runtime: "cloudflare-workers" });
    }

    if (url.pathname === "/openapi") {
      try {
        const document = await getOpenApi(request);
        const operations = discover(document);
        return json({
          ok: true,
          openapi: document.openapi,
          pathCount: Object.keys(document.paths || {}).length,
          operationCount: operations.length,
          source: OPENAPI_URL,
          keyInjection: true
        });
      } catch (error) {
        return json({ ok: false, error: safeError(error) }, 502);
      }
    }

    return text("Not found.", 404);
  }
};
