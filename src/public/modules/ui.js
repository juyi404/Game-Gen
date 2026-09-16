import { statusLabels } from "./state.js";

/** Dependencies are supplied by app.js; feature modules never import one another. */
export function createUi({ elements }) {
  function setStatusPill(element, status) {
    element.className = `status-pill status-${status}`;
    element.textContent = statusLabels[status] ?? status;
  }

  function setConnection(className, text) {
    elements.connection.className = `connection ${className}`;
    elements.connection.innerHTML = `<i></i>${text}`;
  }

  async function copyPath(value, successMessage) {
    if (!value) return showToast("目录尚未创建");
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const input = document.createElement("textarea");
      input.value = value;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.append(input);
      input.select();
      document.execCommand("copy");
      input.remove();
    }
    showToast(successMessage);
  }

  let toastTimer;

  function showToast(message) {
    elements.toast.textContent = message;
    elements.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 3600);
  }

  return { setStatusPill, setConnection, copyPath, showToast };
}
