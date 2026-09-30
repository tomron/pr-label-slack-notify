# PR label Slack notifier

A GitHub Action that sends a Slack message when a configured label is added to a pull request. Use one incoming webhook for a single channel, or a secret label-to-webhook map for multiple channels. One label can fan out to several channels by listing one webhook for each.

- Custom message templates with separate PR author and labeler fields.
- GitHub-to-Slack mention mapping for either person.
- Hidden-comment deduplication per PR, label and destination.
- Dry run with no Slack delivery or GitHub comment reads/writes.
- TypeScript source, bundled Node 24 action, MIT license.

## Quick start

Create a Slack incoming webhook and save its URL as the GitHub repository secret `SLACK_WEBHOOK`. Add this workflow to your **default branch**:

```yaml
name: Notify Slack on PR label
on:
  pull_request_target:
    types: [labeled]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: slack-label-${{ github.repository }}-${{ github.event.pull_request.number }}-${{ github.event.label.name }}
  cancel-in-progress: false
jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: tomron/pr-label-slack-notify@v1
        with:
          slack_webhook: ${{ secrets.SLACK_WEBHOOK }}
          labels: "release-ready,needs-review"
          dedup: "true"
          message_template: "{author_mention}'s PR <{url}|#{pr}: {title}> was labeled *{label}* by {labeler_mention}."
          mention_map: '{"octocat":"U0123456789"}'
```

`v1` will be available after the first release. For tighter supply-chain control, pin the action to a reviewed full commit SHA.

Use `pull_request_target` for fork PRs: it runs in the base repository where the webhook secret and comment permissions are available. This action **does not check out or execute PR code**. Do not add steps that check out or run untrusted PR code in this privileged workflow. The notification shares the PR title, label, GitHub handles, repository and URL with the configured Slack audience. Choose that audience deliberately, especially for private repositories.

`pull_request` is also supported when its token/secrets are available, usually for same-repository PRs. Fork PRs do not normally receive those secrets through `pull_request`. Dependabot events and repository/org restrictions can also limit secrets and permissions. The action fails rather than pretending it posted.

## Multiple channels

One label can notify several channels. Each channel still needs its own webhook; the action sends the same message to every unique URL in the list. Single-webhook map values remain supported.

Modern Slack incoming webhooks cannot override their channel. Create a webhook for each channel and put the entire map in a repository secret named `SLACK_WEBHOOK_MAP`:

```json
{
  "release-ready": [
    "<incoming webhook URL for release channel>",
    "<incoming webhook URL for engineering channel>"
  ],
  "needs-review": "<incoming webhook URL for review channel>"
}
```

Then use this step with the same event, permissions and concurrency as above:

```yaml
- uses: tomron/pr-label-slack-notify@v1
  with:
    labels: '["release-ready", "needs-review"]'
    webhook_map: ${{ secrets.SLACK_WEBHOOK_MAP }}
    # Optional fallback for labels not in the map:
    slack_webhook: ${{ secrets.SLACK_WEBHOOK }}
    dedup: "true"
    dry_run: "false"
```

A map entry wins over the default webhook; the fallback is not added to a list. Empty lists are invalid. Duplicate URLs within a list are sent only once. All selected URLs are validated before any delivery. A matching label without either route fails before sending. Exact labels are case-sensitive. Comma/newline lists and JSON arrays are supported; use JSON for a label containing a comma.

Webhook URLs are credentials. Never put them in workflow files, comments or public examples. Slack and GovSlack HTTPS incoming webhook hosts are supported; redirects and arbitrary destinations are rejected.

## Inputs

| Input              | Default               | Meaning                                                                                                            |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `slack_webhook`    | Empty                 | Default incoming webhook, supplied as a secret.                                                                    |
| `labels`           | Required              | Exact label names as JSON array or comma/newline list.                                                             |
| `webhook_map`      | Empty                 | Secret JSON object mapping labels to a webhook URL or a non-empty list of URLs.                                    |
| `dedup`            | `true`                | One notification per PR, label and webhook destination.                                                            |
| `github_token`     | `${{ github.token }}` | Comment token. Requires `pull-requests: write` with dedup. A personal token's user identity is verified when used. |
| `message_template` | Example above         | Slack text with the placeholders below.                                                                            |
| `mention_map`      | Empty                 | JSON map from exact GitHub usernames to Slack member IDs (`U...` or `W...`).                                       |
| `dry_run`          | `false`               | Render/log payload only. No Slack or GitHub comment API calls.                                                     |

Boolean values must be exactly `true` or `false`. Rendered messages must be 1-4000 characters. Use plain Slack member IDs, not `@displayname`; IDs avoid ambiguous names. Configure both people independently in `mention_map`.

