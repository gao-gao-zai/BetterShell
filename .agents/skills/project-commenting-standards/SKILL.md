---
name: project-commenting-standards
description: Project-level commenting standards for the DSH QQ Bot TypeScript plugin, covering Cordis lifecycle, QQ Gateway protocol, concurrency, security, public APIs, and tests.
category: project
risk: low
source: local
date_added: '2026-08-18'
---

# Project Commenting Standards

Use this Skill whenever you create, modify, review, or refactor code in this project.

## Core Principle

Comments must preserve intent that cannot be recovered easily from the code itself. Explain why a decision exists, which invariant must hold, or which external protocol rule is being followed. Do not narrate obvious syntax.

Prefer clear names, small functions, explicit types, and tested behavior over explanatory comments. A comment that only restates the next line is noise and should be removed.

## Required Comment Cases

Add a concise comment when code contains any of the following:

- A non-obvious business or routing rule.
- A QQ Gateway opcode, event, intent, heartbeat, resume, or reconnect requirement.
- A rate-limit, retry, backoff, deduplication, or idempotency invariant.
- A security boundary, allowlist decision, credential-handling rule, or redaction requirement.
- A Cordis lifecycle dependency that must be cleaned up with the current Fiber.
- A concurrency decision, ordering guarantee, queueing rule, or cancellation invariant.
- A compatibility workaround for DSH, QQ, Node.js, TypeScript, or a third-party library.
- A deliberate deviation from an existing project convention.
- A public exported API whose contract is not obvious from its name and types.
- A data transformation where dropping or normalizing fields is intentional.

For protocol-specific behavior, include the protocol concept and, when useful, a stable official documentation URL. Do not invent event names, opcodes, limits, or URLs.

## Forbidden or Unhelpful Comments

Do not add comments that:

- Restate a variable assignment, conditional, loop, or function name.
- Describe what a well-named function already says.
- Explain TypeScript syntax or basic JavaScript syntax.
- Act as a changelog. Use Git history or the project documentation for history.
- Contain stale speculation such as “temporary” without an owner or removal condition.
- Hide a bug with vague wording such as “fix issue” or “important code”.
- Include secrets, access tokens, personal data, complete QQ message payloads, or sensitive identifiers.
- Become a large block of design documentation inside a small function.

## Comment Style

- Write in concise Chinese for project-specific rationale unless the surrounding file clearly uses English.
- Keep ordinary comments to one or two lines.
- Put the comment immediately above the code it explains.
- Use complete, direct sentences where a sentence is needed.
- Use ASCII punctuation in code comments unless the file already consistently uses another style.
- Do not use decorative banners or comment separators for ordinary code.
- Keep comments stable under formatting and refactoring.
- Update or delete comments when the implementation changes.

## TypeScript and Public APIs

Use TSDoc/JSDoc only for exported APIs, protocol models, configuration fields, or behavior that types alone cannot express. Document:

- The purpose and ownership of the value.
- Important preconditions and postconditions.
- Cancellation, retry, ordering, or error behavior.
- Whether a value is safe to persist or log.

Do not write JSDoc that repeats the function name, parameter type, or return type without adding contract information.

Example:

```ts
/**
 * Sends one final reply after the Agent run settles; streaming partial output is
 * intentionally excluded so QQ retries cannot produce interleaved messages.
 */
async function sendFinalReply(reply: AgentReply): Promise<void> {
  // implementation
}
```

## Cordis Comments

Comment the reason for lifecycle-sensitive registrations, not the registration syntax itself. In particular, explain when a block:

- Uses `ctx.effect`, `ctx.on`, a timer, a WebSocket listener, or a Service registration.
- Must be disposed on stop, update, rollback, or undefine.
- Uses `ctx.get` because a dependency is optional, or `inject` because it is required.
- Owns a Host connection that must not be moved into an Agent Preset.
- Sends only owned JSON across a Host/Client or Package-private RPC boundary.

Example:

```ts
// The disposer belongs to the Fiber so reconnect timers cannot survive an update.
ctx.effect(() => connection.close(), 'QQ Gateway connection');
```

Do not comment every `ctx.get`, `ctx.on`, or `ctx.effect` call when the ownership and cleanup are already obvious from the local code.

## QQ Gateway Comments

Protocol code must make non-obvious state transitions reviewable. Add comments around:

- Identify payload construction and intent selection.
- Heartbeat scheduling and server-provided intervals.
- Sequence-number updates and resume eligibility.
- Reconnect classification: resumable, invalid-session, authentication, or terminal.
- Event deduplication and message ordering.
- Text splitting and API request batching.
- Rate-limit backoff and retry boundaries.

A protocol comment should identify the invariant, for example:

```ts
// Store the latest sequence before dispatching the event so a reconnect can resume
// from the server-confirmed position even if message handling fails afterward.
sequence = event.s;
```

Do not copy full QQ event payloads into comments or fixtures unless the test specifically needs them; use the smallest representative object.

## Security Comments

Explain security decisions where a future maintainer might otherwise weaken them:

- Why the default route is deny-by-default.
- Why a credential is read through a particular provider.
- Why a field is redacted before logging.
- Why raw QQ input remains inside the existing DSH workspace, permission, approval, and sandbox boundaries.
- Why a webhook signature or access token is validated before dispatch.

Never place real credentials or user content in comments, examples, tests, or TODOs.

## TODO and FIXME Rules

Use `TODO` only when the work is intentionally deferred and actionable. Include a reason and a condition for removal:

```ts
// TODO: Add attachment forwarding after the QQ media permission is enabled and tested.
```

Do not add `TODO`, `FIXME`, or `HACK` for an unresolved bug without describing the failure and the next action. Prefer a tracked issue when the project has an issue tracker.

## Test Comments

Tests should communicate the behavior under protection, not narrate the test steps. Comment only when the fixture or assertion encodes a non-obvious protocol or lifecycle rule:

```ts
// A duplicate event must not create a second Agent request.
expect(agentRequestCount).toBe(1);
```

Keep test fixtures small. Use test names for normal behavior descriptions and comments for invariants, compatibility notes, or intentionally unusual setup.

## Review Checklist

Before finishing a change:

1. Remove comments that merely restate code.
2. Add rationale for protocol, lifecycle, concurrency, security, and compatibility decisions.
3. Check that comments match the current implementation and limits.
4. Ensure no secrets, raw user content, or speculative claims appear.
5. Verify public API documentation describes behavior and failure semantics.
6. Ensure deferred work has a concrete removal condition.
7. Prefer a focused comment near the invariant over a long file-level explanation.
