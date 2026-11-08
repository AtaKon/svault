/** Pure helpers for the AI review bot. Kept separate so they can be unit-tested. */

/** Split a unified diff at file boundaries. Oversized files are reported, not cut. */
export function splitDiff(diff, limit) {
  const chunks = [];
  const oversized = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current);
    current = "";
  };
  for (const section of diff.split(/(?=^diff --git )/m)) {
    if (!section.trim()) continue;
    if (section.length > limit) {
      flush();
      const firstLine = section.split("\n")[0].replace(/^diff --git a\/[^ ]+ b\//, "");
      oversized.push(firstLine || "unknown file");
      continue;
    }
    if (current && current.length + section.length > limit) flush();
    current += section;
  }
  flush();
  return { chunks, oversized };
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
    if (!blockingText && (nonBlockingText || testsText)) {
      partBlocking.push(
        `- Reviewer omitted the Blocking section; cannot confirm this part has no blockers.`,
      );
    }
    if (!partNonBlocking.length && nonBlockingText && !/^none\.?$/i.test(nonBlockingText)) {
      partNonBlocking.push(`- ${nonBlockingText.slice(0, 2_000)}`);
    }
    if (!partTests.length && testsText && !/^none\.?$/i.test(testsText)) {
      partTests.push(`- ${testsText.slice(0, 2_000)}`);
    }
    if (!blockingText && !nonBlockingText && !testsText) {
      partBlocking.push(
        `- Reviewer returned an unexpected format for this part; cannot verify it is clean: ${part.text.slice(0, 500)}`,
      );
    }
    if (partBlocking.length) blocking.push(...partBlocking.map((line) => `[part ${part.index}] ${line}`));
    if (partNonBlocking.length) nonBlocking.push(...partNonBlocking.map((line) => `[part ${part.index}] ${line}`));
    if (partTests.length) tests.push(...partTests.map((line) => `[part ${part.index}] ${line}`));
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

export function failureStopNote(index, limit) {
  return `- Review stopped after 3 consecutive part failures; parts ${index + 1}-${limit} were not reviewed.`;
}

/** Trim a comment without leaving an unclosed Markdown code fence. */
export function clipComment(text, limit) {
  if (text.length <= limit) return text;
  const marker = "\n\n[Review comment truncated]";
  const budget = Math.max(1, limit - marker.length - 8);
  let cut = text.lastIndexOf("\n", budget);
  if (cut < 0) {
    const space = text.lastIndexOf(" ", budget);
    cut = space >= 0 ? space : budget;
  }
  let out = text.slice(0, cut);
  const fences = (out.match(/^```/gm) || []).length;
  if (fences % 2) out += "\n```";
  return `${out}${marker}`;
}
