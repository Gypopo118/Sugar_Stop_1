const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // ~6MB base64 payload ceiling

const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    call: callDeepSeek
  },
  gemini: {
    label: "Gemini",
    call: callGemini
  },
  custom: {
    label: "Свой провайдер",
    call: callCustom
  }
};

export async function onRequestPost({ request }) {
  let body;
  try { body = await request.json(); } catch { return jsonError("Invalid JSON body", 400); }

  const { imageBase64, refineText, xeGrams, hand } = body;
  const providerId = PROVIDERS[body.provider] ? body.provider : "deepseek";
  const provider = PROVIDERS[providerId];

  if (!imageBase64 || !imageBase64.startsWith("data:image/")) {
    return jsonError("imageBase64 must be a data:image/... URL", 400);
  }
  if (imageBase64.length > MAX_IMAGE_BYTES) {
    return jsonError("Image is too large", 413);
  }

  // Strictly require client-supplied API key — no server fallback.
  // Санитизируем тут тоже: в localStorage мог остаться ключ со старым мусором (пробелы, Bearer, trailing slash).
  let apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  apiKey = apiKey.replace(/^bearer\s+/i, "").replace(/\s+/g, "").replace(/\/+$/, "");
  if (!apiKey || apiKey.length < 8) {
    return jsonError(`Не указан API-ключ для ${provider.label}. Пожалуйста, укажите ваш API-ключ в Настройках приложения.`, 401);
  }

  const xeSize = Number(xeGrams) || 12;
  const systemPrompt = buildSystemPrompt(xeSize, hand);

  let dishes;
  try {
    dishes = await provider.call({ apiKey, systemPrompt, imageBase64, refineText, xeSize, custom: body.custom });
  } catch (e) {
    return jsonError(e.message, e.status || 502);
  }

  return new Response(JSON.stringify({ dishes, provider: providerId }), {
    headers: { "Content-Type": "application/json" }
  });
}

/* ---------- DeepSeek ---------- */
async function callDeepSeek({ apiKey, systemPrompt, imageBase64, refineText, xeSize }) {
  // Текст первым, картинка второй — как в официальных примерах DeepSeek Vision.
  // detail:high важен для оценки размера порций по фото.
  const content = [
    { type: "text", text: buildInstruction(refineText) },
    { type: "image_url", image_url: { url: imageBase64, detail: "high" } }
  ];

  // Канонический endpoint без /v1; /v1 — лишь алиас и иногда глючит на vision-exp.
  // response_format убран намеренно: на experimental vision он часто даёт пустой content.
  // Вместо этого требуем JSON в промпте и чистим fences в safeParseJson.
  // finish_reason:length лечится большим max_tokens + отключенным thinking:
  // reasoning-токены иначе съедают бюджет и JSON обрезается.
  const res = await withTimeout((signal) => fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "deepseek-v4-flash-vision-exp",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content }
      ],
      temperature: 0.1,
      max_tokens: 8000,
      stream: false,
      thinking: { type: "disabled" }
    }),
    signal
  }), "DeepSeek");

  if (!res.ok) throw await providerError("DeepSeek", res);
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  // content может прийти строкой или массивом партoв — нормализуем оба варианта.
  const raw = typeof msg?.content === "string"
    ? msg.content
    : Array.isArray(msg?.content)
      ? msg.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
      : "";
  const finishReason = data?.choices?.[0]?.finish_reason || "";
  if (!raw || !raw.trim()) {
    if (finishReason === "length") {
      throw fail(`DeepSeek обрезал ответ (finish_reason: length): не хватило max_tokens. Попробуйте ещё раз — лимит уже увеличен до 8000, обычно хватает. Если повторится — упростите фото (меньше блюд в кадре) или добавьте текстовое уточнение.`, 502);
    }
    const reason = finishReason ? ` (finish_reason: ${finishReason})` : "";
    const refusal = msg?.refusal ? `: ${String(msg.refusal).slice(0, 200)}` : "";
    throw fail(`DeepSeek returned an empty response${reason}${refusal}`);
  }
  // Ответ есть, но обрезан по лимиту — JSON будет битый, лучше честно попросить повторить.
  if (finishReason === "length") {
    throw fail(`DeepSeek вернул обрезанный ответ (finish_reason: length). Попробуйте ещё раз или упростите кадр.`, 502);
  }
  return normalizeDishes(safeParseJson(raw, "DeepSeek"), xeSize);
}

