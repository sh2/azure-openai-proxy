# azure-openai-proxy

A small MIT-licensed Node.js proxy for Azure OpenAI applications that are not yet aligned with GPT-5-family Chat Completions request requirements.

This proxy sits between your application and Azure OpenAI, forwards requests to your Azure endpoint, and rewrites **Chat Completions** request bodies when needed:

- injects `reasoning_effort` when missing
- injects `verbosity` when missing
- removes deprecated parameters such as `temperature` and `top_p`

It is intended as a compact compatibility layer, not a full API gateway.

## What it does

- Forwards requests to `AZURE_OPENAI_ENDPOINT`
- Preserves the incoming HTTP method, path, and query parameters
- Adds `api-version=2025-04-01-preview` when the request does not provide `api-version`
- Rewrites request bodies **only** for Chat Completions API paths
- Leaves other request bodies unchanged

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

## Requirements

- Node.js `>=18.0.0`
- No external runtime dependencies

## Configuration

### Required

- `AZURE_OPENAI_ENDPOINT`
  - Example: `https://<resource-name>.openai.azure.com`
  - Must use `http://` or `https://`

### Optional

- `PORT`
  - Default: `18080`

- `AZURE_OPENAI_REASONING_EFFORT`
  - Supported values: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
  - Default: `medium`

- `AZURE_OPENAI_VERBOSITY`
  - Supported values: `low`, `medium`, `high`
  - Default: `medium`

## Quick start

```bash
export AZURE_OPENAI_ENDPOINT="https://<resource-name>.openai.azure.com"
npm start
```

Or use the sample script:

```bash
chmod +x start-sample.sh
AZURE_OPENAI_ENDPOINT="https://<resource-name>.openai.azure.com" ./start-sample.sh
```

## Example

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
