const $ = (id) => document.getElementById(id);
const nameInput = $("name");
const message = $("message");
const domainList = $("domainList");
const submitBtn = $("submitBtn");

function setMessage(text, error = false) {
  message.textContent = text;
  message.classList.toggle("error", error);
}
function cleanName(value) {
  return value.trim().toLowerCase();
}
nameInput.addEventListener("input", () => {
  const value = cleanName(nameInput.value) || "tenban";
  $("previewName").textContent = value.replace(/[^a-z0-9-]/g, "");
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") ? url.href : "#";
  } catch { return "#"; }
}

function renderDomains(domains) {
  domainList.replaceChildren();
  if (!domains.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Chưa có tên miền nào. Hãy tạo tên đầu tiên!";
    domainList.append(p);
    return;
  }
  for (const item of domains) {
    const card = document.createElement("article");
    card.className = "domain-card";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${item.name}.lammod`;
    const destination = document.createElement("small");
    destination.textContent = item.destination;
    info.append(title, destination);
    const actions = document.createElement("div");
    actions.className = "domain-actions";
    const open = document.createElement("a");
    open.href = `/r/${encodeURIComponent(item.name)}`;
    open.textContent = "Mở resolver ↗";
    open.rel = "noopener noreferrer";
    const copy = document.createElement("a");
    copy.href = "#";
    copy.textContent = "Sao chép tên";
    copy.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        await navigator.clipboard.writeText(`${item.name}.lammod`);
        setMessage(`Đã sao chép ${item.name}.lammod`);
      } catch {
        setMessage("Không thể sao chép tự động trên trình duyệt này.", true);
      }
    });
    actions.append(open, copy);
    card.append(info, actions);
    domainList.append(card);
  }
}

async function refresh() {
  domainList.replaceChildren();
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = "Đang tải...";
  domainList.append(p);
  try {
    const data = await api("/api/domains");
    renderDomains(data.domains || []);
  } catch (err) {
    domainList.replaceChildren();
    const error = document.createElement("p");
    error.className = "muted";
    error.textContent = `Không tải được dữ liệu: ${err.message}`;
    domainList.append(error);
  }
}

$("createForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  submitBtn.disabled = true;
  setMessage("Đang tạo tên miền...");
  try {
    const data = await api("/api/domains", {
      method: "POST",
      body: JSON.stringify({
        name: cleanName(nameInput.value),
        destination: $("destination").value.trim()
      })
    });
    setMessage(`Đã tạo ${data.domain}. Resolver thử nghiệm: ${location.origin}${data.resolverPath}`);
    nameInput.value = "";
    $("destination").value = "";
    $("previewName").textContent = "tenban";
    await refresh();
  } catch (err) {
    setMessage(err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
});
$("refreshBtn").addEventListener("click", refresh);
refresh();
