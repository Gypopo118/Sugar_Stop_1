"use strict";

/* ---------- Storage helpers ---------- */
const LS = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
};

function getDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("deviceId", id);
  }
  return id;
}

const defaultSettings = {
  xeGrams: 12,
  palmWidth: null,
  palmLength: null,
  fistThickness: null,
  provider: "deepseek"
};
function getSettings() { return LS.get("settings", defaultSettings); }
function setSettings(s) { LS.set("settings", s); }

/* ---------- Client-side API keys (stored solely on device in localStorage) ---------- */
function getApiKeys() {
  return LS.get("apiKeys", { deepseek: "", gemini: "" });
}
function setApiKey(provider, key) {
  const keys = getApiKeys();
  keys[provider] = (key || "").trim();
  LS.set("apiKeys", keys);
}
function getApiKey(provider) {
  const keys = getApiKeys();
  return (keys[provider] || "").trim();
}

/* ---------- Tab navigation ---------- */
const views = {
  capture: document.getElementById("view-capture"),
  result: document.getElementById("view-result"),
  diary: document.getElementById("view-diary"),
  settings: document.getElementById("view-settings")
};
const tabButtons = document.querySelectorAll(".tab");

function showView(name) {
  Object.entries(views).forEach(([k, el]) => { el.hidden = (k !== name); });
  tabButtons.forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  if (name === "diary") renderDiaryDay();
}
tabButtons.forEach(b => b.addEventListener("click", () => showView(b.dataset.tab)));

/* ---------- Camera capture ---------- */
const camStream = document.getElementById("camStream");
const shotPreview = document.getElementById("shotPreview");
const frameHint = document.getElementById("frameHint");
const btnCamera = document.getElementById("btnCamera");
const fileInput = document.getElementById("fileInput");
const btnAnalyze = document.getElementById("btnAnalyze");
const analyzeError = document.getElementById("analyzeError");

let currentPhotoDataUrl = null;
let mediaStream = null;

async function startCamera() {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 1280 } },
      audio: false
    });
    camStream.srcObject = mediaStream;
    camStream.hidden = false;
    shotPreview.hidden = true;
    frameHint.hidden = true;
  } catch (e) {
    // Camera unavailable (permissions, desktop, etc) — fall back to file input silently.
    frameHint.hidden = false;
  }
}

function stopCamera() {
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
}

function photoFromVideoFrame() {
  const canvas = document.createElement("canvas");
  const size = 1024; // keep upload light; DeepSeek vision downsamples to ~800px anyway
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const vw = camStream.videoWidth, vh = camStream.videoHeight;
  const scale = Math.max(size / vw, size / vh);
  const sw = size / scale, sh = size / scale;
  const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
  ctx.drawImage(camStream, sx, sy, sw, sh, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.85);
}

function setPhoto(dataUrl) {
  currentPhotoDataUrl = dataUrl;
  shotPreview.src = dataUrl;
  shotPreview.hidden = false;
  camStream.hidden = true;
  frameHint.hidden = true;
  stopCamera();
  btnAnalyze.disabled = false;
  btnAnalyze.textContent = "Посчитать углеводы";
}

