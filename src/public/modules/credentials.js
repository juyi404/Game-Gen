import { createSetupSelectors } from "./setup-selectors.js";
import { escapeHtml } from "./format.js";

/** Owns this view; shared reads and mutations use setup selectors, data and store. */
export function createCredentials({ state, elements, api, showToast, data }) {
  const { getProvider } = createSetupSelectors(state);
  const { loadProviders } = data;
  async function openCredentialDialog(providerId) {
    state.setup.credentialProviderId = providerId;
    state.setup.oauth = null;
    elements["api-key-input"].value = "";
    renderCredentialDialog();
    elements["credential-dialog"].showModal();
    if (!state.setup.providersLoaded) {
      try {
        await loadProviders(false);
      } catch {
        renderCredentialDialog();
      }
    }
  }

  function renderCredentialDialog() {
    const providerId = state.setup.credentialProviderId;
    const provider = getProvider(providerId);
    elements["credential-title"].textContent = provider?.name ?? providerId ?? "连接供应商";
    elements["credential-subtitle"].textContent = providerId ? `Provider ID: ${providerId}` : "凭据由 OpenCode 保存在本机。";
    elements["credential-current"].innerHTML = provider?.connected
      ? '<span class="status-pill status-running">已连接</span> OpenCode 已识别该供应商的本地凭据。'
      : '<span class="status-pill status-pending">未连接</span> 保存 API Key 或完成 OAuth 登录后再同步状态。';
    const oauthMethods = provider?.authMethods.filter((method) => method.type === "oauth") ?? [];
    elements["oauth-section"].classList.toggle("hidden", oauthMethods.length === 0);
    elements["oauth-methods"].innerHTML = oauthMethods.map((method) => `<button class="oauth-method" data-oauth-method="${method.index}" type="button">${escapeHtml(method.label)}</button>`).join("");
    elements["oauth-completion"].classList.toggle("hidden", !state.setup.oauth);
    if (state.setup.oauth) {
      elements["oauth-instructions"].textContent = state.setup.oauth.instructions || "请在新窗口完成授权，然后返回这里确认。";
      elements["oauth-code-field"].classList.toggle("hidden", state.setup.oauth.method !== "code");
    }
  }

  async function saveApiKey() {
    const providerId = state.setup.credentialProviderId;
    const key = elements["api-key-input"].value.trim();
    if (!providerId || !key) return showToast("请输入 API Key");
    const button = elements["save-api-key-button"];
    button.disabled = true;
    button.textContent = "正在保存…";
    try {
      await api("/api/auth/api-key", { method: "POST", body: JSON.stringify({ providerId, key }) });
      elements["api-key-input"].value = "";
      await loadProviders(false);
      renderCredentialDialog();
      showToast(`${providerId} 凭据已保存到 OpenCode`);
    } catch (error) {
      showToast(error.message);
    } finally {
      button.disabled = false;
      button.textContent = "保存到 OpenCode";
    }
  }

  function toggleApiKeyVisibility() {
    const input = elements["api-key-input"];
    input.type = input.type === "password" ? "text" : "password";
    elements["toggle-key-button"].textContent = input.type === "password" ? "显示" : "隐藏";
  }

  async function startOAuth(event) {
    const button = event.target.closest("[data-oauth-method]");
    if (!button || !state.setup.credentialProviderId) return;
    const popup = window.open("about:blank", "opencode-auth", "width=760,height=780");
    button.disabled = true;
    try {
      const method = Number(button.dataset.oauthMethod);
      const authorization = await api("/api/auth/oauth/start", {
        method: "POST",
        body: JSON.stringify({ providerId: state.setup.credentialProviderId, method }),
      });
      state.setup.oauth = { ...authorization, index: method };
      if (popup) popup.location.href = authorization.url;
      else window.open(authorization.url, "_blank", "noopener");
      renderCredentialDialog();
    } catch (error) {
      popup?.close();
      showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function completeOAuth() {
    const providerId = state.setup.credentialProviderId;
    const oauth = state.setup.oauth;
    if (!providerId || !oauth) return;
    const code = elements["oauth-code-input"].value.trim();
    if (oauth.method === "code" && !code) return showToast("请输入授权码");
    try {
      await api("/api/auth/oauth/complete", {
        method: "POST",
        body: JSON.stringify({ providerId, method: oauth.index, ...(code ? { code } : {}) }),
      });
      state.setup.oauth = null;
      await loadProviders(false);
      renderCredentialDialog();
      showToast(`${providerId} 登录完成`);
    } catch (error) {
      showToast(error.message);
    }
  }

  return { openCredentialDialog, renderCredentialDialog, saveApiKey, toggleApiKeyVisibility, startOAuth, completeOAuth };
}