### Template placeholders

| Placeholder                               | Value                                                              |
| ----------------------------------------- | ------------------------------------------------------------------ |
| `{label}`                                 | Added label name                                                   |
| `{pr}`                                    | PR number                                                          |
| `{title}`                                 | PR title                                                           |
| `{url}`                                   | PR HTTPS URL                                                       |
| `{repository}`                            | `owner/repo`                                                       |
| `{author}`, `{pr_author}`                 | PR author's GitHub username                                        |
| `{labeler}`                               | GitHub username of the person who added the label (`event.sender`) |
| `{author_mention}`, `{pr_author_mention}` | Mapped Slack mention for PR author; GitHub username if unmapped    |
| `{labeler_mention}`                       | Mapped Slack mention for labeler; GitHub username if unmapped      |

The template is trusted workflow configuration. Event fields are escaped for Slack's `&`, `<` and `>` controls, so a malicious title cannot inject a Slack mention or link. Replacements are single-pass. Unknown placeholders fail before posting.

## Deduplication and failure recovery

With `dedup: true`, a bot-owned hidden PR comment stores a fixed marker with a SHA-256 key for the repository, PR, label and webhook. Raw webhook URLs are never stored in comments. Markers from other contributors are ignored. Changing a webhook creates a new destination and therefore a new dedup key. Removing and re-adding the same label to the same destination does not post again.

Each destination has its own marker, so retrying a partially successful fan-out skips channels that already received the message. Adding a channel later does not resend to existing channels. Destinations are processed sequentially and independent destinations still run if one fails; any failure makes the action fail with a count summary (never raw URLs). Pending destinations require review. With `dedup: false`, rerunning a partial failure resends to all channels.

The marker is `pending` before delivery, then `sent` after Slack confirms `ok`. Hidden means the comment body is an HTML comment, not that it is private: GitHub still records the comment and may show activity. Deleting a marker can allow another notification.

**Keep the workflow concurrency group in the examples.** Comment check/create is not an atomic operation; without concurrency, simultaneous runs can double-post. The group is per PR **and label**, so different labels do not replace one another in GitHub's pending-run slot. GitHub may collapse repeated pending runs for the same label, which is consistent with dedup. If every addition must notify, set `dedup: false` and remove concurrency; no comment permission is then needed.

No automatic webhook retry is performed. A network timeout, lost response or server error can mean Slack already accepted the message. A pending marker remains and future runs return `pending-review` rather than risking duplicate delivery. Check Slack before deleting that marker and retrying. A definite HTTP 4xx rejection removes the pending marker so a corrected configuration can be retried. If marker creation fails, nothing is sent. If marker update fails after delivery, the pending marker still prevents a blind duplicate.

These are duplicate-reduction safeguards, not a promise of exactly-once delivery across GitHub and Slack. Repository writers can edit/delete comments and workflow configuration.

## Dry run and outputs

Set `dry_run: "true"` to log the rendered `{ "text": "..." }` payload without posting or reading/writing comments. Webhook routing and template validation still run. Dry-run logs contain PR information and configured mentions, but never webhook URLs. GitHub logs are visible to the repository's permitted audience.

- `status`: `posted`, `dry-run`, `deduplicated`, `pending-review`, `skipped-event`, or `skipped-label`.
- `label`: matched label, when applicable.
- `destinations`: number of unique selected webhook URLs (also available in dry run).
- `posted`, `deduplicated`, `pending`: per-destination counts on completed runs. A failed fan-out reports counts in its safe error message.

Only `labeled` PR events are handled. No `opened`, `unlabeled`, rich styles, configurable marker, bot-token channel override or automatic threading. Incoming webhooks support replies only with an already-known message timestamp, which they do not return; this webhook-only action intentionally does not offer automatic threading.

## Development and releases

```sh
npm ci --ignore-scripts
npm run check
npm audit
```

`npm run check` runs lint, formatting, tests, TypeScript validation and the bundled build. Commit `dist/` with source changes. CI checks that rebuilding produces no diff. Tests mock all external effects and do not send Slack messages. See [RELEASE.md](RELEASE.md) for versioning and Marketplace steps, and [SECURITY.md](SECURITY.md) for security notes.

## Sources

- [Slack incoming webhooks: setup, fixed channels, response and threading limits](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/)
- [GitHub workflow events and pull_request_target](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request_target)
- [GitHub workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)

## License

MIT. See [LICENSE](LICENSE). Bundled dependencies retain their own licenses in `dist/licenses.txt` and `dist/index.js.LEGAL.txt`.
