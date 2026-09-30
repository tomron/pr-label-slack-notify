# Security

Keep incoming webhook URLs in GitHub secrets, including all values in `webhook_map`. Do not post them in issues or PRs. GitHub secret masking is defense in depth, not permission to log credentials.

The action only sends to HTTPS Slack/GovSlack incoming-webhook endpoints, rejects redirects and never executes PR content. Template values are single-pass and Slack-control escaped. Comment dedup accepts exact bot-owned markers (or markers owned by the verified user of a supplied personal token).

Run `pull_request_target` without checking out or executing the fork's code. Keep workflow inputs in trusted base-repository configuration. Grant only the permissions needed. Pin this action to a reviewed commit for sensitive repositories.

Dedup needs workflow concurrency. Pending markers intentionally stop uncertain deliveries from being blindly retried. Review Slack before removing them. Never treat comments as immutable or exactly-once delivery as guaranteed.

To report a vulnerability, use GitHub's private vulnerability reporting if enabled. Do not include credentials in a public issue. Revoke any accidentally exposed Slack webhook immediately in Slack's app settings.
