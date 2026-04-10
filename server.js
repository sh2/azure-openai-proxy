const http = require("node:http");
const https = require("node:https");
const { pipeline } = require("node:stream");

const EMPTY_BODY = Buffer.alloc(0);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const SENSITIVE_HEADERS = new Set(["api-key", "authorization", "proxy-authorization"]);
const SUPPORTED_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const SUPPORTED_VERBOSITY_LEVELS = new Set(["low", "medium", "high"]);

function exitWithConfigurationError(message) {
  console.error(message);
  process.exit(1);
}

function resolveSupportedValue(value, supportedValues, fallbackValue) {
  return supportedValues.has(value) ? value : fallbackValue;
}

function parseOriginUrl(configuredOrigin) {
  if (!configuredOrigin) {
    exitWithConfigurationError("Missing upstream origin. Set AZURE_OPENAI_ORIGIN.");
  }

  let originUrl;

  try {
    originUrl = new URL(configuredOrigin);
  } catch (error) {
    exitWithConfigurationError(`Invalid upstream origin: ${configuredOrigin}`);
  }

  if (!["http:", "https:"].includes(originUrl.protocol)) {
    exitWithConfigurationError(
      `Unsupported upstream protocol "${originUrl.protocol}". Use http:// or https://.`
    );
  }

  return originUrl;
}

function loadConfig() {
  return {
    port: Number(process.env.PORT || 18080),
    configuredReasoningEffort: resolveSupportedValue(
      process.env.AZURE_OPENAI_REASONING_EFFORT,
      SUPPORTED_REASONING_EFFORTS,
      "medium"
    ),
    configuredVerbosity: resolveSupportedValue(
      process.env.AZURE_OPENAI_VERBOSITY,
      SUPPORTED_VERBOSITY_LEVELS,
      "medium"
    ),
    originUrl: parseOriginUrl(process.env.AZURE_OPENAI_ORIGIN),
  };
}

const { port, configuredReasoningEffort, configuredVerbosity, originUrl } = loadConfig();

// URL helpers

function mergePathnames(basePathname, requestPathname) {
  const trimmedBase = basePathname.replace(/\/+$/, "");
  const trimmedRequest = requestPathname.replace(/^\/+/, "");

  if (!trimmedBase) {
    return `/${trimmedRequest}`;
  }

  if (!trimmedRequest) {
    return trimmedBase || "/";
  }

  return `${trimmedBase}/${trimmedRequest}`;
}

function mergeSearchParams(baseSearchParams, requestSearchParams) {
  const mergedSearchParams = new URLSearchParams(baseSearchParams);

  for (const key of new Set([...requestSearchParams.keys()])) {
    mergedSearchParams.delete(key);

    for (const value of requestSearchParams.getAll(key)) {
      mergedSearchParams.append(key, value);
    }
  }

  return mergedSearchParams.toString();
}

function buildTargetUrl(originUrl, incomingUrl) {
  const targetUrl = new URL(originUrl.href);

  targetUrl.pathname = mergePathnames(originUrl.pathname, incomingUrl.pathname);
  targetUrl.search = mergeSearchParams(originUrl.searchParams, incomingUrl.searchParams);

  return targetUrl;
}

function selectUpstreamClient(targetUrl) {
  return targetUrl.protocol === "https:" ? https : http;
}

// Header and content helpers

function getHeaderValue(headerValue) {
  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }

  return headerValue;
}

function isJsonContentType(contentType) {
  return (
    typeof contentType === "string" &&
    /\b(application\/json|[^;\s]+\/[^;\s]+\+json)\b/i.test(contentType)
  );
}

// Remove hop-by-hop headers and recalculate content-length when the body changes.
function sanitizeHeaders(headers, upstreamHost, requestBody) {
  const nextHeaders = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerValue === undefined) {
      continue;
    }

    const normalizedHeaderName = headerName.toLowerCase();

    if (
      normalizedHeaderName === "host" ||
      normalizedHeaderName === "content-length" ||
      HOP_BY_HOP_HEADERS.has(normalizedHeaderName)
    ) {
      continue;
    }

    nextHeaders[headerName] = headerValue;
  }

  nextHeaders.host = upstreamHost;

  if (requestBody !== undefined) {
    nextHeaders["content-length"] = String(requestBody.length);
  }

  return nextHeaders;
}