/* ---------- Custom (OpenAI-совместимый, данные полностью от пользователя) ---------- */
async function callCustom({ apiKey, systemPrompt, imageBase64, refineText, xeSize, custom }) {
  const cfg = {
    name: typeof custom?.name === "string" ? custom.name.slice(0, 40) : "",
    baseUrl: typeof custom?.baseUrl === "string" ? custom.baseUrl.trim().replace(/\s+/g, "") : "",
    model: typeof custom?.model === "string" ? custom.model.trim().replace(/\s+/g, "") : ""
  };
  const label = cfg.name || "Свой провайдер";
  if (!cfg.model || cfg.model.length > 200) throw fail(`${label}: не указан Model ID (1–200 символов). Заполните его в Настройках.`);
  const urlErr = validateCustomUrl(cfg.baseUrl);
  if (urlErr) throw fail(`${label}: ${urlErr}`);

  const content = [
    { type: "text", text: buildInstruction(refineText) },
    { type: "image_url", image_url: { url: imageBase64 } }
  ];
  // Чужим API шлём только стандартные поля: model/messages/temperature/max_tokens.
  // Никаких thinking/response_format — это вендор-специфика DeepSeek.
  const res = await withTimeout((signal) => fetch(cfg.baseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content }
      ],
      temperature: 0.1,
      max_tokens: 4000,
      stream: false
    }),
    signal
  }), label);

  if (!res.ok) {
    if (res.status === 401) throw fail(`${label}: неверный API-ключ (401). Проверьте ключ в Настройках.`, 401);
    if (res.status === 402) throw fail(`${label}: недостаточно баланса/квоты (402).`, 402);
    if (res.status === 404) throw fail(`${label}: endpoint или model не найдены (404). Проверьте URL и Model ID — URL должен вести до .../chat/completions.`, 404);
    const text = await res.text().catch(() => "");
    throw fail(`${label} error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  const raw = typeof msg?.content === "string"
    ? msg.content
    : Array.isArray(msg?.content)
      ? msg.content.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
      : "";
  const finishReason = data?.choices?.[0]?.finish_reason || "";
  if (!raw || !raw.trim()) {
    if (finishReason === "length") throw fail(`${label} обрезал ответ (length): уменьшите кадр или добавьте текстовое уточнение.`, 502);
    throw fail(`${label} вернул пустой ответ${finishReason ? ` (finish_reason: ${finishReason})` : ""}. Возможно, модель не vision — выберите vision-модель провайдера.`, 502);
  }
  if (finishReason === "length") throw fail(`${label} вернул обрезанный ответ (length). Попробуйте ещё раз или упростите кадр.`, 502);
  return normalizeDishes(safeParseJson(raw, label), xeSize);
}

function validateCustomUrl(raw) {
  if (!raw) return "не указан Endpoint. Вставьте полный https-URL до .../chat/completions.";
  if (/\s/.test(raw)) return "в Endpoint есть пробелы — вставьте URL без пробелов.";
  let u;
  try { u = new URL(raw); } catch { return "Endpoint не похож на URL. Пример: https://openrouter.ai/api/v1/chat/completions."; }
  if (u.protocol !== "https:") return "Endpoint должен начинаться с https:// (http запрещён).";
  if (u.username || u.password) return "Endpoint не должен содержать логин/пароль в URL.";
  const host = u.hostname.toLowerCase();
  // SSRF-защита: блокируем локальные и внутренние адреса — ключ ушёл бы не туда.
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost запрещён.";
  if (/^(127\.|0\.0\.0\.0|::1|\[::1\])/.test(host)) return "локальные адреса запрещены.";
  if (/^(10\.|192\.168\.|169\.254\.)/.test(host)) return "внутренние адреса запрещены.";
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "внутренние адреса запрещены.";
  if (/metadata\.google|metadata\.azure|instance-data|rancher|kubernetes\.default/i.test(host)) return "cloud metadata-хосты запрещены.";
  if (raw.length > 300) return "Endpoint слишком длинный (макс. 300 символов).";
  return null;
}

/* ---------- Gemini ---------- */
async function callGemini({ apiKey, systemPrompt, imageBase64, refineText, xeSize }) {
  const match = imageBase64.match(/^data:(image\/[a-zA-Z]+);base64,(.+)$/);
  if (!match) throw fail("Malformed image data URL");
  const [, mimeType, base64Data] = match;

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent";

  const res = await withTimeout((signal) => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{
        role: "user",
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: buildInstruction(refineText) }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    }),
    signal
  }), "Gemini");

  if (!res.ok) throw await providerError("Gemini", res);
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw) throw fail("Gemini returned an empty response");
  return normalizeDishes(safeParseJson(raw, "Gemini"), xeSize);
}

/* ---------- shared helpers ---------- */
async function withTimeout(fn, providerLabel, ms = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } catch (e) {
    if (e.name === "AbortError") throw fail(`${providerLabel} did not respond in time`);
    throw fail(e.message);
  } finally {
    clearTimeout(timer);
  }
}

async function providerError(label, res) {
  const text = await res.text().catch(() => "");
  if (res.status === 401) {
    return fail(`${label}: неверный API-ключ (401). Откройте Настройки → удалите ключ → зайдите на platform.deepseek.com/api_keys → создайте новый ключ (начинается с sk-) → вставьте без пробелов и без слова Bearer.`, 401);
  }
  if (res.status === 402) {
    return fail(`${label}: недостаточно баланса (402). Ключ верный, но деньги закончились — пополните на platform.deepseek.com.`, 402);
  }
  if (res.status === 404) {
    return fail(`${label} error 404: неверный endpoint или model. Проверьте URL и имя модели.`, 404);
  }
  return fail(`${label} error ${res.status}: ${text.slice(0, 300)}`);
}

function fail(message, status = 502) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function safeParseJson(raw, label) {
  // experimental vision часто оборачивает JSON в ```json fences — чистим.
  const cleaned = String(raw || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try { return JSON.parse(cleaned); }
  catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fallthrough */ }
    }
    throw fail(`Could not parse ${label}'s JSON output`);
  }
}

