export const parseEnvFileContent = (
  content: string,
): Record<string, string> => {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    const isDoubleQuoted =
      value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"';
    const isSingleQuoted =
      value.length >= 2 && value[0] === "'" && value[value.length - 1] === "'";
    if (isDoubleQuoted || isSingleQuoted) {
      value = value.slice(1, -1);
    }
    if (isDoubleQuoted) {
      value = value.replace(/\\([nrt\\])/g, (_, ch: string) => {
        const escapes: Record<string, string> = {
          n: "\n",
          r: "\r",
          t: "\t",
          "\\": "\\",
        };
        return escapes[ch] ?? ch;
      });
    }
    vars[key] = value;
  }
  return vars;
};

export const serializeEnvFile = (
  vars: Record<string, string>,
  headerLines: readonly string[] = [],
): string => {
  const lines = [...headerLines];
  if (lines.length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }
  for (const key of Object.keys(vars).sort()) {
    lines.push(`${key}=${vars[key] ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
};

const isCredentialLikeKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    normalized.includes("apikey") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("credential")
  );
};

export const maskEnvValue = (key: string, value: string): string => {
  if (value.length === 0) {
    return "(empty)";
  }
  if (!isCredentialLikeKey(key)) {
    return value;
  }
  if (value.length <= 4) {
    return "****";
  }
  return `${value.slice(0, 4)}…${value.slice(-2)} (${value.length} chars)`;
};
