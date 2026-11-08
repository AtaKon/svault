/** Pure helpers for the AI review bot. Kept separate so they can be unit-tested. */

function safeCut(text, limit) {
  if (text.length <= limit) return text.length;
  const newline = text.lastIndexOf("\n", limit);
  let end = newline > 1000 ? newline : Math.min(limit, text.length);
  // Never split a surrogate pair.
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return end;
}

/** Split a unified diff at file boundaries, then by lines for huge files. */
export function splitDiff(diff, limit) {
  const chunks = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current);
    current = "";
  };
  for (const section of diff.split(/(?=^diff --git )/m)) {
    if (!section.trim()) continue;
    if (section.length > limit) {
      flush();
      const lines = section.split("\n");
      const hunk = lines.findIndex((line) => line.startsWith("@@"));
      const header = `${(hunk > 0 ? lines.slice(0, hunk) : [lines[0]]).join("\n")}\n`;
      const reserve = header.length + 48;
      let rest = section;
      let first = true;
      while (rest.length > limit) {
        const end = safeCut(rest, Math.max(limit - reserve, 1_000));
        const piece = rest.slice(0, end).replace(/\n+$/, "");
        chunks.push(`${first ? "" : header}${piece}\n\n[Diff part continues in the next chunk]\n`);
        rest = rest.slice(end).replace(/^\n+/, "");
        first = false;
      }
      if (rest.trim()) chunks.push(`${first ? "" : header}${rest}`);
      continue;
    }
    if (current && current.length + section.length > limit) flush();
    current += section;
  }
  flush();
  return chunks;
}

export function section(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`### ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n### |$)`).exec(text);
  return match ? match[1].trim() : "";
}

export function bullets(value) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+/.test(line));
}

export function mergeChunkReviews(parts) {
  const blocking = [];
  const nonBlocking = [];
  const tests = [];
  for (const part of parts) {
    const blockingText = section(part.text, "Blocking");
    const nonBlockingText = section(part.text, "Non-blocking");
    const testsText = section(part.text, "Tests");
    const partBlocking = bullets(blockingText).filter(
      (line) => !/^[-*]\s*(no blocking issues found|none)\.?$/i.test(line),
    );
    const partNonBlocking = bullets(nonBlockingText).filter(
      (line) => !/^[-*]\s*(none|no non-blocking issues)\.?$/i.test(line),
    );
    const partTests = bullets(testsText).filter((line) => !/^[-*]\s*none\.?$/i.test(line));
    if (!partBlocking.length && blockingText && !/^no blocking issues found\.?$/i.test(blockingText)) {
      partBlocking.push(`- ${blockingText.slice(0, 2_000)}`);
    }
    if (!partNonBlocking.length && nonBlockingText && !/^none\.?$/i.test(nonBlockingText)) {
      partNonBlocking.push(`- ${nonBlockingText.slice(0, 2_000)}`);
    }
    if (!partTests.length && testsText && !/^none\.?$/i.test(testsText)) {
      partTests.push(`- ${testsText.slice(0, 2_000)}`);
    }
    if (partBlocking.length) blocking.push(...partBlocking.map((line) => `[part ${part.index}] ${line}`));
    if (partNonBlocking.length) nonBlocking.push(...partNonBlocking.map((line) => `[part ${part.index}] ${line}`));
    if (partTests.length) tests.push(...partTests.map((line) => `[part ${part.index}] ${line}`));
    if (!blockingText && !nonBlockingText && !testsText) {
      nonBlocking.push(`[part ${part.index}] Reviewer returned an unexpected format; raw note: ${part.text.slice(0, 500)}`);
    }
  }
  const dedupe = (lines) => [...new Set(lines)];
  const blockingLines = dedupe(blocking);
  const nonBlockingLines = dedupe(nonBlocking);
  const testLines = dedupe(tests);
  return `### Verdict
${blockingLines.length ? "Needs changes" : "Ready for review"}

### Blocking
${blockingLines.length ? blockingLines.join("\n") : "No blocking issues found."}

### Non-blocking
${nonBlockingLines.length ? nonBlockingLines.join("\n") : "None."}

### Tests
${testLines.length ? testLines.join("\n") : "None."}`;
}

/** Trim a comment without leaving an unclosed Markdown code fence. */
export function clipComment(text, limit) {
  if (text.length <= limit) return text;
  let cut = text.lastIndexOf("\n", Math.max(0, limit - 80));
  if (cut < 1000) {
    const space = text.lastIndexOf(" ", Math.max(0, limit - 80));
    cut = space > 1000 ? space : Math.max(0, limit - 80);
  }
  let out = text.slice(0, cut);
  const fences = (out.match(/^```/gm) || []).length;
  if (fences % 2) out += "\n```";
  return `${out}\n\n[Review comment truncated before ${limit} characters]`;
}
