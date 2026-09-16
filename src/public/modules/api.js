

/** Dependencies are supplied by app.js; feature modules never import one another. */
export function createApi({ state }) {
  async function api(url, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (isWriteMethod(options.method) && state.csrfToken) headers["X-GameBench-CSRF"] = state.csrfToken;
    const response = await fetch(url, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `请求失败 (${response.status})`);
    return body;
  }

  function uploadJson(url, payload, onProgress) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", url);
      request.setRequestHeader("Content-Type", "application/json");
      if (state.csrfToken) request.setRequestHeader("X-GameBench-CSRF", state.csrfToken);
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress(event.loaded / event.total);
      };
      request.onload = () => {
        let body = {};
        try { body = JSON.parse(request.responseText); } catch { }
        if (request.status >= 200 && request.status < 300) resolve(body);
        else reject(new Error(body.error ?? `上传失败 (${request.status})`));
      };
      request.onerror = () => reject(new Error("上传连接中断"));
      request.send(JSON.stringify(payload));
    });
  }

  function isWriteMethod(method) {
    return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method ?? "GET").toUpperCase());
  }

  return { api, uploadJson };
}
