(() => {
  "use strict";

  const API = "/api/admin/github/repositories";
  const state = { token: "", repositories: [], pendingAction: null };
  const elements = {
    loginPanel: document.querySelector("#login-panel"),
    loginForm: document.querySelector("#login-form"),
    token: document.querySelector("#token"),
    workspace: document.querySelector("#workspace"),
    connectionDot: document.querySelector("#connection-dot"),
    connectionLabel: document.querySelector("#connection-label"),
    appSummary: document.querySelector("#app-summary"),
    refresh: document.querySelector("#refresh-button"),
    disconnect: document.querySelector("#disconnect-button"),
    notice: document.querySelector("#notice"),
    loading: document.querySelector("#loading"),
    empty: document.querySelector("#empty-state"),
    list: document.querySelector("#repository-list"),
    dialog: document.querySelector("#confirm-dialog"),
    confirmRepository: document.querySelector("#confirm-repository"),
    confirmation: document.querySelector("#publisher-confirmation"),
    confirmAction: document.querySelector("#confirm-action"),
  };

  const STATUS = {
    not_connected: { label: "尚未接入", className: "badge-neutral", action: "接入仓库" },
    active: { label: "已启用", className: "badge-active" },
    blocked: { label: "已阻止", className: "badge-warning" },
    draining: { label: "正在停止", className: "badge-warning" },
    revoked: { label: "授权已撤销", className: "badge-danger", action: "重新验证" },
    unknown: { label: "需要验证", className: "badge-warning", action: "重新验证" },
    suspended: { label: "安装已暂停", className: "badge-danger" },
  };

  function setConnected(connected) {
    elements.connectionDot.classList.toggle("connected", connected);
    elements.connectionLabel.textContent = connected ? "已连接管理 API" : "尚未连接";
    elements.loginPanel.hidden = connected;
    elements.workspace.hidden = !connected;
  }

  function setNotice(message, kind = "") {
    elements.notice.hidden = !message;
    elements.notice.className = `notice${kind ? ` ${kind}` : ""}`;
    elements.notice.textContent = message || "";
  }

  function setLoading(loading) {
    elements.loading.hidden = !loading;
    elements.refresh.disabled = loading;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function appendText(parent, name, value, className) {
    const node = document.createElement(name);
    if (className) node.className = className;
    node.textContent = value;
    parent.appendChild(node);
    return node;
  }

  function safeStatus(value) {
    return Object.hasOwn(STATUS, value) ? value : "unknown";
  }

  function renderRepositories() {
    clearNode(elements.list);
    elements.empty.hidden = state.repositories.length !== 0;
    for (const repository of state.repositories) {
      const status = safeStatus(repository.status);
      const display = STATUS[status];
      const card = document.createElement("article");
      card.className = "repository-card";

      const content = document.createElement("div");
      const title = document.createElement("div");
      title.className = "repository-title";
      appendText(title, "h3", repository.repository || "未知仓库");
      appendText(title, "span", display.label, `badge ${display.className}`);
      content.appendChild(title);

      const meta = document.createElement("p");
      meta.className = "repository-meta";
      appendText(meta, "span", repository.account ? `账户：${repository.account}` : "GitHub 账户");
      content.appendChild(meta);

      let message = repository.message;
      if (!message && status === "active") message = "已连接到 PR Agent，可以通过真实 Pull Request 验证评审流程。";
      if (!message && status === "blocked") message = "该绑定处于阻止状态。页面不会自动覆盖管理员之前的停用决定。";
      if (!message && status === "draining") message = "正在安全停止现有发布操作，完成后再处理接入状态。";
      if (!message && status === "suspended") message = "请先在 GitHub 恢复 App 安装，再返回这里刷新。";
      if (!message && (status === "revoked" || status === "unknown")) message = "仓库访问需要重新确认。请先确认 GitHub 授权，再执行重新验证。";
      if (message) appendText(content, "p", message, "repository-message");
      card.appendChild(content);

      if (display.action) {
        const button = appendText(card, "button", display.action, "button button-secondary");
        button.type = "button";
        button.dataset.repository = repository.repository;
        button.dataset.action = status === "not_connected" ? "enroll" : "revalidate";
        if (repository.binding?.providerAccessVersion !== undefined) {
          button.dataset.accessVersion = String(repository.binding.providerAccessVersion);
        }
      }
      elements.list.appendChild(card);
    }
  }

  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.token}`,
        ...(options.headers || {}),
      },
      cache: "no-store",
    });
    let payload;
    try { payload = await response.json(); }
    catch { payload = undefined; }
    if (!response.ok) {
      const message = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
      const error = new Error(typeof message === "string" ? message : `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function refreshRepositories({ firstConnection = false, preserveNotice = false } = {}) {
    setLoading(true);
    if (!preserveNotice) setNotice("");
    try {
      const result = await request(API);
      state.repositories = Array.isArray(result?.repositories) ? result.repositories : [];
      const appName = result?.app?.name || result?.app?.slug || "GitHub App";
      elements.appSummary.textContent = `${appName} 当前授权范围内的仓库。`;
      renderRepositories();
      setConnected(true);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        disconnect();
        setNotice("令牌无效、已过期或没有仓库接入权限。请确认后重试。", "error");
      } else if (error.status === 404) {
        if (firstConnection) disconnect();
        setNotice("此部署尚未启用 GitHub 仓库接入页面。管理员仍可使用原有 CLI。", "error");
      } else {
        setNotice(`${error.message}。可以稍后刷新重试；本次失败不会创建半完成绑定。`, "error");
      }
    } finally {
      setLoading(false);
    }
  }

  function disconnect() {
    state.token = "";
    state.repositories = [];
    state.pendingAction = null;
    elements.token.value = "";
    elements.appSummary.textContent = "正在读取 GitHub App 信息…";
    clearNode(elements.list);
    elements.empty.hidden = true;
    setConnected(false);
  }

  function openConfirmation(repository, action, expectedAccessVersion) {
    state.pendingAction = { repository, action, expectedAccessVersion };
    elements.confirmRepository.textContent = repository;
    elements.confirmation.checked = false;
    elements.confirmAction.disabled = true;
    elements.confirmAction.textContent = action === "enroll" ? "确认并接入" : "确认并重新验证";
    elements.dialog.returnValue = "";
    elements.dialog.showModal();
  }

  async function submitAction() {
    if (!state.pendingAction || !elements.confirmation.checked) return;
    const pending = state.pendingAction;
    elements.confirmAction.disabled = true;
    elements.confirmAction.textContent = "处理中…";
    try {
      const path = pending.action === "enroll" ? API : `${API}/revalidate`;
      const body = {
        repository: pending.repository,
        confirmPublisherStopped: true,
        ...(pending.action === "revalidate"
          ? { expectedAccessVersion: Number(pending.expectedAccessVersion) }
          : {}),
      };
      await request(path, { method: "POST", body: JSON.stringify(body) });
      setNotice(`${pending.repository} 已完成${pending.action === "enroll" ? "接入" : "重新验证"}。`, "success");
      await refreshRepositories({ preserveNotice: true });
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        disconnect();
        setNotice("管理员授权已经失效，请重新连接。", "error");
      } else {
        setNotice(`${pending.repository}：${error.message}。当前状态没有被页面假定为成功，请刷新后重试。`, "error");
      }
    } finally {
      state.pendingAction = null;
      elements.confirmAction.textContent = "确认并继续";
    }
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const token = elements.token.value.trim();
    if (!token) return;
    state.token = token;
    elements.token.value = "";
    setConnected(true);
    await refreshRepositories({ firstConnection: true });
  });

  elements.refresh.addEventListener("click", () => refreshRepositories());
  elements.disconnect.addEventListener("click", () => {
    disconnect();
    setNotice("");
    elements.token.focus();
  });
  elements.list.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    if (button.dataset.action === "revalidate"
        && !Number.isSafeInteger(Number(button.dataset.accessVersion))) {
      setNotice("此仓库缺少可验证的访问版本，请刷新后重试。", "error");
      return;
    }
    openConfirmation(button.dataset.repository, button.dataset.action, button.dataset.accessVersion);
  });
  elements.confirmation.addEventListener("change", () => {
    elements.confirmAction.disabled = !elements.confirmation.checked;
  });
  elements.dialog.addEventListener("close", () => {
    if (elements.dialog.returnValue === "default") void submitAction();
    else state.pendingAction = null;
  });

  setConnected(false);
})();
