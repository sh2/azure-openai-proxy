# azure-openai-proxy

## Overview

A small MIT-licensed Node.js proxy for Azure OpenAI clients that need lightweight compatibility handling for GPT-5-family Chat Completions requests.

This proxy sits between your application and Azure OpenAI, forwards requests to your configured Azure OpenAI resource origin, preserves the incoming request path, and rewrites **Chat Completions** request bodies when needed:

- injects `reasoning_effort` when missing
- injects `verbosity` when missing
- removes deprecated parameters such as `temperature` and `top_p`

It can be used in front of either Azure deployment-style paths or `/openai/v1`-style paths. It is intended as a compact compatibility layer, not a full API gateway.

## Quick start

Prerequisites:

- Node.js `>=18.0.0`
- No external runtime dependencies

Start the proxy with the minimum required configuration:

```bash
export AZURE_OPENAI_ORIGIN="https://<resource-name>.openai.azure.com"
npm start
```

Or use the sample script:

```bash
chmod +x start-sample.sh
AZURE_OPENAI_ORIGIN="https://<resource-name>.openai.azure.com" ./start-sample.sh
```

## What it does

- Forwards requests to the Azure OpenAI resource origin configured in `AZURE_OPENAI_ORIGIN`
- Preserves the incoming HTTP method, path, and query parameters
- Rewrites request bodies **only** for Chat Completions API paths
- Leaves other request bodies unchanged

Because the proxy preserves the incoming path, it can sit in front of either of these client styles:

- Azure deployment-style paths such as `/openai/deployments/<deployment-name>/chat/completions?api-version=...`
- Azure OpenAI v1-style paths such as `/openai/v1/chat/completions`

## Configuration

### Required

- `AZURE_OPENAI_ORIGIN`
  - Example: `https://<resource-name>.openai.azure.com`
  - Must use `http://` or `https://`
  - Set this to the Azure OpenAI resource origin only
  - Do not include `/openai/v1`, `/openai/deployments/...`, or any other request path

### Optional

- `PORT`
  - Default: `18080`

- `AZURE_OPENAI_REASONING_EFFORT`
  - Supported values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
  - Default: `medium`

- `AZURE_OPENAI_VERBOSITY`
  - Supported values: `low`, `medium`, `high`
  - Default: `medium`

- `AZURE_OPENAI_DEBUG_LOGS`
  - Set to `1`, `true`, `yes`, or `on` to enable request/response lifecycle diagnostics
  - Default: disabled

## Chat Completions rewrite rules

For JSON requests to paths matching `/chat/completions`, the proxy:

- removes `temperature`
- removes `top_p`
- sets `reasoning_effort` if it is missing
- sets `verbosity` if it is missing

Default injected values:

- `reasoning_effort=medium`
- `verbosity=medium`

You can override these defaults with environment variables.

## Logging

The proxy logs an operational summary for each upstream response by default.

Logged fields:

- `status`
- `usage`

`usage` is extracted from the response body.
For streamed Chat Completions responses, Azure OpenAI includes `usage` only when the request sets `stream_options.include_usage=true`; otherwise the proxy logs `usage: null`.

For deeper diagnostics, enable `AZURE_OPENAI_DEBUG_LOGS=1`.
This adds stream lifecycle events such as upstream response start/end, flush completion, and connection close events.
When a streamed response is cut off before completion, the proxy also emits a partial response summary with any `usage` that was already observed.

## Examples

### Azure deployment-style request

Send a legacy-style Chat Completions request to the proxy:

```bash
curl -X POST "http://localhost:18080/openai/deployments/<deployment-name>/chat/completions?api-version=2025-04-01-preview" \
  -H "Content-Type: application/json" \
  -H "api-key: <your-azure-openai-key>" \
  -d '{
    "messages": [
      {"role": "user", "content": "Summarize this document."}
    ],
    "temperature": 0.7,
    "top_p": 0.95
  }'
```

Before forwarding upstream, the proxy rewrites the body to the equivalent of:

```json
{
  "messages": [
    {"role": "user", "content": "Summarize this document."}
  ],
  "reasoning_effort": "medium",
  "verbosity": "medium"
}
```

### Azure OpenAI v1-style request

If your client uses the v1 path shape, send requests like this instead:

```bash
curl -X POST "http://localhost:18080/openai/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{
    "model": "gpt-5.4",
    "messages": [
      {"role": "user", "content": "Summarize this document."}
    ],
    "temperature": 0.7,
    "top_p": 0.95
  }'
```

The same Chat Completions rewrite rules are applied before forwarding upstream.

## Limitations

- Request body rewriting is supported only for **Chat Completions** API requests.
- Non-Chat-Completions requests are forwarded without body adaptation.
- Rewriting is applied only to JSON request bodies.
- This project is intentionally minimal and does not attempt to normalize every Azure OpenAI API difference.

## Development

Syntax check:

```bash
npm run check
```

Start the proxy:

```bash
npm start
```

## License

MIT
