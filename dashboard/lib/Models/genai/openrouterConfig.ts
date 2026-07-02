// Configuration for the PhilSA POC GenAI assistant panel.
//
// The assistant talks to OpenRouter *through a proxy* (genai-proxy/server.js) so
// the API key never reaches the browser. The model fall-through order and the
// system prompt live entirely in the proxy (it builds the OpenRouter request);
// only the proxy URL is needed client-side.

/**
 * Where the browser sends chat requests. This is our own proxy, not OpenRouter
 * directly. Overridable at runtime via `window.GENAI_PROXY_URL` (set in
 * index.html or the console) so the same bundle works across environments
 * without a rebuild; defaults to the local proxy dev port.
 */
export function genaiProxyUrl(): string {
  const override = (globalThis as { GENAI_PROXY_URL?: string }).GENAI_PROXY_URL;
  return override && override.length > 0
    ? override
    : "http://localhost:8084/api/chat";
}
