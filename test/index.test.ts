import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  context: {
    repo: { owner: "owner", repo: "repo" },
    eventName: "pull_request_target",
    payload: {
      action: "labeled",
      label: { name: "ready" },
      sender: { login: "labeler" },
      repository: { full_name: "owner/repo" },
      pull_request: {
        number: 1,
        title: "Test",
        html_url: "https://github.com/owner/repo/pull/1",
        user: { login: "author" },
      },
    },
  },
  api: {
    rest: {
      users: { getAuthenticated: vi.fn() },
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(),
        updateComment: vi.fn(),
        deleteComment: vi.fn(),
      },
    },
    paginate: vi.fn(),
  },
  secret: vi.fn(),
  failed: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  output: vi.fn(),
}));
vi.mock("@actions/core", () => ({
  getInput: (key: string) => mocks.inputs[key] || "",
  setSecret: mocks.secret,
  setFailed: mocks.failed,
  info: mocks.info,
  warning: mocks.warning,
  setOutput: mocks.output,
}));
vi.mock("@actions/github", () => ({
  context: mocks.context,
  getOctokit: () => mocks.api,
}));
import { run } from "../src/index.js";
const hook =
  "https://hooks.slack.com/services/TDEMO/BDEMO/EXAMPLE_NOT_A_SECRET";
beforeEach(() => {
  vi.clearAllMocks();
  mocks.inputs = {
    slack_webhook: hook,
    labels: "ready",
    dedup: "true",
    dry_run: "false",
    github_token: "fake-test-token",
  };
  mocks.context.eventName = "pull_request_target";
  mocks.context.payload.label.name = "ready";
  mocks.api.rest.users.getAuthenticated.mockResolvedValue({
    data: { login: "token-owner" },
  });
  mocks.api.paginate.mockResolvedValue([]);
  mocks.api.rest.issues.createComment.mockResolvedValue({ data: { id: 5 } });
  mocks.api.rest.issues.updateComment.mockResolvedValue({});
  mocks.api.rest.issues.deleteComment.mockResolvedValue({});
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "ok" }),
  );
});
describe("runner", () => {
  it("dry run makes no network calls or GitHub effects", async () => {
    mocks.inputs.dry_run = "true";
    await run();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.api.rest.users.getAuthenticated).not.toHaveBeenCalled();
    expect(mocks.api.paginate).not.toHaveBeenCalled();
    expect(mocks.api.rest.issues.createComment).not.toHaveBeenCalled();
    expect(mocks.output).toHaveBeenCalledWith("status", "dry-run");
  });
  it("posts then updates marker with fixed bot identity", async () => {
    mocks.api.rest.users.getAuthenticated.mockRejectedValue({ status: 403 });
    await run();
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.api.rest.issues.createComment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(" pending -->"),
      }),
    );
    expect(mocks.api.rest.issues.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining(" sent -->") }),
    );
  });
  it("skips unmatched label without token identity lookup", async () => {
    mocks.context.payload.label.name = "other";
    await run();
    expect(mocks.api.rest.users.getAuthenticated).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.output).toHaveBeenCalledWith("status", "skipped-label");
  });
  it("skips other event types without token identity lookup", async () => {
    mocks.context.eventName = "issues";
    await run();
    expect(mocks.api.rest.users.getAuthenticated).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("dedup false makes no GitHub calls", async () => {
    mocks.inputs.dedup = "false";
    await run();
    expect(mocks.api.rest.users.getAuthenticated).not.toHaveBeenCalled();
    expect(mocks.api.paginate).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("masks every webhook and token before use", async () => {
    mocks.inputs.webhook_map = JSON.stringify({ ready: hook });
    await run();
    expect(mocks.secret).toHaveBeenCalledWith(hook);
    expect(mocks.secret).toHaveBeenCalledWith(mocks.inputs.webhook_map);
    expect(mocks.secret).toHaveBeenCalledWith("fake-test-token");
  });
  it("suppresses network errors with credentials", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("secret " + hook));
    await run();
    expect(mocks.failed).toHaveBeenCalledWith(
      expect.stringContaining("outcome is unknown"),
    );
    expect(JSON.stringify(mocks.failed.mock.calls)).not.toContain(hook);
    expect(mocks.api.rest.issues.deleteComment).not.toHaveBeenCalled();
  });
  it("does not log raw GitHub errors", async () => {
    mocks.api.rest.issues.createComment.mockRejectedValue(
      new Error("secret fake-test-token"),
    );
    await run();
    expect(mocks.failed).toHaveBeenCalledWith(
      expect.stringContaining("details suppressed"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("cleans definite HTTP 400 rejection", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("invalid_payload", { status: 400 }),
    );
    await run();
    expect(mocks.api.rest.issues.deleteComment).toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledWith(
      expect.stringContaining("HTTP 400"),
    );
  });
  it("does not retry or clear uncertain HTTP 500 failure", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("error", { status: 500 }));
    await run();
    expect(fetch).toHaveBeenCalledOnce();
    expect(mocks.api.rest.issues.deleteComment).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalled();
  });
  it("rejects unavailable GitHub identity", async () => {
    mocks.api.rest.users.getAuthenticated.mockRejectedValue({ status: 401 });
    await run();
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledWith(
      "Unable to verify GitHub token identity.",
    );
  });
});

it("masks each fan-out URL and exposes counts", async () => {
  const second = hook.replace("BDEMO", "BOTHER");
  mocks.inputs.webhook_map = JSON.stringify({ ready: [hook, second] });
  await run();
  expect(mocks.secret).toHaveBeenCalledWith(second);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(mocks.output).toHaveBeenCalledWith("destinations", 2);
  expect(mocks.output).toHaveBeenCalledWith("posted", 2);
});
