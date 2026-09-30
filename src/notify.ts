import { createHash } from "node:crypto";

export const DEFAULT_TEMPLATE =
  "{author_mention}'s PR <{url}|#{pr}: {title}> was labeled *{label}* by {labeler_mention}.";
export interface Config {
  labels: string[];
  slackWebhook: string;
  webhookMap: Record<string, string | string[]>;
  mentionMap: Record<string, string>;
  template: string;
  dedup: boolean;
  dryRun: boolean;
}
export interface LabelEvent {
  action?: string;
  label?: { name: string };
  sender?: { login: string };
  repository?: { full_name: string };
  pull_request?: {
    number: number;
    title: string;
    html_url: string;
    user: { login: string };
  };
}
export interface Comment {
  id: number;
  body: string;
  author: string;
}
export interface Ports {
  trustedAuthors: string[];
  comments(): Promise<Comment[]>;
  createComment(body: string): Promise<number>;
  updateComment(id: number, body: string): Promise<void>;
  deleteComment(id: number): Promise<void>;
  post(webhook: string, payload: { text: string }): Promise<void>;
}
export class RejectedPost extends Error {}
export function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}
export function stringMap(value: string, name: string): Record<string, string> {
  if (!value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON object.`);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((v) => typeof v !== "string")
  ) {
    throw new Error(`${name} must map strings to strings.`);
  }
  return parsed as Record<string, string>;
}
export function parseWebhookMap(
  value: string,
): Record<string, string | string[]> {
  if (!value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("webhook_map must be a JSON object.");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.values(parsed).some(
      (v) =>
        typeof v !== "string" &&
        (!Array.isArray(v) ||
          !v.length ||
          v.some((x) => typeof x !== "string" || !x.trim())),
    )
  ) {
    throw new Error(
      "webhook_map values must be a webhook string or a non-empty list of webhook strings.",
    );
  }
  return parsed as Record<string, string | string[]>;
}
export function parseLabels(value: string): string[] {
  const text = value.trim();
  if (!text) throw new Error("labels must contain at least one label.");
  let labels: unknown;
  if (text.startsWith("[")) {
    try {
      labels = JSON.parse(text);
    } catch {
      throw new Error("labels JSON is invalid.");
    }
  } else
    labels = text
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  if (
    !Array.isArray(labels) ||
    !labels.length ||
    labels.some((s) => typeof s !== "string" || !s.trim())
  ) {
    throw new Error("labels must be a list of non-empty strings.");
  }
  return [...new Set(labels as string[])];
}
export function validateWebhook(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid Slack incoming webhook URL.");
  }
  if (
    url.protocol !== "https:" ||
    !["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/services\/[^/]+\/[^/]+\/[^/]+$/.test(url.pathname)
  ) {
    throw new Error(
      "Use an HTTPS Slack incoming webhook URL on hooks.slack.com or hooks.slack-gov.com.",
    );
  }
}
export function escapeSlack(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
export function render(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([a-z_]+)\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key))
      throw new Error(`Unknown message placeholder: {${key}}.`);
    return values[key]!;
  });
}
function mention(login: string, map: Record<string, string>): string {
  const id = Object.hasOwn(map, login) ? map[login]! : undefined;
  if (!id) return escapeSlack(login);
  if (!/^[UW][A-Z0-9]+$/.test(id))
    throw new Error(
      "mention_map values must be Slack member IDs (U... or W...), not display names.",
    );
  return `<@${id}>`;
}
export function marker(key: string, state: "pending" | "sent"): string {
  return `<!-- pr-label-slack-notify:v1 ${key} ${state} -->`;
}
export async function notify(
  eventName: string,
  event: LabelEvent,
  config: Config,
  ports: Ports,
) {
  if (
    !["pull_request", "pull_request_target"].includes(eventName) ||
    event.action !== "labeled" ||
    !event.pull_request
  ) {
    return { status: "skipped-event" };
  }
  const label = event.label?.name;
  if (!label || !config.labels.includes(label))
    return { status: "skipped-label" };
  const pr = event.pull_request;
  const repository = event.repository?.full_name;
  const labeler = event.sender?.login;
  if (
    !repository ||
    !labeler ||
    !pr.user?.login ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1
  ) {
    throw new Error("Incomplete pull request event.");
  }
  const prURL = new URL(pr.html_url);
  if (prURL.protocol !== "https:" || prURL.username || prURL.password)
    throw new Error("PR URL must be HTTPS.");
  const route = Object.hasOwn(config.webhookMap, label)
    ? config.webhookMap[label]!
    : config.slackWebhook;
  const webhooks = [...new Set(Array.isArray(route) ? route : [route])];
  if (!webhooks.length || webhooks.some((w) => !w))
    throw new Error("No webhook configured for this label.");
  // Validate all destinations before any side effect, including the first post.
  for (const webhook of webhooks) validateWebhook(webhook);
  const text = render(config.template || DEFAULT_TEMPLATE, {
    label: escapeSlack(label),
    pr: String(pr.number),
    title: escapeSlack(pr.title),
    author: escapeSlack(pr.user.login),
    pr_author: escapeSlack(pr.user.login),
    labeler: escapeSlack(labeler),
    url: escapeSlack(pr.html_url),
    repository: escapeSlack(repository),
    author_mention: mention(pr.user.login, config.mentionMap),
    pr_author_mention: mention(pr.user.login, config.mentionMap),
    labeler_mention: mention(labeler, config.mentionMap),
  });
  if (!text.trim() || text.length > 4000)
    throw new Error("Rendered Slack message must contain 1-4000 characters.");
  const payload = { text };
  if (config.dryRun)
    return { status: "dry-run", label, payload, destinations: webhooks.length };
  const comments = config.dedup ? await ports.comments() : [];
  let posted = 0,
    deduplicated = 0,
    pending = 0;
  const failures: unknown[] = [];
  for (const webhook of webhooks) {
    try {
      const status = await sendOne(
        repository,
        pr.number,
        label,
        webhook,
        payload,
        config.dedup,
        comments,
        ports,
      );
      if (status === "posted") posted++;
      else if (status === "deduplicated") deduplicated++;
      else pending++;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    if (webhooks.length === 1) throw failures[0];
    throw new Error(
      `Slack fan-out incomplete: ${posted} posted, ${deduplicated} already sent, ${pending} pending review, ${failures.length} failed. Check destination channels and pending markers before retrying. Successful destinations will be skipped on retry with dedup enabled.`,
    );
  }
  return {
    status: pending ? "pending-review" : posted ? "posted" : "deduplicated",
    label,
    destinations: webhooks.length,
    posted,
    deduplicated,
    pending,
  };
}
async function sendOne(
  repository: string,
  prNumber: number,
  label: string,
  webhook: string,
  payload: { text: string },
  dedup: boolean,
  comments: Comment[],
  ports: Ports,
) {
  const key = createHash("sha256")
    .update(JSON.stringify([repository, prNumber, label, webhook]))
    .digest("hex");
  let commentId: number | undefined;
  if (dedup) {
    const prior = comments.find(
      (c) =>
        ports.trustedAuthors.includes(c.author) &&
        [marker(key, "pending"), marker(key, "sent")].includes(c.body),
    );
    if (prior)
      return prior.body === marker(key, "sent")
        ? "deduplicated"
        : "pending-review";
    commentId = await ports.createComment(marker(key, "pending"));
  }
  try {
    await ports.post(webhook, payload);
  } catch (error) {
    if (commentId !== undefined && error instanceof RejectedPost) {
      try {
        await ports.deleteComment(commentId);
      } catch {
        throw new Error(
          "Slack rejected the message; marker cleanup failed. Review the PR marker before retrying.",
        );
      }
    }
    throw error;
  }
  if (commentId !== undefined) {
    try {
      await ports.updateComment(commentId, marker(key, "sent"));
    } catch {
      throw new Error(
        "Slack accepted the message, but the marker update failed. Pending marker retained to prevent a duplicate.",
      );
    }
  }
  return "posted";
}
