const AGENT_EMAILS = new Set([
  "noreply@anthropic.com",
  "claude@anthropic.com",
  "noreply@openai.com",
  "codex@openai.com",
  "cursoragent@cursor.com",
  "copilot@github.com",
  "noreply@github.com",
]);

const GENERATED_BY_AGENT =
  /^(?:🤖\s*)?generated (?:with|by)\s+(?:claude(?: code)?|codex|cursor|github copilot|copilot|opencode|grok|antigravity)[.!]?$/i;

function parseCoAuthor(text: string): { name: string; email: string } | undefined {
  const prefix = /^co-authored-by:/i.exec(text)?.[0];
  if (prefix === undefined || !text.endsWith(">")) return undefined;
  const emailStart = text.lastIndexOf("<");
  if (emailStart < prefix.length) return undefined;
  const name = text.slice(prefix.length, emailStart).trim();
  const email = text.slice(emailStart + 1, -1);
  if (/[\r\n\u2028\u2029]/.test(name) || email.length === 0 || email.includes(">")) {
    return undefined;
  }
  return { name, email: email.toLowerCase() };
}

export function removeAgentCredits(message: string): string {
  let fence: string | undefined;
  let removed = false;
  const newline = message.includes("\r\n") ? "\r\n" : "\n";
  const lines = message.split(/\r?\n/).filter((line) => {
    if (/^(?: {4}|\t)/.test(line)) return true;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = delimiter?.[1];
    const remainder = delimiter?.[2] ?? "";
    if (marker !== undefined) {
      if (fence === undefined) {
        if (marker[0] === "~" || !remainder.includes("`")) fence = marker;
      } else if (
        marker[0] === fence[0] &&
        marker.length >= fence.length &&
        /^[ \t]*$/.test(remainder)
      ) {
        fence = undefined;
      }
      return true;
    }
    if (fence !== undefined) return true;
    const text = line.trim().replace(/^(?:[-*]\s+)/, "");
    const author = parseCoAuthor(text);
    // GitHub's generic noreply address is also used by people; require Copilot's name.
    const email = author?.email;
    const agentAuthor =
      email !== undefined &&
      AGENT_EMAILS.has(email) &&
      (email !== "noreply@github.com" || /^github copilot$|^copilot$/i.test(author!.name));
    const footer = text.replace(
      /\[([^\]]+)\]\(https:\/\/(?:claude\.ai|claude\.com|www\.anthropic\.com|chatgpt\.com|openai\.com|cursor\.com|github\.com|opencode\.ai|x\.ai|antigravity\.google)(?:\/[^\s)]*)?\)/gi,
      "$1",
    );
    if (!agentAuthor && !GENERATED_BY_AGENT.test(footer)) return true;
    removed = true;
    return false;
  });
  return removed ? lines.join(newline).replace(/(?:\r?\n[ \t]*)+$/, "") : message;
}
