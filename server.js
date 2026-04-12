const http = require("node:http");
const https = require("node:https");
const { Transform, pipeline } = require("node:stream");

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
const DEBUG_RESPONSE_LOGGING = /^(1|true|yes|on)$/i.test(
  process.env.AZURE_OPENAI_DEBUG_LOGS || ""
);

function exitWithConfigurationError(message) {
  console.error(message);
  process.exit(1);
}

function resolveSupportedValue(value, supportedValues, fallbackValue) {
  return supportedValues.has(value) ? value : fallbackValue;
}

function debugLog(message) {
  if (!DEBUG_RESPONSE_LOGGING) {
    return;
  }

  console.log(`[${new Date().toISOString()}] ${message}`);
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

const {
  port,
  configuredReasoningEffort,
  configuredVerbosity,
  originUrl,
} = loadConfig();

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

function isEventStreamContentType(contentType) {
  return typeof contentType === "string" && /\btext\/event-stream\b/i.test(contentType);
}

function isTextContentType(contentType) {
  return (
    typeof contentType === "string" &&
    (/^text\//i.test(contentType) ||
      /application\/(xml|x-www-form-urlencoded|javascript|ecmascript)/i.test(contentType))
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

  debugLog(
    `Forwarded request prepared: method=${request.method}, path=${incomingUrl.pathname}${incomingUrl.search}, bodyBytes=${requestBody.length}`
  );
}

function extractUsageFromDataPayload(dataPayload) {
  if (!dataPayload || dataPayload === "[DONE]") {
    return undefined;
  }

  try {
    const parsedChunk = JSON.parse(dataPayload);

    if (parsedChunk && typeof parsedChunk === "object" && parsedChunk.usage !== undefined) {
      return parsedChunk.usage;
    }
  } catch (error) {
    return undefined;
  }

  return undefined;
}

function extractUsageFromResponseBody(headers, responseBody) {
  if (responseBody.length === 0) {
    return null;
  }

  const contentType = getHeaderValue(headers["content-type"]);
  const bodyText = responseBody.toString("utf8");

  if (isJsonContentType(contentType)) {
    try {
      const parsedBody = JSON.parse(bodyText);
      return parsedBody && typeof parsedBody === "object" ? parsedBody.usage ?? null : null;
    } catch (error) {
      return null;
    }
  }

  if (!isEventStreamContentType(contentType) && !isTextContentType(contentType)) {
    return null;
  }

  let usage = null;

  for (const line of bodyText.split(/\r?\n/)) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const chunkUsage = extractUsageFromDataPayload(line.slice(5).trim());

    if (chunkUsage !== undefined) {
      usage = chunkUsage;
    }
  }

  return usage;
}

function logUpstreamResponseSummary(receivedUpstreamResponse, usage) {
  const summary = {
    status: receivedUpstreamResponse.statusCode || 502,
    usage,
  };

  console.log(`[${new Date().toISOString()}] --- Upstream response summary ---`);
  console.log(JSON.stringify(summary, null, 2));
}

function logIncompleteUpstreamResponseSummary(receivedUpstreamResponse, responseLogState, reason) {
  if (responseLogState.summaryLogged) {
    return;
  }

  responseLogState.summaryLogged = true;

  const summary = {
    status: receivedUpstreamResponse?.statusCode || 502,
    usage: responseLogState.usage,
    partial: true,
    reason,
    chunkCount: responseLogState.chunkCount,
    upstreamComplete: receivedUpstreamResponse?.complete ?? null,
  };

  console.log(`[${new Date().toISOString()}] --- Upstream response terminated early ---`);
  console.log(JSON.stringify(summary, null, 2));
}

function createResponseLogState() {
  return {
    chunkCount: 0,
    usage: null,
    summaryLogged: false,
  };
}

function forwardBufferedResponse(receivedUpstreamResponse, response, responseLogState) {
  const responseChunks = [];

  debugLog(
    `Buffered upstream response handler attached: status=${receivedUpstreamResponse.statusCode || 502}, contentType=${getHeaderValue(receivedUpstreamResponse.headers["content-type"]) || "<unknown>"}`
  );

  receivedUpstreamResponse.on("data", (chunk) => {
    responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    responseLogState.chunkCount += 1;
  });

  receivedUpstreamResponse.on("end", () => {
    debugLog("Buffered upstream response end event fired");
    const responseBody = Buffer.concat(responseChunks);
    const usage = extractUsageFromResponseBody(receivedUpstreamResponse.headers, responseBody);
    responseLogState.usage = usage;
    responseLogState.summaryLogged = true;

    debugLog(
      `Buffered upstream response ended: bodyBytes=${responseBody.length}, responseDestroyed=${response.destroyed}, writableFinished=${response.writableFinished}`
    );

    logUpstreamResponseSummary(receivedUpstreamResponse, usage);

    if (!response.destroyed) {
      response.end(responseBody);
    }
  });

  receivedUpstreamResponse.on("error", (error) => {
    debugLog(`Buffered upstream response error: ${error.message}`);

    if (!response.destroyed) {
      console.error(`Response pipeline failed: ${error.message}`);
      response.destroy(error);
    }
  });

  receivedUpstreamResponse.on("close", () => {
    debugLog(
      `Buffered upstream response close event fired: destroyed=${receivedUpstreamResponse.destroyed}, complete=${receivedUpstreamResponse.complete}`
    );
  });
}

function createResponseLoggingTap(receivedUpstreamResponse, responseLogState) {
  let pendingText = "";
  let usage = null;

  debugLog(
    `Streaming upstream response tap created: status=${receivedUpstreamResponse.statusCode || 502}, contentType=${getHeaderValue(receivedUpstreamResponse.headers["content-type"]) || "<unknown>"}`
  );

  function collectUsageFromText(text, flushRemainder) {
    pendingText += text;
    const lines = pendingText.split(/\r?\n/);

    pendingText = flushRemainder ? "" : lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data:")) {
        continue;
      }

      const chunkUsage = extractUsageFromDataPayload(line.slice(5).trim());

      if (chunkUsage !== undefined) {
        usage = chunkUsage;
        responseLogState.usage = chunkUsage;
      }
    }
  }

  return new Transform({
    transform(chunk, encoding, callback) {
      const chunkText = Buffer.isBuffer(chunk)
        ? chunk.toString("utf8")
        : Buffer.from(chunk, encoding).toString("utf8");

      responseLogState.chunkCount += 1;

      collectUsageFromText(chunkText, false);
      callback(null, chunk);
    },
    flush(callback) {
      try {
        debugLog(
          `Streaming upstream response flush entered: pendingTextBytes=${Buffer.byteLength(pendingText)}, collectedUsage=${usage === null ? "null" : JSON.stringify(usage)}`
        );
        collectUsageFromText("", true);
        responseLogState.summaryLogged = true;
        logUpstreamResponseSummary(receivedUpstreamResponse, usage);
        debugLog("Streaming upstream response flush completed");
      } catch (error) {
        debugLog(`Response logging failed during flush: ${error.message}`);
        console.error(`Response logging failed: ${error.message}`);
      }

      callback();
    },
  });
}