btnCamera.addEventListener("click", () => {
  if (mediaStream && !camStream.hidden) {
    setPhoto(photoFromVideoFrame());
  } else {
    startCamera();
  }
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const size = 1024;
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext("2d");
      const scale = Math.max(size / img.width, size / img.height);
      const sw = size / scale, sh = size / scale;
      const sx = (img.width - sw) / 2, sy = (img.height - sh) / 2;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
      setPhoto(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// Start camera when the capture tab is visible; iOS requires a user gesture in
// some contexts, so also allow tapping the shutter to trigger the permission prompt.
startCamera();

/* ---------- Voice input for the refine field ---------- */
const refineText = document.getElementById("refineText");
const btnMic = document.getElementById("btnMic");
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
if (SpeechRecognition) {
  recognizer = new SpeechRecognition();
  recognizer.lang = "ru-RU";
  recognizer.interimResults = false;
  recognizer.onresult = (e) => {
    const text = e.results[0][0].transcript;
    refineText.value = refineText.value ? refineText.value + " " + text : text;
  };
  recognizer.onend = () => btnMic.classList.remove("listening");
} else {
  btnMic.disabled = true;
  btnMic.title = "Голосовой ввод не поддерживается этим браузером";
}
btnMic.addEventListener("click", () => {
  if (!recognizer) return;
  btnMic.classList.add("listening");
  recognizer.start();
});

/* ---------- Analyze ---------- */
btnAnalyze.addEventListener("click", async () => {
  if (!currentPhotoDataUrl) return;
  analyzeError.hidden = true;

  const settings = getSettings();
  const apiKey = getApiKey(settings.provider);

  if (!apiKey) {
    analyzeError.innerHTML = `Для расчёта с помощью <strong>${PROVIDER_LABELS[settings.provider]}</strong> необходимо указать API-ключ.<br><button id="btnGoToSettings" class="btn-secondary" style="margin-top:10px; width:100%;" type="button">Перейти в Настройки и указать ключ</button>`;
    analyzeError.hidden = false;
    document.getElementById("btnGoToSettings")?.addEventListener("click", () => {
      showView("settings");
      customApiKey.focus();
    });
    return;
  }

  btnAnalyze.disabled = true;
  btnAnalyze.textContent = "Считаю...";

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        provider: settings.provider,
        imageBase64: currentPhotoDataUrl,
        refineText: refineText.value.trim(),
        xeGrams: settings.xeGrams,
        hand: {
          palmWidthCm: settings.palmWidth,
          palmLengthCm: settings.palmLength,
          fistThicknessCm: settings.fistThickness
        }
      })
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Сервер ответил ${res.status}`);
    }
    const data = await res.json();
    openResult(data);
  } catch (e) {
    analyzeError.textContent = "Не удалось получить оценку: " + e.message;
    analyzeError.hidden = false;
  } finally {
    btnAnalyze.disabled = false;
    btnAnalyze.textContent = "Посчитать углеводы";
  }
});

/* ---------- Result view ---------- */
const dishList = document.getElementById("dishList");
const dishTemplate = document.getElementById("dishCardTemplate");
let currentDishes = [];

function openResult(data) {
  currentDishes = (data.dishes || []).map(d => ({
    name: d.name || "Блюдо",
    weightG: Number(d.weightG) || 0,
    carbsG: Number(d.carbsG) || 0,
    xe: d.xe != null ? Number(d.xe) : (Number(d.carbsG) || 0) / getSettings().xeGrams,
    gi: d.gi != null ? Number(d.gi) : null,
    kcal: Number(d.kcal) || 0,
    proteinG: Number(d.proteinG) || 0,
    fatG: Number(d.fatG) || 0
  }));
  document.getElementById("resultPhoto").src = currentPhotoDataUrl;
  renderDishes();
  showView("result");
}

function renderDishes() {
  dishList.innerHTML = "";
  currentDishes.forEach((dish, idx) => {
    const node = dishTemplate.content.cloneNode(true);
    const card = node.querySelector(".dish-card");
    const nameEl = node.querySelector(".dish-name");
    const weightEl = node.querySelector(".dish-weight");
    const xeEl = node.querySelector(".dish-xe");
    const carbsEl = node.querySelector(".dish-carbs");
    const giEl = node.querySelector(".dish-gi");

    nameEl.value = dish.name;
    weightEl.value = dish.weightG || "";
    xeEl.value = round1(dish.xe);
    carbsEl.value = Math.round(dish.carbsG);
    giEl.textContent = dish.gi != null ? Math.round(dish.gi) : "—";

    nameEl.addEventListener("input", () => { currentDishes[idx].name = nameEl.value; });
    weightEl.addEventListener("input", () => { currentDishes[idx].weightG = Number(weightEl.value) || 0; updateTotals(); });
    xeEl.addEventListener("input", () => {
      currentDishes[idx].xe = Number(xeEl.value) || 0;
      currentDishes[idx].carbsG = currentDishes[idx].xe * getSettings().xeGrams;
      carbsEl.value = Math.round(currentDishes[idx].carbsG);
      updateTotals();
    });
    carbsEl.addEventListener("input", () => {
      currentDishes[idx].carbsG = Number(carbsEl.value) || 0;
      currentDishes[idx].xe = currentDishes[idx].carbsG / getSettings().xeGrams;
      xeEl.value = round1(currentDishes[idx].xe);
      updateTotals();
    });
    node.querySelector(".dish-remove").addEventListener("click", () => {
      currentDishes.splice(idx, 1);
      renderDishes();
    });

    dishList.appendChild(node);
  });
  updateTotals();
}

function updateTotals() {
  const t = currentDishes.reduce((acc, d) => {
    acc.xe += d.xe || 0;
    acc.carbs += d.carbsG || 0;
    acc.kcal += d.kcal || 0;
    acc.protein += d.proteinG || 0;
    acc.fat += d.fatG || 0;
    if (d.gi != null && d.carbsG > 0) { acc.giWeighted += d.gi * d.carbsG; acc.giWeight += d.carbsG; }
    return acc;
  }, { xe: 0, carbs: 0, kcal: 0, protein: 0, fat: 0, giWeighted: 0, giWeight: 0 });

  document.getElementById("totalXE").textContent = round1(t.xe);
  document.getElementById("totalCarbs").textContent = Math.round(t.carbs);
  document.getElementById("totalKcal").textContent = Math.round(t.kcal);
  document.getElementById("totalProtein").textContent = Math.round(t.protein);
  document.getElementById("totalFat").textContent = Math.round(t.fat);

  const avgGI = t.giWeight > 0 ? t.giWeighted / t.giWeight : null;
  document.getElementById("totalGI").textContent = avgGI != null ? Math.round(avgGI) : "—";
  // Glycemic load = GI * carbs(g) / 100, summed per dish for accuracy
  const gl = currentDishes.reduce((sum, d) => d.gi != null ? sum + (d.gi * d.carbsG) / 100 : sum, 0);
  document.getElementById("totalGL").textContent = gl > 0 ? round1(gl) : "—";
}

function round1(n) { return Math.round((n || 0) * 10) / 10; }

document.getElementById("btnAddDish").addEventListener("click", () => {
  currentDishes.push({ name: "Новое блюдо", weightG: 0, carbsG: 0, xe: 0, gi: null, kcal: 0, proteinG: 0, fatG: 0 });
  renderDishes();
});

document.getElementById("btnDiscard").addEventListener("click", () => {
  currentPhotoDataUrl = null;
  currentDishes = [];
  shotPreview.hidden = true;
  frameHint.hidden = false;
  btnAnalyze.disabled = true;
  btnAnalyze.textContent = "Сделайте фото, чтобы посчитать";
  refineText.value = "";
  showView("capture");
  startCamera();
});

document.getElementById("btnSaveMeal").addEventListener("click", () => {
  const entries = LS.get("diary", []);
  const totals = currentDishes.reduce((acc, d) => {
    acc.xe += d.xe || 0; acc.carbs += d.carbsG || 0; acc.kcal += d.kcal || 0;
    return acc;
  }, { xe: 0, carbs: 0, kcal: 0 });

  entries.push({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    photo: currentPhotoDataUrl,
    dishes: currentDishes,
    totalXE: round1(totals.xe),
    totalCarbs: Math.round(totals.carbs),
    totalKcal: Math.round(totals.kcal)
  });
  LS.set("diary", entries);
  showView("diary");
});

/* ---------- Diary ---------- */
let diaryDayOffset = 0;
const diaryDate = document.getElementById("diaryDate");
document.getElementById("diaryPrev").addEventListener("click", () => { diaryDayOffset--; renderDiaryDay(); });
document.getElementById("diaryNext").addEventListener("click", () => { diaryDayOffset = Math.min(0, diaryDayOffset + 1); renderDiaryDay(); });

function startOfDay(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return d;
}

function renderDiaryDay() {
  const dayStart = startOfDay(diaryDayOffset);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);
  diaryDate.textContent = diaryDayOffset === 0
    ? "Сегодня"
    : dayStart.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });

  const entries = LS.get("diary", [])
    .filter(e => e.timestamp >= dayStart.getTime() && e.timestamp < dayEnd.getTime())
    .sort((a, b) => b.timestamp - a.timestamp);

  const dayTotals = entries.reduce((acc, e) => {
    acc.xe += e.totalXE; acc.carbs += e.totalCarbs; acc.kcal += e.totalKcal;
    return acc;
  }, { xe: 0, carbs: 0, kcal: 0 });

  document.getElementById("diaryDayXE").textContent = round1(dayTotals.xe);
  document.getElementById("diaryDayCarbs").textContent = `${Math.round(dayTotals.carbs)} г углеводов · ${Math.round(dayTotals.kcal)} ккал`;

  const container = document.getElementById("diaryEntries");
  const empty = document.getElementById("diaryEmpty");
  container.innerHTML = "";
  empty.hidden = entries.length > 0;

  entries.forEach(e => {
    const row = document.createElement("div");
    row.className = "diary-entry";
    const time = new Date(e.timestamp).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    const dishNames = e.dishes.map(d => d.name).join(", ");
    row.innerHTML = `
      <img src="${e.photo}" alt="">
      <div class="diary-entry-body">
        <div class="diary-entry-title">${escapeHtml(dishNames)}</div>
        <div class="diary-entry-meta">${e.totalCarbs} г углеводов · ${e.totalKcal} ккал</div>
      </div>
      <div class="diary-entry-xe">${round1(e.totalXE)}</div>
      <div class="diary-entry-time">${time}</div>
    `;
    row.addEventListener("click", () => {
      if (confirm("Удалить запись из дневника?")) {
        const all = LS.get("diary", []).filter(x => x.id !== e.id);
        LS.set("diary", all);
        renderDiaryDay();
      }
    });
    container.appendChild(row);
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Settings ---------- */
const xeSegment = document.getElementById("xeGramSegment");
const providerSegment = document.getElementById("providerSegment");
const keyProviderLabel = document.getElementById("keyProviderLabel");
const palmWidth = document.getElementById("palmWidth");
const palmLength = document.getElementById("palmLength");
const fistThickness = document.getElementById("fistThickness");
const customApiKey = document.getElementById("customApiKey");
const keyStatus = document.getElementById("keyStatus");

const PROVIDER_LABELS = { deepseek: "DeepSeek", gemini: "Gemini 3.7 Flash" };

function loadSettingsIntoForm() {
  const s = getSettings();
  [...xeSegment.children].forEach(btn => btn.classList.toggle("active", Number(btn.dataset.value) === s.xeGrams));
  [...providerSegment.children].forEach(btn => btn.classList.toggle("active", btn.dataset.value === s.provider));
  keyProviderLabel.textContent = PROVIDER_LABELS[s.provider];
  if (s.palmWidth) palmWidth.value = s.palmWidth;
  if (s.palmLength) palmLength.value = s.palmLength;
  if (s.fistThickness) fistThickness.value = s.fistThickness;

  const currentKey = getApiKey(s.provider);
  if (currentKey) {
    const masked = currentKey.length > 8 ? `${currentKey.slice(0, 4)}...${currentKey.slice(-4)}` : "••••••••";
    keyStatus.textContent = `Ключ для ${PROVIDER_LABELS[s.provider]} сохранён (${masked}).`;
    keyStatus.style.color = "var(--teal)";
    customApiKey.placeholder = "Ключ задан. Введите новый для замены";
  } else {
    keyStatus.textContent = `Ключ для ${PROVIDER_LABELS[s.provider]} не задан. Вставьте ключ.`;
    keyStatus.style.color = "#D9534F";
    customApiKey.placeholder = s.provider === "deepseek" ? "sk-..." : "AIzaSy...";
  }
}

xeSegment.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const s = getSettings();
  s.xeGrams = Number(btn.dataset.value);
  setSettings(s);
  loadSettingsIntoForm();
});

providerSegment.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const s = getSettings();
  s.provider = btn.dataset.value;
  setSettings(s);
  loadSettingsIntoForm();
});

[palmWidth, palmLength, fistThickness].forEach(input => {
  input.addEventListener("change", () => {
    const s = getSettings();
    s.palmWidth = palmWidth.value ? Number(palmWidth.value) : null;
    s.palmLength = palmLength.value ? Number(palmLength.value) : null;
    s.fistThickness = fistThickness.value ? Number(fistThickness.value) : null;
    setSettings(s);
  });
});

document.getElementById("btnSaveKey").addEventListener("click", () => {
  const key = customApiKey.value.trim();
  if (!key) {
    keyStatus.textContent = "Пожалуйста, вставьте или введите API-ключ.";
    keyStatus.style.color = "#D9534F";
    return;
  }
  const provider = getSettings().provider;
  setApiKey(provider, key);
  customApiKey.value = "";
  keyStatus.textContent = `Ключ для ${PROVIDER_LABELS[provider]} сохранён на этом устройстве!`;
  keyStatus.style.color = "var(--teal)";
  setTimeout(loadSettingsIntoForm, 1000);
});

document.getElementById("btnClearKey").addEventListener("click", () => {
  const provider = getSettings().provider;
  setApiKey(provider, "");
  customApiKey.value = "";
  keyStatus.textContent = `Ключ для ${PROVIDER_LABELS[provider]} удалён.`;
  keyStatus.style.color = "var(--ink-soft)";
  setTimeout(loadSettingsIntoForm, 800);
});

loadSettingsIntoForm();

/* ---------- PWA Install Controller (Android & iOS) ---------- */
function initPwaInstall() {
  const banner = document.getElementById("installAppBanner");
  const btnInstall = document.getElementById("btnInstallApp");
  const btnClose = document.getElementById("btnInstallAppClose");
  const iosModal = document.getElementById("iosInstallModal");
  const iosBackdrop = document.getElementById("iosInstallBackdrop");
  const btnIosClose = document.getElementById("btnIosInstallClose");

  if (!banner || !btnInstall) return;

  function isStandaloneMode() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true ||
      document.referrer.includes("android-app://") ||
      new URLSearchParams(window.location.search).get("source") === "pwa"
    );
  }

  // If running from desktop/homescreen shortcut directly in standalone mode, DO NOT show
  if (isStandaloneMode()) {
    banner.hidden = true;
    return;
  }

  let deferredPrompt = null;
  const ua = window.navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);

  // Check if temporarily dismissed in current session
  const isSessionDismissed = sessionStorage.getItem("pwaInstallDismissed") === "true";

  function showBanner() {
    if (isStandaloneMode() || isSessionDismissed) return;
    banner.hidden = false;
  }

  function hideBanner(persistSession = true) {
    banner.hidden = true;
    if (persistSession) {
      sessionStorage.setItem("pwaInstallDismissed", "true");
    }
  }

  // Android & Chromium browsers: capture install prompt
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    showBanner();
  });

  // When app is successfully installed: permanently hide
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    hideBanner(true);
    if (iosModal) iosModal.hidden = true;
  });

  // Handle display mode changes dynamically
  if (window.matchMedia) {
    window.matchMedia("(display-mode: standalone)").addEventListener("change", (e) => {
      if (e.matches) hideBanner(true);
    });
  }

  // Click on "Установить на рабочий стол"
  btnInstall.addEventListener("click", async () => {
    if (deferredPrompt) {
      // Android / Chromium native install prompt
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") {
        hideBanner(true);
      }
      deferredPrompt = null;
    } else if (isIOS) {
      // iOS: open bottom sheet with Safari Add to Home Screen instructions
      if (iosModal) iosModal.hidden = false;
    } else {
      // Fallback for other browsers (e.g. desktop or non-Chromium Android)
      if (iosModal) {
        iosModal.hidden = false;
      } else {
        alert("Чтобы установить приложение, откройте меню браузера (⋮) и выберите «Установить» или «Добавить на главный экран».");
      }
    }
  });

  // Close button on install banner
  if (btnClose) {
    btnClose.addEventListener("click", () => {
      hideBanner(true);
    });
  }

  // Close iOS guidance modal
  if (btnIosClose) {
    btnIosClose.addEventListener("click", () => {
      if (iosModal) iosModal.hidden = true;
    });
  }
  if (iosBackdrop) {
    iosBackdrop.addEventListener("click", () => {
      if (iosModal) iosModal.hidden = true;
    });
  }

  // Initial check: if mobile browser (iOS or Android), show banner
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
  if (isMobile && !isStandaloneMode() && !isSessionDismissed) {
    setTimeout(() => {
      if (!isStandaloneMode()) showBanner();
    }, 800);
  }
}
initPwaInstall();

/* ---------- Service worker ---------- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
