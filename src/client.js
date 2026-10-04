/** Talks to the configured LifeLens API. The page still does every calculation. */
const env = import.meta.env || {};
const apiBase = String(
  env.VITE_API_URL || (env.VITE_BACKEND === "modal" ? env.VITE_API_modal : env.VITE_API_local) || "",
).replace(/\/$/, "");

function apiPath(path) {
  return `${apiBase}${path}`;
}

export async function listBackends() {
  const response = await fetch(apiPath("/api/backends"));
  if (!response.ok) {
    const err = new Error("backends");
    err.code = "upstream_error";
    throw err;
  }
  return response.json();
}

export function installModel() {
  if (window.claude && window.claude.__lifelens) return;

  const complete = async (body) => {
    const response = await fetch(apiPath("/api/complete"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = new Error("model");
      err.code = "upstream_error";
      try { err.detail = (await response.json()).detail; } catch { /* ignore */ }
      throw err;
    }
    return response.json();
  };

  const toMessages = (input) => {
    if (typeof input === "string") return [{ role: "user", content: input }];
    if (!Array.isArray(input)) return [{ role: "user", content: String(input ?? "") }];
    return input.map((turn, index) => ({
      role: index === 0 && input.length > 1 ? "system" : (turn.role || "user"),
      content: typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content ?? ""),
    }));
  };

  window.claude = {
    __lifelens: true,
    async use(kind) {
      if (kind === "downloads") return null;
      const sample = async (input) => {
        const data = await complete({ messages: toMessages(input) });
        return { text: data.text || "" };
      };
      sample.json = async (input) => {
        const data = await complete({ messages: toMessages(input), json: true });
        if (!data.json || typeof data.json !== "object") {
          const err = new Error("invalid json");
          err.code = "invalid_json";
          err.text = data.text || "";
          throw err;
        }
        return data.json;
      };
      sample.limits = async () => ({});
      return sample;
    },
  };
}