function attachUpstreamResponseDebugHandlers(receivedUpstreamResponse) {
  receivedUpstreamResponse.on("end", () => {
    debugLog(
      `Upstream response end event fired: destroyed=${receivedUpstreamResponse.destroyed}, complete=${receivedUpstreamResponse.complete}`
    );
  });

  receivedUpstreamResponse.on("close", () => {
    debugLog(
      `Upstream response close event fired: destroyed=${receivedUpstreamResponse.destroyed}, complete=${receivedUpstreamResponse.complete}`
    );
  });
}

function forwardUpstreamResponse(receivedUpstreamResponse, response, responseLogState) {
  const contentType = getHeaderValue(receivedUpstreamResponse.headers["content-type"]);

  debugLog(
    `Forwarding upstream response: status=${receivedUpstreamResponse.statusCode || 502}, contentType=${contentType || "<unknown>"}, mode=${isEventStreamContentType(contentType) ? "streaming" : "buffered"}`
  );

  if (isEventStreamContentType(contentType)) {
    pipeline(
      receivedUpstreamResponse,
      createResponseLoggingTap(receivedUpstreamResponse, responseLogState),
      response,
      (error) => {
        if (error && !response.destroyed) {
          debugLog(`Streaming response pipeline failed: ${error.message}`);
          console.error(`Response pipeline failed: ${error.message}`);
        }
      }
    );
    return;
  }

  forwardBufferedResponse(receivedUpstreamResponse, response, responseLogState);
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
  responseLogState,
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
      debugLog(
        `Upstream response received: status=${receivedUpstreamResponse.statusCode || 502}, contentType=${getHeaderValue(receivedUpstreamResponse.headers["content-type"]) || "<unknown>"}`
      );
      attachUpstreamResponseDebugHandlers(receivedUpstreamResponse);

      response.writeHead(
        receivedUpstreamResponse.statusCode || 502,
        sanitizeResponseHeaders(receivedUpstreamResponse.headers)
      );

      forwardUpstreamResponse(receivedUpstreamResponse, response, responseLogState);
    }
  );

  upstreamRequest.on("error", (error) => {
    debugLog(`Upstream request error: ${error.message}`);
    console.error(`Upstream request failed: ${error.message}`);
    writeProxyError(response, "Failed to reach upstream Azure OpenAI origin.");
  });

  return upstreamRequest;
}

