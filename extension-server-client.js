(function exposeServerClient(root) {
  "use strict";

  async function settings() {
    const data = await chrome.storage.local.get(["vkr_server_url", "vkr_server_api_secret"]);
    const url = String(data.vkr_server_url || "").replace(/\/+$/, "");
    const secret = String(data.vkr_server_api_secret || "");
    if (!url || !secret) throw new Error("Сначала настройте URL и API_SECRET сервера в расширении.");
    return { url, secret };
  }

  async function request(endpoint, { method = "GET", json, raw, contentType, fileName } = {}) {
    const { url, secret } = await settings();
    const headers = { Authorization: `Bearer ${secret}` };
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (raw !== undefined) {
      headers["Content-Type"] = contentType;
      headers["X-File-Name"] = encodeURIComponent(fileName || "story-media");
      body = raw;
    }
    const response = await fetch(`${url}/api${endpoint}`, { method, headers, body });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `Сервер ответил HTTP ${response.status}`);
    return payload;
  }

  root.VkrServerClient = Object.freeze({ request });
})(globalThis);