function buildSystemPrompt(xeSize, hand) {
  const handLines = [];
  if (hand?.palmWidthCm) handLines.push(`ширина ладони: ${hand.palmWidthCm} см`);
  if (hand?.palmLengthCm) handLines.push(`длина ладони (от запястья до кончиков пальцев): ${hand.palmLengthCm} см`);
  if (hand?.fistThicknessCm) handLines.push(`толщина кулака/горсти: ${hand.fistThicknessCm} см`);
  const handBlock = handLines.length
    ? `На фото рядом с тарелкой может быть рука пользователя — используй её как масштабную линейку. Параметры руки пользователя: ${handLines.join(", ")}.`
    : `На фото рядом с тарелкой может быть рука — если она есть, используй её как приблизительную масштабную линейку (средняя ширина ладони взрослого человека ~8-9 см).`;

  return `Ты — ассистент по фитнес-питанию, который оценивает состав тарелки по фотографии.
Пользователь стремится к фитнес-диете: достаточный белок, контроль калорий, снижение гликемического индекса (ГИ) и гликемической нагрузки (ГН), стабильная энергия без скачков сахара.
Твоя задача — определить блюда на фото и их вес, а затем посчитать пищевую ценность.
${handBlock}
Один ХЕ (хлебная единица) = ${xeSize} г усвояемых углеводов.
Если рука не видна или её не за что зацепить — оценивай размер порции по посуде (стандартная тарелка ~24-26 см) и типичным порциям, и снижай уверенность оценки, но всё равно верни числа.
Приоритет фитнес-цели: точнее выделяй белковые продукты, гарниры и жиры отдельно; ГИ указывай уверенно для узнаваемых продуктов, иначе null; явно разделяй тарелку на компоненты, а не одной строкой.
Отвечай ТОЛЬКО валидным JSON без пояснений, без markdown, без fences, в формате:
{"dishes":[{"name":"строка","weightG":число,"carbsG":число,"xe":число,"gi":число или null,"kcal":число,"proteinG":число,"fatG":число}]}
Округляй разумно.`;
}

function buildInstruction(refineText) {
  const base = refineText && refineText.trim()
    ? `Пользователь уточнил состав и вес текстом — это ПРИОРИТЕТНЕЕ того, что видно на фото, используй именно эти данные там, где они заданы, и фото только для того, чего в уточнении нет: "${refineText.trim()}"`
    : "Пользователь не оставил текстового уточнения — определи блюда и вес по фото и руке-эталону.";
  // Дублируем требование JSON в user-блоке: vision-exp лучше слушается user, чем system.
  return `${base} Верни ТОЛЬКО JSON без markdown и без пояснений.`;
}

function normalizeDishes(parsed, xeSize) {
  // Модель иногда возвращает массив напрямую вместо {dishes:[...]} — принимаем оба.
  const dishes = Array.isArray(parsed) ? parsed : parsed?.dishes;
  if (!Array.isArray(dishes)) return [];
  return dishes.slice(0, 12).map((d) => {
    const carbsG = numOr(d.carbsG, 0);
    return {
      name: typeof d.name === "string" && d.name.trim() ? d.name.trim() : "Блюдо",
      weightG: numOr(d.weightG, 0),
      carbsG,
      xe: d.xe != null ? numOr(d.xe, carbsG / xeSize) : carbsG / xeSize,
      gi: d.gi != null ? numOr(d.gi, null) : null,
      kcal: numOr(d.kcal, 0),
      proteinG: numOr(d.proteinG, 0),
      fatG: numOr(d.fatG, 0)
    };
  });
}

function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