function handleProxyRequest(request, response) {
  const incomingUrl = new URL(request.url, "http://localhost");
  const requestPath = `${incomingUrl.pathname}${incomingUrl.search}`;
  const targetUrl = buildTargetUrl(originUrl, incomingUrl);
  const client = selectUpstreamClient(targetUrl);
  let upstreamResponse;
  let upstreamRequest;
  const responseLogState = createResponseLogState();

  debugLog(
    `Incoming request: method=${request.method}, path=${requestPath}, target=${targetUrl.href}`
  );

  function startUpstreamRequest(forwardedHeaders) {
    upstreamRequest = createUpstreamRequest({
      client,
      targetUrl,
      request,
      response,
      forwardedHeaders,
      responseLogState,
      setUpstreamResponse(receivedUpstreamResponse) {
        upstreamResponse = receivedUpstreamResponse;
      },
    });

    return upstreamRequest;
  }

  request.on("aborted", () => {
    debugLog(`Client request aborted: method=${request.method}, path=${requestPath}`);

    if (upstreamRequest && !upstreamRequest.destroyed) {
      upstreamRequest.destroy();
    }
  });

  response.on("close", () => {
    debugLog(
      `Proxy response closed: method=${request.method}, path=${requestPath}, writableFinished=${response.writableFinished}, upstreamResponseDestroyed=${upstreamResponse ? upstreamResponse.destroyed : "n/a"}`
    );

    if (!response.writableFinished) {
      if (upstreamResponse) {
        logIncompleteUpstreamResponseSummary(
          upstreamResponse,
          responseLogState,
          "downstream closed before upstream completed"
        );
      }

      if (upstreamRequest && !upstreamRequest.destroyed) {
        upstreamRequest.destroy();
      }

      if (upstreamResponse && !upstreamResponse.destroyed) {
        upstreamResponse.destroy();
      }
    }
  });

  response.on("finish", () => {
    debugLog(
      `Proxy response finish event fired: method=${request.method}, path=${requestPath}, writableFinished=${response.writableFinished}`
    );
  });

  response.on("error", (error) => {
    debugLog(`Proxy response error: ${error.message}`);
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
    debugLog(`Incoming request error: method=${request.method}, path=${requestPath}, error=${error.message}`);

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
  if (DEBUG_RESPONSE_LOGGING) {
    console.log("Debug response logging is enabled via AZURE_OPENAI_DEBUG_LOGS.");
  }
});
