import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  notify,
  parseBoolean,
  parseLabels,
  stringMap,
  parseWebhookMap,
  RejectedPost,
  UserError,
  type LabelEvent,
} from "./notify.js";

export async function run(): Promise<void> {
  try {
    const slackWebhook = core.getInput("slack_webhook");
    const rawMap = core.getInput("webhook_map");
    // Mask even invalid secret JSON before attempting validation.
    if (slackWebhook) core.setSecret(slackWebhook);
    if (rawMap) core.setSecret(rawMap);
    const webhookMap = parseWebhookMap(rawMap);
    for (const route of Object.values(webhookMap))
      for (const url of Array.isArray(route) ? route : [route])
        if (url) core.setSecret(url);
    const dryRun = parseBoolean(core.getInput("dry_run"), "dry_run");
    const dedup = parseBoolean(core.getInput("dedup"), "dedup");
    const labels = parseLabels(core.getInput("labels", { required: true }));
    const token = core.getInput("github_token");
    if (token) core.setSecret(token);
    const octokit = github.getOctokit(token || "dry-run-no-token");
    const { owner, repo } = github.context.repo;
    const event = github.context.payload as LabelEvent;
    // Only the workflow bot, or the verified owner of a supplied personal token, can own markers.
    const trustedAuthors = async () => {
      if (!token)
        throw new UserError("github_token is required when dedup is enabled.");
      const trusted = ["github-actions[bot]"];
      try {
        const user = await octokit.rest.users.getAuthenticated();
        trusted.push(user.data.login);
      } catch (error) {
        const status = (error as { status?: number }).status;
        // Installation GITHUB_TOKEN cannot call /user. Its bot identity is fixed.
        if (status !== 403)
          throw new UserError("Unable to verify GitHub token identity.", {
            cause: error,
          });
      }
      return trusted;
    };
    const result = await notify(
      github.context.eventName,
      event,
      {
        labels,
        slackWebhook,
        webhookMap,
        mentionMap: stringMap(core.getInput("mention_map"), "mention_map"),
        template: core.getInput("message_template"),
        dedup,
        dryRun,
      },
      {
        trustedAuthors,
        comments: async () =>
          (
            await octokit.paginate(octokit.rest.issues.listComments, {
              owner,
              repo,
              issue_number: event.pull_request!.number,
              per_page: 100,
            })
          ).map((c) => ({
            id: c.id,
            body: c.body || "",
            author: c.user?.login || "",
          })),
        createComment: async (body) =>
          (
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: event.pull_request!.number,
              body,
            })
          ).data.id,
        updateComment: async (comment_id, body) => {
          await octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id,
            body,
          });
        },
        deleteComment: async (comment_id) => {
          await octokit.rest.issues.deleteComment({ owner, repo, comment_id });
        },
        post: async (url, payload) => {
          let response: Response;
          try {
            response = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
              signal: AbortSignal.timeout(15000),
              redirect: "error",
            });
          } catch {
            throw new UserError(
              `Slack delivery outcome is unknown (network/timeout).${dedup ? " Pending marker retained;" : ""} Check Slack before retrying.`,
            );
          }
          let body: string;
          try {
            body = (await response.text()).trim();
          } catch {
            throw new UserError(
              "Slack response was lost. Check Slack before retrying.",
            );
          }
          if (response.status >= 400 && response.status < 500)
            throw new RejectedPost(
              `Slack rejected the message (HTTP ${response.status}). No automatic retry.`,
            );
          if (!response.ok || body !== "ok")
            throw new UserError(
              "Unexpected Slack response. Delivery may be uncertain; check Slack before retrying.",
            );
        },
      },
    );
    core.setOutput("status", result.status);
    core.setOutput("label", result.label || "");
    core.setOutput("destinations", result.destinations || 0);
    core.setOutput("posted", result.posted || 0);
    core.setOutput("deduplicated", result.deduplicated || 0);
    core.setOutput("pending", result.pending || 0);
    core.info(`Notification status: ${result.status}`);
    if (result.status === "pending-review")
      core.warning(
        "An earlier run left a pending marker. Check Slack before removing that marker and retrying.",
      );
    if (result.status === "dry-run")
      core.info(
        `Dry-run destinations: ${result.destinations}; payload: ${JSON.stringify(result.payload)}`,
      );
  } catch (error) {
    // Never surface raw SDK/network errors: those may contain authorization headers or webhook URLs.
    core.setFailed(
      error instanceof UserError
        ? error.message
        : "Notification failed. Check GitHub permissions and configuration; details suppressed to protect secrets.",
    );
  }
}
if (process.env.NODE_ENV !== "test") void run();
