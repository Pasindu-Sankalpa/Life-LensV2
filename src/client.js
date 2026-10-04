/** Talks to the local Qwen server. The page still does every calculation. */
export function installModel() {
  if (window.claude && window.claude.__lifelens) return;

  const complete = async (body) => {
    const response = await fetch("/api/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = new Error("model");
      err.code = "upstream_error";
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
