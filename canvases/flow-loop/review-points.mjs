import { createHash } from "node:crypto";

const REVIEW_MARKER = /^<!-- FL-REVIEW ([A-Za-z0-9_-]+) -->$/gm;
const POINT_MARKER = /^<!-- FL-POINT ([A-Za-z0-9_-]+) -->$/gm;

export function reviewPoints(review) {
  const points = [];
  for (const risk of review.risks || []) {
    points.push({
      id: `p${points.length + 1}`, kind: "risk", severity: risk.severity,
      clauseId: risk.clauseId || null, evidence: risk.evidence, recommendation: risk.recommendation,
    });
  }
  for (const omission of review.omissions || []) {
    points.push({
      id: `p${points.length + 1}`, kind: "omission", clauseId: null,
      evidence: omission, recommendation: `Address this omission: ${omission}`,
    });
  }
  for (const suggestion of review.suggestedChanges || []) {
    points.push({
      id: `p${points.length + 1}`, kind: "suggestion", clauseId: suggestion.clauseId || null,
      evidence: suggestion.change, recommendation: suggestion.change,
    });
  }
  return points;
}

export function encodeReview(review, points) {
  const json = JSON.stringify({ review, points });
  const digest = createHash("sha256").update(json).digest("hex");
  const lines = points.map((point) =>
    `- **${point.id} · ${point.kind}${point.severity ? ` · ${point.severity}` : ""}${point.clauseId ? ` · ${point.clauseId}` : ""}** ${point.evidence}\n  - Recommendation: ${point.recommendation}`);
  const body = [
    `Verdict: **${review.verdict}**.`,
    ...lines,
    ...(lines.length ? [] : ["No changes recommended."]),
    "",
    `<!-- FL-REVIEW ${Buffer.from(json).toString("base64url")} -->`,
  ].join("\n");
  if (body.length > 60000) throw new Error("review exceeds GitHub comment size; retry with shorter findings");
  return { body, digest };
}

export function decodeReview(body, digest) {
  const match = [...String(body || "").matchAll(REVIEW_MARKER)].at(-1);
  if (!match) throw new Error("independent review payload is missing");
  const json = Buffer.from(match[1], "base64url").toString("utf8");
  if (createHash("sha256").update(json).digest("hex") !== digest) {
    throw new Error("independent review payload changed");
  }
  const data = JSON.parse(json);
  if (!Array.isArray(data.points) || !data.review || data.points.some((p, i) => p.id !== `p${i + 1}`)) {
    throw new Error("independent review payload is invalid");
  }
  return data;
}

export function encodePointReply(reply) {
  return `${reply.reply}\n\n<!-- FL-POINT ${Buffer.from(JSON.stringify(reply)).toString("base64url")} -->`;
}

export function decodePointReply(body) {
  const match = [...String(body || "").matchAll(POINT_MARKER)].at(-1);
  if (!match) throw new Error("review point reply payload is missing");
  const data = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  if (typeof data.reply !== "string" || typeof data.recommendation !== "string") {
    throw new Error("review point reply payload is invalid");
  }
  return data;
}