function sanitizeResponseHeaders(headers) {
  const nextHeaders = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerValue === undefined) {
      continue;
    }

    if (HOP_BY_HOP_HEADERS.has(headerName.toLowerCase())) {
      continue;
    }

    nextHeaders[headerName] = headerValue;
  }

  return nextHeaders;
}

function redactHeaders(headers) {
  const nextHeaders = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerValue === undefined) {
      continue;
    }

    nextHeaders[headerName] = SENSITIVE_HEADERS.has(headerName.toLowerCase())
      ? "[redacted]"
      : headerValue;
  }

  return nextHeaders;
}

// Request logging helpers

function summarizeBodyForLogging(value) {
  if (Array.isArray(value)) {
    return value.map((item) => summarizeBodyForLogging(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const summarizedValue = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === "messages" && Array.isArray(nestedValue)) {
      if (nestedValue.length === 0) {
        summarizedValue[key] = [];
      } else if (nestedValue.length === 1) {
        summarizedValue[key] = [summarizeBodyForLogging(nestedValue[0])];
      } else {
        summarizedValue[key] = [
          `[omitted ${nestedValue.length - 1} message(s)]`,
          summarizeBodyForLogging(nestedValue[nestedValue.length - 1]),
        ];
      }
      continue;
    }

    if (key === "tools") {
      const toolCount = Array.isArray(nestedValue) ? nestedValue.length : 1;
      summarizedValue[key] = `[omitted ${toolCount} tool(s)]`;
      continue;
    }

    summarizedValue[key] = summarizeBodyForLogging(nestedValue);
  }

  return summarizedValue;
}

function formatRequestBody(headers, requestBody) {
  if (requestBody.length === 0) {
    return "(empty)";
  }

  const contentType = getHeaderValue(headers["content-type"]);
  const bodyText = requestBody.toString("utf8");

  if (isJsonContentType(contentType)) {
    try {
      return JSON.stringify(summarizeBodyForLogging(JSON.parse(bodyText)), null, 2);
    } catch (error) {
      return bodyText;
    }
  }

  if (
    typeof contentType === "string" &&
    /^text\/|application\/(xml|x-www-form-urlencoded)/i.test(contentType)
  ) {
    return bodyText;
  }

  return `<${requestBody.length} bytes>`;
}

function logForwardedRequest(request, incomingUrl, forwardedHeaders, requestBody, rewriteNote) {
  console.log(`[${new Date().toISOString()}] --- Forwarding client request ---`);
  console.log(`${request.method} ${incomingUrl.pathname}${incomingUrl.search}`);
  console.log("Headers:");
  console.log(JSON.stringify(redactHeaders(forwardedHeaders), null, 2));
  console.log("Body:");
  console.log(formatRequestBody(forwardedHeaders, requestBody));

  if (rewriteNote) {
    console.log(rewriteNote);
  }
}

// Chat Completions compatibility rewriting

function getRequestRewriteTarget(pathname) {
  if (/\/chat\/completions(?:\/|$)/i.test(pathname)) {
    return "chat-completions";
  }

  return "none";
}

// Adapt legacy client payloads only for Chat Completions requests.
function applyLatestApiCompatibility(pathname, headers, requestBody) {
  const contentType = getHeaderValue(headers["content-type"]);
  const rewriteTarget = getRequestRewriteTarget(pathname);
  const rewriteNotes = [];

  if (rewriteTarget === "none" || !isJsonContentType(contentType) || requestBody.length === 0) {
    return { requestBody, rewriteNote: "" };
  }

  let parsedBody;

  try {
    parsedBody = JSON.parse(requestBody.toString("utf8"));
  } catch (error) {
    return { requestBody, rewriteNote: "" };
  }

  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) {
    return { requestBody, rewriteNote: "" };
  }

  const nextBody = { ...parsedBody };

  if (nextBody.temperature !== undefined) {
    delete nextBody.temperature;
    rewriteNotes.push("Removed temperature for Chat Completions API.");
  }

  if (nextBody.top_p !== undefined) {
    delete nextBody.top_p;
    rewriteNotes.push("Removed top_p for Chat Completions API.");
  }

  if (nextBody.reasoning_effort === undefined) {
    nextBody.reasoning_effort = configuredReasoningEffort;
    rewriteNotes.push(`Injected reasoning_effort=${configuredReasoningEffort} for Chat Completions API.`);
  }

  if (nextBody.verbosity === undefined) {
    nextBody.verbosity = configuredVerbosity;
    rewriteNotes.push(`Injected verbosity=${configuredVerbosity} for Chat Completions API.`);
  }

  if (rewriteNotes.length === 0) {
    return { requestBody, rewriteNote: "" };
  }

  return {
    requestBody: Buffer.from(JSON.stringify(nextBody)),
    rewriteNote: rewriteNotes.join("\n"),
  };
}

