import { describe, it, expect, vi } from "vitest";
import {
  notify,
  DEFAULT_TEMPLATE,
  escapeSlack,
  marker,
  parseBoolean,
  parseLabels,
  render,
  stringMap,
  validateWebhook,
  RejectedPost,
  type Config,
  type LabelEvent,
  type Ports,
  type Comment,
} from "../src/notify.js";

const hook =
  "https://hooks.slack.com/services/TDEMO/BDEMO/EXAMPLE_NOT_A_SECRET";
const hook2 =
  "https://hooks.slack.com/services/TDEMO/BOTHER/EXAMPLE_NOT_A_SECRET";
const event: LabelEvent = {
  action: "labeled",
  label: { name: "ready" },
  sender: { login: "label-person" },
  repository: { full_name: "owner/repo" },
  pull_request: {
    number: 42,
    title: "Safe change",
    html_url: "https://github.com/owner/repo/pull/42",
    user: { login: "pr-person" },
  },
};
const config: Config = {
  labels: ["ready", "review"],
  slackWebhook: hook,
  webhookMap: {},
  mentionMap: {},
  template: DEFAULT_TEMPLATE,
  dedup: true,
  dryRun: false,
};
function setup() {
  const stored: Comment[] = [];
  const ports: Ports = {
    trustedAuthors: ["github-actions[bot]"],
    comments: vi.fn(async () => stored),
    createComment: vi.fn(async (body) => {
      stored.push({
        id: stored.length + 1,
        body,
        author: "github-actions[bot]",
      });
      return stored.length;
    }),
    updateComment: vi.fn(async (id, body) => {
      stored.find((c) => c.id === id)!.body = body;
    }),
    deleteComment: vi.fn(async (id) => {
      stored.splice(
        stored.findIndex((c) => c.id === id),
        1,
      );
    }),
    post: vi.fn(async () => {}),
  };
  return { stored, ports };
}
describe("config", () => {
  it.each([
    ["a,b", ["a", "b"]],
    ["a\nb\na", ["a", "b"]],
    ['["a,b","c"]', ["a,b", "c"]],
  ])("parses labels %s", (input, result) =>
    expect(parseLabels(input as string)).toEqual(result),
  );
  it.each(["", "[]", "[true]", '[""]', '["a"'])("rejects labels %s", (value) =>
    expect(() => parseLabels(value)).toThrow(),
  );
  it.each(["TRUE", "yes", "", "0"])("rejects boolean %s", (value) =>
    expect(() => parseBoolean(value, "dedup")).toThrow(),
  );
  it("parses booleans strictly", () => {
    expect(parseBoolean("true", "x")).toBe(true);
    expect(parseBoolean("false", "x")).toBe(false);
  });
  it("parses maps", () => {
    expect(stringMap("", "x")).toEqual({});
    expect(stringMap('{"a":"b"}', "x")).toEqual({ a: "b" });
  });
  it.each(["null", "[]", '{"a":1}', "bad"])("rejects map %s", (value) =>
    expect(() => stringMap(value, "x")).toThrow(),
  );
  it("accepts Slack and GovSlack webhooks", () => {
    validateWebhook(hook);
    validateWebhook(hook.replace("hooks.slack.com", "hooks.slack-gov.com"));
  });
  it.each([
    "http://hooks.slack.com/services/a/b/c",
    "https://evil.example/services/a/b/c",
    "https://hooks.slack.com.evil.example/services/a/b/c",
    "https://user:pass@hooks.slack.com/services/a/b/c",
    "https://hooks.slack.com/services/a/b/c?x=1",
    "https://hooks.slack.com/services/a/b/c#x",
    "https://hooks.slack.com:444/services/a/b/c",
    "https://hooks.slack.com/api",
    "bad",
  ])("rejects webhook %s", (value) =>
    expect(() => validateWebhook(value)).toThrow(),
  );
  it("escapes untrusted Slack special characters", () =>
    expect(escapeSlack("<!channel> & <@U123>")).toBe(
      "&lt;!channel&gt; &amp; &lt;@U123&gt;",
    ));
  it("replaces once without reinterpreting injected placeholders", () =>
    expect(
      render("{title} {author}", { title: "{author}", author: "real" }),
    ).toBe("{author} real"));
  it("rejects unknown placeholders", () =>
    expect(() => render("{typo}", {})).toThrow());
});
describe("notifications", () => {
  it("renders PR author and labeler separately", async () => {
    const { ports, stored } = setup();
    expect(
      (await notify("pull_request_target", event, config, ports)).status,
    ).toBe("posted");
    expect(ports.post).toHaveBeenCalledWith(hook, {
      text: "pr-person's PR <https://github.com/owner/repo/pull/42|#42: Safe change> was labeled *ready* by label-person.",
    });
    expect(stored[0]!.body).toMatch(
      /^<!-- pr-label-slack-notify:v1 [a-f0-9]{64} sent -->$/,
    );
  });
  it("uses map routing over default webhook", async () => {
    const { ports } = setup();
    await notify(
      "pull_request",
      event,
      { ...config, webhookMap: { ready: hook2 } },
      ports,
    );
    expect(ports.post).toHaveBeenCalledWith(hook2, expect.anything());
  });
  it("supports map-only config", async () => {
    const { ports } = setup();
    expect(
      (
        await notify(
          "pull_request",
          event,
          { ...config, slackWebhook: "", webhookMap: { ready: hook2 } },
          ports,
        )
      ).status,
    ).toBe("posted");
  });
  it("fails missing routing before comment creation", async () => {
    const { ports } = setup();
    await expect(
      notify("pull_request", event, { ...config, slackWebhook: "" }, ports),
    ).rejects.toThrow();
    expect(ports.createComment).not.toHaveBeenCalled();
  });
  it("deduplicates repeated same label and destination", async () => {
    const { ports } = setup();
    await notify("pull_request", event, config, ports);
    expect((await notify("pull_request", event, config, ports)).status).toBe(
      "deduplicated",
    );
    expect(ports.post).toHaveBeenCalledTimes(1);
  });
  it("notifies independently for another label", async () => {
    const { ports } = setup();
    await notify("pull_request", event, config, ports);
    await notify(
      "pull_request",
      { ...event, label: { name: "review" } },
      config,
      ports,
    );
    expect(ports.post).toHaveBeenCalledTimes(2);
  });
  it("notifies independently for another destination", async () => {
    const { ports } = setup();
    await notify("pull_request", event, config, ports);
    await notify(
      "pull_request",
      event,
      { ...config, slackWebhook: hook2 },
      ports,
    );
    expect(ports.post).toHaveBeenCalledTimes(2);
  });
  it("ignores forged contributor markers", async () => {
    const { ports, stored } = setup();
    await notify("pull_request", event, config, ports);
    stored[0]!.author = "outsider";
    await notify("pull_request", event, config, ports);
    expect(ports.post).toHaveBeenCalledTimes(2);
  });
  it("does not match marker embedded inside prose", async () => {
    const { ports, stored } = setup();
    await notify("pull_request", event, config, ports);
    stored[0]!.body += "\nnot a marker";
    await notify("pull_request", event, config, ports);
    expect(ports.post).toHaveBeenCalledTimes(2);
  });
  it("dedup false never reads or writes comments", async () => {
    const { ports } = setup();
    await notify("pull_request", event, { ...config, dedup: false }, ports);
    expect(ports.comments).not.toHaveBeenCalled();
    expect(ports.createComment).not.toHaveBeenCalled();
    expect(ports.post).toHaveBeenCalledOnce();
  });
  it("dry run renders without any effects", async () => {
    const { ports } = setup();
    const r = await notify(
      "pull_request",
      event,
      { ...config, dryRun: true },
      ports,
    );
    expect(r.status).toBe("dry-run");
    expect(r.payload?.text).toContain("label-person");
    for (const fn of [
      ports.comments,
      ports.createComment,
      ports.updateComment,
      ports.deleteComment,
      ports.post,
    ])
      expect(fn).not.toHaveBeenCalled();
  });
  it("supports separate mention IDs", async () => {
    const { ports } = setup();
    await notify(
      "pull_request",
      event,
      {
        ...config,
        mentionMap: { "pr-person": "UABC", "label-person": "WDEF" },
      },
      ports,
    );
    expect(ports.post).toHaveBeenCalledWith(hook, {
      text: expect.stringContaining("<@UABC>"),
    });
    expect(ports.post).toHaveBeenCalledWith(hook, {
      text: expect.stringContaining("<@WDEF>"),
    });
  });
  it("supports all documented placeholders", async () => {
    const { ports } = setup();
    const r = await notify(
      "pull_request",
      event,
      {
        ...config,
        dryRun: true,
        template:
          "{pr_author} {author} {labeler} {repository} {pr_author_mention} {labeler_mention} {label} {pr} {title} {url}",
      },
      ports,
    );
    expect(r.payload?.text).toContain(
      "pr-person pr-person label-person owner/repo",
    );
  });
  it("rejects handle-style mentions before any effect", async () => {
    const { ports } = setup();
    await expect(
      notify(
        "pull_request",
        event,
        { ...config, mentionMap: { "pr-person": "@somebody" } },
        ports,
      ),
    ).rejects.toThrow();
    expect(ports.comments).not.toHaveBeenCalled();
  });
  it("escapes PR title mention injection", async () => {
    const { ports } = setup();
    await notify(
      "pull_request",
      {
        ...event,
        pull_request: {
          ...event.pull_request!,
          title: "<!channel> <@U123> {author}",
        },
      },
      config,
      ports,
    );
    expect(ports.post).toHaveBeenCalledWith(hook, {
      text: expect.stringContaining("&lt;!channel&gt; &lt;@U123&gt; {author}"),
    });
  });
  it.each(["unlabeled", "opened", "synchronize"])(
    "skips action %s",
    async (action) => {
      const { ports } = setup();
      expect(
        (await notify("pull_request", { ...event, action }, config, ports))
          .status,
      ).toBe("skipped-event");
      expect(ports.post).not.toHaveBeenCalled();
    },
  );
  it("skips other event types", async () => {
    const { ports } = setup();
    expect((await notify("issues", event, config, ports)).status).toBe(
      "skipped-event",
    );
  });
  it("skips unmatched labels case-sensitively", async () => {
    const { ports } = setup();
    expect(
      (
        await notify(
          "pull_request",
          { ...event, label: { name: "Ready" } },
          config,
          ports,
        )
      ).status,
    ).toBe("skipped-label");
    expect(ports.comments).not.toHaveBeenCalled();
  });
  it("retains pending state on uncertain network outcome", async () => {
    const { ports, stored } = setup();
    vi.mocked(ports.post).mockRejectedValueOnce(new Error("network"));
    await expect(notify("pull_request", event, config, ports)).rejects.toThrow(
      "network",
    );
    expect(stored[0]!.body).toContain(" pending -->");
    expect((await notify("pull_request", event, config, ports)).status).toBe(
      "pending-review",
    );
    expect(ports.post).toHaveBeenCalledOnce();
  });
  it("removes pending state on definite rejection", async () => {
    const { ports, stored } = setup();
    vi.mocked(ports.post).mockRejectedValueOnce(new RejectedPost("rejected"));
    await expect(
      notify("pull_request", event, config, ports),
    ).rejects.toThrow();
    expect(stored).toHaveLength(0);
    await notify("pull_request", event, config, ports);
    expect(ports.post).toHaveBeenCalledTimes(2);
  });
  it("retains pending state when marker update fails after delivery", async () => {
    const { ports, stored } = setup();
    vi.mocked(ports.updateComment).mockRejectedValueOnce(new Error("github"));
    await expect(notify("pull_request", event, config, ports)).rejects.toThrow(
      "Slack accepted",
    );
    expect(stored[0]!.body).toContain(" pending -->");
    expect((await notify("pull_request", event, config, ports)).status).toBe(
      "pending-review",
    );
  });
  it("never posts when creating the marker fails", async () => {
    const { ports } = setup();
    vi.mocked(ports.createComment).mockRejectedValueOnce(new Error("github"));
    await expect(
      notify("pull_request", event, config, ports),
    ).rejects.toThrow();
    expect(ports.post).not.toHaveBeenCalled();
  });
  it("rejects overly long messages before effects", async () => {
    const { ports } = setup();
    await expect(
      notify(
        "pull_request",
        event,
        { ...config, template: "x".repeat(4001) },
        ports,
      ),
    ).rejects.toThrow();
    expect(ports.comments).not.toHaveBeenCalled();
  });
  it("marker has a fixed format", () =>
    expect(marker("abc", "sent")).toBe(
      "<!-- pr-label-slack-notify:v1 abc sent -->",
    ));
});