function writeProxyError(response, message) {
  if (response.headersSent) {
    response.destroy();
    return;
  }

  response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ error: message }));
}

function createUpstreamRequest({
  client,
  targetUrl,
  request,
  response,
  forwardedHeaders,
  setUpstreamResponse,
}) {
  const upstreamRequest = client.request(
    targetUrl,
    {
      method: request.method,
      headers: forwardedHeaders,
    },
    (receivedUpstreamResponse) => {
      setUpstreamResponse(receivedUpstreamResponse);
      response.writeHead(
        receivedUpstreamResponse.statusCode || 502,
        sanitizeResponseHeaders(receivedUpstreamResponse.headers)
      );

      pipeline(receivedUpstreamResponse, response, (error) => {
        if (error && !response.destroyed) {
          console.error(`Response pipeline failed: ${error.message}`);
        }
      });
    }
  );

  upstreamRequest.on("error", (error) => {
    console.error(`Upstream request failed: ${error.message}`);
    writeProxyError(response, "Failed to reach upstream Azure OpenAI origin.");
  });

  return upstreamRequest;
}

function handleProxyRequest(request, response) {
  const incomingUrl = new URL(request.url, "http://localhost");
  const targetUrl = buildTargetUrl(originUrl, incomingUrl);
  const client = selectUpstreamClient(targetUrl);
  let upstreamResponse;
  let upstreamRequest;

  function startUpstreamRequest(forwardedHeaders) {
    upstreamRequest = createUpstreamRequest({
      client,
      targetUrl,
      request,
      response,
      forwardedHeaders,
      setUpstreamResponse(receivedUpstreamResponse) {
        upstreamResponse = receivedUpstreamResponse;
      },
    });

    return upstreamRequest;
  }

  request.on("aborted", () => {
    if (upstreamRequest && !upstreamRequest.destroyed) {
      upstreamRequest.destroy();
    }
  });

  response.on("close", () => {
    if (!response.writableFinished) {
      if (upstreamRequest && !upstreamRequest.destroyed) {
        upstreamRequest.destroy();
      }

      if (upstreamResponse && !upstreamResponse.destroyed) {
        upstreamResponse.destroy();
      }
    }
  });

  if (request.method === "GET" || request.method === "HEAD") {
    const forwardedHeaders = sanitizeHeaders(request.headers, targetUrl.host);

    logForwardedRequest(request, incomingUrl, forwardedHeaders, EMPTY_BODY, "");
    startUpstreamRequest(forwardedHeaders).end();
    return;
  }

  const requestChunks = [];

  request.on("data", (chunk) => {
    requestChunks.push(chunk);
  });

  request.on("end", () => {
    const originalRequestBody = Buffer.concat(requestChunks);
    const { requestBody, rewriteNote } = applyLatestApiCompatibility(
      incomingUrl.pathname,
      request.headers,
      originalRequestBody
    );
    const forwardedHeaders = sanitizeHeaders(request.headers, targetUrl.host, requestBody);

    logForwardedRequest(request, incomingUrl, forwardedHeaders, requestBody, rewriteNote);
    startUpstreamRequest(forwardedHeaders).end(requestBody);
  });

  request.on("error", (error) => {
    if (upstreamRequest && !upstreamRequest.destroyed) {
      console.error(`Request pipeline failed: ${error.message}`);
      upstreamRequest.destroy(error);
    }
  });
}

const server = http.createServer(handleProxyRequest);

server.listen(port, () => {
  console.log(`Azure OpenAI proxy listening on http://localhost:${port}`);
  console.log(`Forwarding requests to ${originUrl.origin}${originUrl.pathname}`);
  console.log(`Configured reasoning effort: ${configuredReasoningEffort}`);
  console.log(`Configured verbosity: ${configuredVerbosity}`);
  console.log("Request parameter rewriting is applied only to Chat Completions API requests.");
});
